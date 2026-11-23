import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import { bunPasswords } from "../src/bun/password.ts";
import { passwordHashSecret, Secrets, Settings } from "../src/settings.ts";
import { DashboardAuth, TooManyAttempts } from "../src/auth/dashboard.ts";
import { webPasswords, type Passwords } from "../src/auth/password.ts";
import { Clients, clientSessionMs, pairingLinkMs } from "../src/auth/clients.ts";
import { testEncryption } from "./key.ts";

const request = (cookie: string) => new Request("http://x/", { headers: { cookie } });

// PBKDF2 unless a test is about argon2id, which is slow on purpose.
function dashboard(db = openDatabase(":memory:"), passwords: Passwords = webPasswords) {
  const secrets = new Secrets(db, testEncryption);
  return { db, secrets, auth: new DashboardAuth(db, secrets, passwords) };
}

describe("dashboard key", () => {
  test("logs in with the key and rejects others", async () => {
    const { auth } = dashboard();
    await auth.setKey("correct horse");
    expect(await auth.login("wrong key!", "1.1.1.1", false)).toBeNull();
    const cookie = await auth.login("correct horse", "1.1.1.1", false);
    expect(cookie).toContain("HttpOnly");
    expect(auth.authenticated(request(cookie!.split(";")[0]!))).toBe(true);
    expect(auth.authenticated(request("vmbridge_session=forged"))).toBe(false);
  });

  test("over HTTPS the session cookie is host-only and Secure, and sessions from before still work", async () => {
    const { auth } = dashboard();
    await auth.setKey("correct horse");
    const secure = (await auth.login("correct horse", "a", true))!;
    expect(secure).toStartWith("__Host-vmbridge_session=");
    expect(secure).toContain("Secure");
    expect(secure).toContain("Path=/;");
    expect(secure).not.toContain("Domain");
    const plain = (await auth.login("correct horse", "a", false))!;
    expect(plain).toStartWith("vmbridge_session=");
    expect(plain).not.toContain("Secure");
    const both = request(`${secure.split(";")[0]}; ${plain.split(";")[0]}`);
    expect(auth.authenticated(request(secure.split(";")[0]!))).toBe(true);
    // A cookie issued under the plain name over HTTPS before the change.
    expect(auth.authenticated(request(plain.split(";")[0]!))).toBe(true);
    // Logging out ends every session the request carries and clears both names.
    const cleared = auth.logout(both);
    expect(cleared.map((cookie) => cookie.split("=")[0])).toEqual(["vmbridge_session", "__Host-vmbridge_session"]);
    expect(cleared.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
    expect(auth.authenticated(request(secure.split(";")[0]!))).toBe(false);
    expect(auth.authenticated(request(plain.split(";")[0]!))).toBe(false);
  });

  test("throttles repeated failures per address", async () => {
    const { auth } = dashboard();
    await auth.setKey("correct horse");
    for (let i = 0; i < 5; i++) await auth.login("nope nope", "2.2.2.2", false);
    expect(auth.login("correct horse", "2.2.2.2", false)).rejects.toBeInstanceOf(TooManyAttempts);
    expect(await auth.login("correct horse", "3.3.3.3", false)).not.toBeNull();
  });

  test("changing the key ends existing sessions", async () => {
    const { auth } = dashboard();
    await auth.setKey("first key!");
    const cookie = (await auth.login("first key!", "a", false))!.split(";")[0]!;
    await auth.setKey("second key");
    expect(auth.authenticated(request(cookie))).toBe(false);
  });

  test("changing the key needs the current key", async () => {
    const { auth } = dashboard();
    await auth.setKey("first key!");
    expect(await auth.changeKey("guessing!", "second key", "a")).toBe(false);
    expect(await auth.login("first key!", "b", false)).not.toBeNull();
    expect(await auth.changeKey("first key!", "second key", "a")).toBe(true);
    expect(await auth.login("second key", "b", false)).not.toBeNull();
  });

  test("guessing the current key is throttled like logging in", async () => {
    const { auth } = dashboard();
    await auth.setKey("first key!");
    for (let i = 0; i < 5; i++) await auth.changeKey("guessing!", "second key", "a");
    expect(auth.changeKey("first key!", "second key", "a")).rejects.toBeInstanceOf(TooManyAttempts);
  });

  test("watchers hear when their session ends by logout, a new key, or expiry", async () => {
    const { auth } = dashboard();
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

  test("stores a salted argon2id hash, encrypted", async () => {
    const { db, secrets, auth } = dashboard(undefined, bunPasswords);
    await auth.setKey("correct horse");
    const first = secrets.get(passwordHashSecret)!;
    await auth.setKey("correct horse");
    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,t=2,p=1\$/);
    expect(secrets.get(passwordHashSecret)).not.toBe(first);
    const stored = db.all<{ value: string }>("SELECT value FROM settings UNION ALL SELECT value FROM secrets").map((row) => row.value);
    expect(stored.join()).not.toContain("$argon2");
  });

  test("a PBKDF2 hash from an older version still logs in, once, and is replaced by argon2id", async () => {
    const { secrets, auth } = dashboard(undefined, bunPasswords);
    // A session from the older version, made before its hash is replaced.
    await auth.setKey("correct horse");
    const before = request((await auth.login("correct horse", "b", false))!.split(";")[0]!);
    const old = await webPasswords.hash("correct horse");
    secrets.set(passwordHashSecret, old);
    // A wrong password changes nothing.
    expect(await auth.login("wrong key!", "a", false)).toBeNull();
    expect(secrets.get(passwordHashSecret)).toBe(old);
    const cookie = (await auth.login("correct horse", "a", false))!.split(";")[0]!;
    expect(secrets.get(passwordHashSecret)).toStartWith("$argon2id$");
    // Rehashing keeps every session, including ones from before it.
    expect(auth.authenticated(before)).toBe(true);
    expect(auth.authenticated(request(cookie))).toBe(true);
    expect(await auth.login("correct horse", "a", false)).not.toBeNull();
    expect(await auth.login("wrong key!", "a", false)).toBeNull();
  });

  test("a password changed while an old hash is being replaced stays changed", async () => {
    const { secrets, auth } = dashboard(undefined, bunPasswords);
    secrets.set(passwordHashSecret, await webPasswords.hash("old password"));
    // Holds the login's argon2id rehash until the password change has finished.
    const hash = Bun.password.hash.bind(Bun.password);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const rehashing = new Promise<void>((resolve) => (entered = resolve));
    let calls = 0;
    const spy = spyOn(Bun.password, "hash").mockImplementation(async (...args: Parameters<typeof hash>) => {
      if (calls++ === 0) {
        entered();
        await gate;
      }
      return hash(...args);
    });
    try {
      const login = auth.login("old password", "a", false);
      await rehashing;
      await auth.setKey("new password");
      release();
      expect(await login).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(await auth.login("old password", "c", false)).toBeNull();
    expect(await auth.login("new password", "c", false)).not.toBeNull();
  });

  test("an unencrypted hash from an older version moves into the encrypted secrets and still logs in", async () => {
    const db = openDatabase(":memory:");
    db.run("INSERT INTO settings (key, value) VALUES ('dashboardKeyHash', ?)", JSON.stringify(await webPasswords.hash("correct horse")));
    const secrets = new Secrets(db, testEncryption);
    expect(secrets.plaintext("seal")).toEqual(["old dashboard password setting"]);
    expect(db.one("SELECT 1 FROM settings WHERE key = 'dashboardKeyHash'")).toBeUndefined();
    expect(secrets.plaintext("seal")).toEqual([]);
    const auth = new DashboardAuth(db, secrets, bunPasswords);
    expect(auth.hasKey()).toBe(true);
    expect(await auth.login("correct horse", "a", false)).not.toBeNull();
    expect(secrets.get(passwordHashSecret)).toStartWith("$argon2id$");
  });

  test("an unencrypted hash planted after sealing ran is removed, not adopted as the password", async () => {
    const db = openDatabase(":memory:");
    const secrets = new Secrets(db, testEncryption);
    db.run("INSERT INTO settings (key, value) VALUES ('dashboardKeyHash', ?)", JSON.stringify(await webPasswords.hash("planted")));
    expect(secrets.plaintext("drop")).toEqual(["old dashboard password setting"]);
    expect(db.one("SELECT 1 FROM settings WHERE key = 'dashboardKeyHash'")).toBeUndefined();
    expect(new DashboardAuth(db, secrets, bunPasswords).hasKey()).toBe(false);
  });

  test("runtimes without argon2, such as Cloudflare Workers, hash with PBKDF2 and cannot check argon2id", async () => {
    const hash = await webPasswords.hash("correct horse");
    expect(hash).toMatch(/^\$pbkdf2-sha256\$i=100000\$[\w+/=]+\$[\w+/=]+$/);
    expect(await webPasswords.verify("correct horse", hash)).toEqual({ ok: true, outdated: false });
    expect(await webPasswords.verify("wrong key!", hash)).toEqual({ ok: false, outdated: false });
    expect(await webPasswords.verify("correct horse", await bunPasswords.hash("correct horse"))).toEqual({ ok: false, outdated: false });
  });

  test("a stopped watch is not called", async () => {
    const { auth } = dashboard();
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
    const { db, auth } = dashboard();
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
    await dashboard(db).auth.setKey("from the terminal");
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

describe("login throttling", () => {
  const setup = async () => {
    const { auth } = dashboard();
    await auth.setKey("correct horse");
    return auth;
  };
  // Wrong keys sent all at once, as a script would.
  const guesses = (auth: DashboardAuth, addresses: string[]) => Promise.allSettled(addresses.map((address) => auth.login("nope nope", address, false)));
  const refused = (results: PromiseSettledResult<string | null>[]) =>
    results.filter((result) => result.status === "rejected" && result.reason instanceof TooManyAttempts).length;

  test("failures at the same time all count, and the ones past the limit are refused without hashing", async () => {
    const auth = await setup();
    const hashes = spyOn(crypto.subtle, "deriveBits");
    try {
      const results = await guesses(auth, Array.from({ length: 50 }, () => "203.0.113.1"));
      expect(refused(results)).toBe(45);
      expect(hashes).toHaveBeenCalledTimes(5);
    } finally {
      hashes.mockRestore();
    }
    expect(auth.login("correct horse", "203.0.113.1", false)).rejects.toBeInstanceOf(TooManyAttempts);
  });

  test("every address together has a limit, which this machine is not held to and which ends a minute later", async () => {
    const auth = await setup();
    // Each address stays under its own limit, as when guesses come from a botnet or one IPv6 block.
    const results = await guesses(auth, Array.from({ length: 100 }, (_, i) => `2001:db8::${i.toString(16)}`));
    expect(refused(results)).toBe(80);
    expect(auth.login("correct horse", "198.51.100.7", false)).rejects.toBeInstanceOf(TooManyAttempts);
    expect(await auth.login("correct horse", "127.0.0.1", false)).not.toBeNull();
    setSystemTime(Date.now() + 61_000);
    try {
      expect(await auth.login("correct horse", "198.51.100.7", false)).not.toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test("tailnet users each have their own limit, and every loopback address shares one", async () => {
    const auth = await setup();
    for (let i = 0; i < 5; i++) await auth.login("nope nope", "tailscale:mallory@example.com", false);
    expect(auth.login("correct horse", "tailscale:mallory@example.com", false)).rejects.toBeInstanceOf(TooManyAttempts);
    expect(await auth.login("correct horse", "tailscale:alice@example.com", false)).not.toBeNull();
    for (let i = 0; i < 5; i++) await auth.login("nope nope", `127.0.0.${i + 1}`, false);
    expect(auth.login("correct horse", "::1", false)).rejects.toBeInstanceOf(TooManyAttempts);
  });

  test("addresses are forgotten once their attempts are a minute old", async () => {
    const auth = await setup();
    await guesses(auth, Array.from({ length: 300 }, (_, i) => `10.0.${i >> 8}.${i & 255}`));
    expect(auth["failures"].size).toBeLessThanOrEqual(20);
    setSystemTime(Date.now() + 61_000);
    try {
      expect(await auth.login("nope nope", "10.1.0.1", false)).toBeNull();
      expect(auth["failures"].size).toBe(1);
    } finally {
      setSystemTime();
    }
  });
});

describe("onboarding", () => {
  test("existing installs with a password and a provider count as onboarded", async () => {
    const db = openDatabase(":memory:");
    db.run(
      "INSERT INTO settings (key, value) VALUES ('dashboardKeyHash', ?), ('providers', ?)",
      JSON.stringify(await Bun.password.hash("old key!")), JSON.stringify(["boxd"]),
    );
    expect(new Settings(db).get("onboarded")).toBe(true);
  });

  test("an install with a provider but no password still goes through onboarding", () => {
    const db = openDatabase(":memory:");
    db.run("INSERT INTO settings (key, value) VALUES ('providers', ?)", JSON.stringify(["boxd"]));
    expect(new Settings(db).get("onboarded")).toBe(false);
  });

  test("a new install, or one with only a password, is not, and adding a provider later does not change that", () => {
    const db = openDatabase(":memory:");
    expect(new Settings(db).get("onboarded")).toBe(false);
    const withKey = openDatabase(":memory:");
    withKey.run("INSERT INTO settings (key, value) VALUES ('dashboardKeyHash', '\"hash\"')");
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
