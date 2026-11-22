import { describe, expect, setSystemTime, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Settings } from "../src/settings.ts";
import { DashboardAuth, TooManyAttempts } from "../src/auth/dashboard.ts";
import { Clients, clientSessionMs, pairingLinkMs } from "../src/auth/clients.ts";

const request = (cookie: string) => new Request("http://x/", { headers: { cookie } });

describe("dashboard key", () => {
  test("logs in with the key and rejects others", async () => {
    const db = openDatabase(":memory:");
    const auth = new DashboardAuth(db, new Settings(db));
    await auth.setKey("correct horse");
    expect(await auth.login("wrong key!", "1.1.1.1", false)).toBeNull();
    const cookie = await auth.login("correct horse", "1.1.1.1", false);
    expect(cookie).toContain("HttpOnly");
    expect(auth.authenticated(request(cookie!.split(";")[0]!))).toBe(true);
    expect(auth.authenticated(request("vmbridge_session=forged"))).toBe(false);
  });

  test("throttles repeated failures per address", async () => {
    const db = openDatabase(":memory:");
    const auth = new DashboardAuth(db, new Settings(db));
    await auth.setKey("correct horse");
    for (let i = 0; i < 5; i++) await auth.login("nope nope", "2.2.2.2", false);
    expect(auth.login("correct horse", "2.2.2.2", false)).rejects.toBeInstanceOf(TooManyAttempts);
    expect(await auth.login("correct horse", "3.3.3.3", false)).not.toBeNull();
  });

  test("changing the key ends existing sessions", async () => {
    const db = openDatabase(":memory:");
    const auth = new DashboardAuth(db, new Settings(db));
    await auth.setKey("first key!");
    const cookie = (await auth.login("first key!", "a", false))!.split(";")[0]!;
    await auth.setKey("second key");
    expect(auth.authenticated(request(cookie))).toBe(false);
  });

  test("changing the key needs the current key", async () => {
    const db = openDatabase(":memory:");
    const auth = new DashboardAuth(db, new Settings(db));
    await auth.setKey("first key!");
    expect(await auth.changeKey("guessing!", "second key", "a")).toBe(false);
    expect(await auth.login("first key!", "b", false)).not.toBeNull();
    expect(await auth.changeKey("first key!", "second key", "a")).toBe(true);
    expect(await auth.login("second key", "b", false)).not.toBeNull();
  });

  test("guessing the current key is throttled like logging in", async () => {
    const db = openDatabase(":memory:");
    const auth = new DashboardAuth(db, new Settings(db));
    await auth.setKey("first key!");
    for (let i = 0; i < 5; i++) await auth.changeKey("guessing!", "second key", "a");
    expect(auth.changeKey("first key!", "second key", "a")).rejects.toBeInstanceOf(TooManyAttempts);
  });

  test("watchers hear when their session ends by logout, a new key, or expiry", async () => {
    const db = openDatabase(":memory:");
    const auth = new DashboardAuth(db, new Settings(db));
    await auth.setKey("first key!");
    const first = request((await auth.login("first key!", "a", false))!.split(";")[0]!);
    const second = request((await auth.login("first key!", "a", false))!.split(";")[0]!);
    const ended: string[] = [];
    auth.watch(first, () => ended.push("first"));
    auth.watch(second, () => ended.push("second"));
    auth.logout(first);
    expect(ended).toEqual(["first"]);
    await auth.setKey("second key");
    expect(ended).toEqual(["first", "second"]);

    const third = request((await auth.login("second key", "a", false))!.split(";")[0]!);
    auth.watch(third, () => ended.push("third"));
    setSystemTime(new Date(Date.now() + 31 * 86_400_000));
    try {
      // Another browser logging out checks every watched session, the same as the periodic check.
      auth.logout(request(""));
      expect(ended).toEqual(["first", "second", "third"]);
    } finally {
      setSystemTime();
    }
  });

  test("a stopped watch is not called", async () => {
    const db = openDatabase(":memory:");
    const auth = new DashboardAuth(db, new Settings(db));
    await auth.setKey("first key!");
    const session = request((await auth.login("first key!", "a", false))!.split(";")[0]!);
    let called = false;
    const stop = auth.watch(session, () => (called = true));
    stop();
    auth.logout(session);
    expect(called).toBe(false);
  });
});

describe("first password setup", () => {
  const fresh = () => {
    const db = openDatabase(":memory:");
    const auth = new DashboardAuth(db, new Settings(db));
    return { db, auth, code: auth.createSetupCode()! };
  };

  test("sets the password and logs in only with the setup code", async () => {
    const { auth, code } = fresh();
    expect(await auth.claim("", "correct horse", "a", false)).toBeNull();
    expect(await auth.claim(`${code}x`, "correct horse", "a", false)).toBeNull();
    expect(auth.hasKey()).toBe(false);
    const cookie = await auth.claim(code, "correct horse", "a", false);
    expect(auth.authenticated(request(cookie!.split(";")[0]!))).toBe(true);
    expect(await auth.login("correct horse", "b", false)).not.toBeNull();
  });

  test("the code works once, even for two requests at the same time", async () => {
    const { auth, code } = fresh();
    const [first, second] = await Promise.all([auth.claim(code, "correct horse", "a", false), auth.claim(code, "another one", "b", false)]);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await auth.claim(code, "another one", "c", false)).toBeNull();
    expect(await auth.login("correct horse", "c", false)).not.toBeNull();
  });

  test("the code stops working once a password exists, such as one set from the terminal", async () => {
    const { db, auth, code } = fresh();
    // `vmbridge password` runs in another process, against the same database.
    await new DashboardAuth(db, new Settings(db)).setKey("from the terminal");
    expect(await auth.claim(code, "correct horse", "a", false)).toBeNull();
    expect(await auth.login("from the terminal", "a", false)).not.toBeNull();
    expect(auth.createSetupCode()).toBeNull();
  });

  test("a short password leaves the code usable", async () => {
    const { auth, code } = fresh();
    expect(auth.claim(code, "short", "a", false)).rejects.toThrow("at least 8");
    expect(await auth.claim(code, "correct horse", "a", false)).not.toBeNull();
  });

  test("wrong codes are throttled per address like logging in", async () => {
    const { auth, code } = fresh();
    for (let i = 0; i < 5; i++) await auth.claim("guess", "correct horse", "a", false);
    expect(auth.claim(code, "correct horse", "a", false)).rejects.toBeInstanceOf(TooManyAttempts);
    expect(auth.hasKey()).toBe(false);
    expect(await auth.claim(code, "correct horse", "b", false)).not.toBeNull();
  });
});

describe("onboarding", () => {
  test("existing installs with a password and a provider count as onboarded", async () => {
    const db = openDatabase(":memory:");
    db.query("INSERT INTO settings (key, value) VALUES ('dashboardKeyHash', ?), ('providers', ?)").run(JSON.stringify(await Bun.password.hash("old key!")), JSON.stringify(["boxd"]));
    expect(new Settings(db).get("onboarded")).toBe(true);
  });

  test("a new install, or one with only a password, is not, and adding a provider later does not change that", () => {
    const db = openDatabase(":memory:");
    expect(new Settings(db).get("onboarded")).toBe(false);
    const withKey = openDatabase(":memory:");
    withKey.query("INSERT INTO settings (key, value) VALUES ('dashboardKeyHash', '\"hash\"')").run();
    const settings = new Settings(withKey);
    expect(settings.get("onboarded")).toBe(false);
    settings.set("providers", ["boxd"]);
    expect(new Settings(withKey).get("onboarded")).toBe(false);
  });
});

describe("T3 pairing", () => {
  test("a pairing link works once and names the device", () => {
    const clients = new Clients(openDatabase(":memory:"));
    const { token } = clients.createLink("Vaibhav's iPhone");
    const access = clients.exchange(token);
    expect(access).toBeString();
    expect(clients.exchange(token)).toBeNull();
    expect(clients.authenticate(access!)?.name).toBe("Vaibhav's iPhone");
  });

  test("expired links cannot be redeemed", () => {
    const clients = new Clients(openDatabase(":memory:"));
    const { token } = clients.createLink("Laptop");
    setSystemTime(new Date(Date.now() + pairingLinkMs + 1));
    try {
      expect(clients.exchange(token)).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test("WebSocket tickets are single use and die with the session", () => {
    const clients = new Clients(openDatabase(":memory:"));
    const access = clients.exchange(clients.createLink("Desk").token)!;
    const client = clients.authenticate(access)!;
    const { ticket } = clients.ticket(client.id);
    expect(clients.redeemTicket(ticket)).toBe(client.id);
    expect(clients.redeemTicket(ticket)).toBeNull();
    const second = clients.ticket(client.id).ticket;
    clients.revoke(client.id);
    expect(clients.redeemTicket(second)).toBeNull();
    expect(clients.authenticate(access)).toBeNull();
  });

  test("a device in use stays paired past 30 days, an unused one expires", () => {
    const clients = new Clients(openDatabase(":memory:"));
    const daily = clients.exchange(clients.createLink("Phone").token)!;
    const unused = clients.exchange(clients.createLink("Old laptop").token)!;
    const start = Date.now();
    try {
      for (let day = 1; day <= 45; day++) {
        setSystemTime(new Date(start + day * 86_400_000));
        expect(clients.authenticate(daily)).not.toBeNull();
      }
      expect(clients.authenticate(unused)).toBeNull();
      expect(clients.authenticate(daily)!.expiresAt).toBe(start + 45 * 86_400_000 + clientSessionMs);
    } finally {
      setSystemTime();
    }
  });

  test("requests within a minute of each other do not move the expiry", () => {
    const clients = new Clients(openDatabase(":memory:"));
    const access = clients.exchange(clients.createLink("Phone").token)!;
    const start = Date.now();
    try {
      setSystemTime(new Date(start + 1_000));
      const first = clients.authenticate(access)!.expiresAt;
      setSystemTime(new Date(start + 30_000));
      expect(clients.authenticate(access)!.expiresAt).toBe(first);
      setSystemTime(new Date(start + 62_000));
      expect(clients.authenticate(access)!.expiresAt).toBe(start + 62_000 + clientSessionMs);
    } finally {
      setSystemTime();
    }
  });
});
