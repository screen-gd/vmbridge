import { afterEach, describe, expect, test } from "bun:test";
import { lsRemote, normalizeRemote, parseRefs, pktLines, RemoteBranches } from "../src/gateway/repos.ts";

const pkt = (line: string) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")}${line}`;
const oid = "a".repeat(40);
const bytes = (text: string) => new TextEncoder().encode(text);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

const advertisement = { "content-type": "application/x-git-upload-pack-advertisement" };

/**
 * Answers like a git host speaking protocol version 2, or 0 with `v0`. `sha256` advertises that object format, and
 * `refs` replaces the ls-refs answer. Records every request.
 */
function gitHost(options: { v0?: boolean; status?: number; sha256?: boolean; refs?: string } = {}) {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    if (options.status) return new Response("", { status: options.status });
    if (url.endsWith("/info/refs?service=git-upload-pack")) {
      const service = `${pkt("# service=git-upload-pack\n")}0000`;
      if (options.v0) {
        return new Response(
          `${service}${pkt(`${oid} HEAD\0multi_ack symref=HEAD:refs/heads/trunk agent=git/2\n`)}${pkt(`${oid} refs/heads/trunk\n`)}` +
            `${pkt(`${oid} refs/heads/feature/é\n`)}${pkt(`${oid} refs/tags/v1\n`)}${pkt(`${oid} refs/pull/1/head\n`)}0000`,
          { headers: advertisement },
        );
      }
      const format = options.sha256 ? pkt("object-format=sha256\n") : "";
      return new Response(`${service}${pkt("version 2\n")}${pkt("ls-refs=unborn\n")}${format}0000`, { headers: advertisement });
    }
    if (url.endsWith("/git-upload-pack")) {
      return new Response(options.refs ?? `${pkt(`${oid} HEAD symref-target:refs/heads/main\n`)}${pkt(`${oid} refs/heads/main\n`)}${pkt(`${oid} refs/heads/dev\n`)}0000`);
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return seen;
}

describe("reading branches over git's HTTP protocol", () => {
  test("pkt-lines, with flush and delimiter packets as null", () => {
    expect(pktLines(bytes(`${pkt("one\n")}0000${pkt("two")}0001`))).toEqual(["one", null, "two", null]);
    expect(() => pktLines(bytes("zzzz"))).toThrow();
  });

  test("a cut-off or malformed packet is an error, never a shorter branch name", () => {
    const main = pkt(`${oid} refs/heads/main\n`);
    expect(() => pktLines(bytes(main.slice(0, -2)))).toThrow("unreadable");
    expect(() => pktLines(bytes(`${main}00`))).toThrow("unreadable");
    expect(() => pktLines(bytes(`00zz${main}`))).toThrow("unreadable");
    expect(() => pktLines(bytes("0003"))).toThrow("unreadable");
  });

  test("an ERR packet fails the lookup, and an empty repository does not", async () => {
    gitHost({ refs: `${pkt("ERR repository unavailable\n")}` });
    await expect(lsRemote("https://codeberg.org/acme/app.git")).rejects.toThrow("refused");
    // An empty repository is still fine.
    gitHost({ refs: "0000" });
    expect(await lsRemote("https://codeberg.org/acme/empty.git")).toMatchObject({ names: [], defaultBranch: null });
  });

  test("a SHA-256 repository gets its object format back in the request", async () => {
    const seen = gitHost({ sha256: true });
    await lsRemote("https://git.example.com/app.git");
    expect(seen[1]!.body).toStartWith(`${pkt("command=ls-refs\n")}${pkt("object-format=sha256\n")}0001`);
  });

  test("a static (dumb) server's refs file, with the default branch from HEAD", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/info/refs?service=git-upload-pack")) {
        return new Response(`${oid}\trefs/heads/trunk\n${oid}\trefs/heads/docs\n${oid}\trefs/tags/v1\n`, { headers: { "content-type": "text/plain" } });
      }
      if (url.endsWith("/HEAD")) return new Response("ref: refs/heads/trunk\n");
      return new Response("", { status: 404 });
    }) as typeof fetch;
    expect(await lsRemote("https://static.example.com/app.git")).toMatchObject({ names: ["docs", "trunk"], defaultBranch: "trunk" });
    expect(seen).toEqual(["https://static.example.com/app.git/info/refs?service=git-upload-pack", "https://static.example.com/app.git/HEAD"]);
    // A page that is not a refs file, such as a login page, is an error rather than an empty repository.
    globalThis.fetch = (async (_input: string | URL | Request) => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    await expect(lsRemote("https://static.example.com/app.git")).rejects.toThrow("unreadable");
  });

  test("version 0 refs: the default branch from the symref capability, branches only", () => {
    const lines = [`${oid} HEAD\0multi_ack symref=HEAD:refs/heads/trunk`, `${oid} refs/heads/trunk`, `${oid} refs/tags/v1`, `${oid} refs/heads/a`];
    expect(parseRefs(lines)).toEqual({ names: ["a", "trunk"], defaultBranch: "trunk" });
  });

  test("version 2 asks for HEAD and branches only", async () => {
    const seen = gitHost();
    const branches = await lsRemote("https://codeberg.org/acme/app.git");
    expect(branches).toMatchObject({ names: ["dev", "main"], defaultBranch: "main" });
    expect(seen.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://codeberg.org/acme/app.git/info/refs?service=git-upload-pack"],
      ["POST", "https://codeberg.org/acme/app.git/git-upload-pack"],
    ]);
    expect(seen[0]!.headers.get("git-protocol")).toBe("version=2");
    expect(seen[1]!.body).toBe(`${pkt("command=ls-refs\n")}0001${pkt("symrefs\n")}${pkt("ref-prefix HEAD\n")}${pkt("ref-prefix refs/heads/\n")}0000`);
  });

  test("servers without version 2 send every ref, and multi-byte branch names survive", async () => {
    gitHost({ v0: true });
    expect(await lsRemote("https://git.example.com/app.git")).toMatchObject({ names: ["feature/é", "trunk"], defaultBranch: "trunk" });
  });

  test("the GitHub token goes to github.com only, as git's Basic auth", async () => {
    const seen = gitHost();
    await lsRemote("https://github.com/acme/private.git", { token: "gh-token" });
    await lsRemote("https://gitlab.com/acme/app.git", { token: "gh-token" });
    const auth = seen.map((request) => request.headers.get("authorization"));
    expect(auth).toEqual([`Basic ${btoa("x-access-token:gh-token")}`, `Basic ${btoa("x-access-token:gh-token")}`, null, null]);
  });

  test("only HTTPS, without credentials in the URL", async () => {
    const seen = gitHost();
    for (const url of ["http://example.com/app.git", "file:///etc", "ext::sh -c touch% /tmp/x", "https://user:pass@example.com/app.git"]) {
      await expect(lsRemote(url)).rejects.toThrow("Only HTTPS");
    }
    expect(seen).toEqual([]);
  });

  test("GitHub falls back to its REST API when git's protocol fails", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith("https://github.com/")) return new Response("", { status: 401 });
      if (url.endsWith("/branches?per_page=100")) return Response.json([{ name: "main" }, { name: "dev" }]);
      return Response.json({ default_branch: "main" });
    }) as typeof fetch;
    const branches = await new RemoteBranches(() => undefined).branches("https://github.com/acme/app");
    expect(branches).toMatchObject({ names: ["dev", "main"], defaultBranch: "main" });
    expect(seen[0]).toBe("https://github.com/acme/app.git/info/refs?service=git-upload-pack");
    expect(seen.slice(1).every((url) => url.startsWith("https://api.github.com/repos/acme/app"))).toBe(true);
  });
});

/** Like fetch, `redirect: "follow"` follows `location` itself, "error" throws, and "manual" hands back the 3xx. */
function redirecting(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const answer = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push(url);
    const response = (routes[url] ?? (() => new Response("", { status: 404 })))();
    const location = response.headers.get("location");
    if (!location || response.status < 300 || response.status > 399 || init?.redirect === "manual") return response;
    if (init?.redirect === "error") throw new TypeError("redirect");
    return answer(new URL(location, url).href, init);
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => answer(String(input), init)) as typeof fetch;
  return seen;
}

const v0Refs = () =>
  new Response(`${pkt("# service=git-upload-pack\n")}0000${pkt(`${oid} HEAD\0symref=HEAD:refs/heads/main\n`)}${pkt(`${oid} refs/heads/main\n`)}0000`, {
    headers: advertisement,
  });

describe("what a hostile git server cannot do", () => {
  test("an endless answer is cut off at the size cap instead of filling memory", async () => {
    let pulled = 0;
    let cancelled = false;
    globalThis.fetch = (async (_input: string | URL | Request) =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled += 64 * 1024;
            controller.enqueue(new Uint8Array(64 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: advertisement },
      )) as typeof fetch;
    await expect(lsRemote("https://git.example.com/app.git")).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(9 * 1024 * 1024);
    // A declared length over the cap is refused before reading anything.
    globalThis.fetch = (async (_input: string | URL | Request) => new Response("", { headers: { ...advertisement, "content-length": String(64 * 1024 * 1024) } })) as typeof fetch;
    await expect(lsRemote("https://git.example.com/app.git")).rejects.toThrow("too large");
  });

  test("a redirect to a loopback or plain HTTP address is never requested", async () => {
    const internal = () => Response.json({ names: ["INTERNAL-ONLY-DATA"] });
    const seen = redirecting({
      "https://evil.example.com/app.git/info/refs?service=git-upload-pack": () =>
        new Response("", { status: 302, headers: { location: "http://127.0.0.1:3790/admin/api/x/info/refs?service=git-upload-pack" } }),
      "https://evil.example.com/b.git/info/refs?service=git-upload-pack": () =>
        new Response("", { status: 302, headers: { location: "https://127.0.0.1/b.git/info/refs?service=git-upload-pack" } }),
      "http://127.0.0.1:3790/admin/api/x/info/refs?service=git-upload-pack": internal,
      "https://127.0.0.1/b.git/info/refs?service=git-upload-pack": internal,
    });
    await expect(lsRemote("https://evil.example.com/app.git")).rejects.toThrow();
    await expect(lsRemote("https://evil.example.com/b.git")).rejects.toThrow();
    expect(seen.filter((url) => url.includes("127.0.0.1"))).toEqual([]);
  });

  test("a redirect to another public HTTPS repository is followed for the rest of the lookup, like git", async () => {
    const seen = redirecting({
      "https://old.example.com/app/info/refs?service=git-upload-pack": () =>
        new Response("", { status: 301, headers: { location: "https://new.example.com/app.git/info/refs?service=git-upload-pack" } }),
      "https://new.example.com/app.git/info/refs?service=git-upload-pack": v0Refs,
    });
    expect(await lsRemote("https://old.example.com/app")).toMatchObject({ names: ["main"], defaultBranch: "main" });
    expect(seen).toEqual(["https://old.example.com/app/info/refs?service=git-upload-pack", "https://new.example.com/app.git/info/refs?service=git-upload-pack"]);
  });

  test("redirect loops stop after a few hops", async () => {
    const seen = redirecting({
      "https://loop.example.com/app.git/info/refs?service=git-upload-pack": () =>
        new Response("", { status: 302, headers: { location: "https://loop.example.com/app.git/info/refs?service=git-upload-pack" } }),
    });
    await expect(lsRemote("https://loop.example.com/app.git")).rejects.toThrow();
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  test("private, loopback, link-local and tailnet addresses are refused without a request", async () => {
    const seen = gitHost();
    const hosts = ["127.0.0.1", "[::1]", "10.1.2.3", "172.16.0.9", "192.168.1.1", "100.100.1.1", "169.254.169.254", "0.0.0.0", "[fd7a:115c:a1e0::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::]", "localhost", "git.localhost", "2130706433"];
    for (const host of hosts) {
      await expect(lsRemote(`https://${host}/app.git`)).rejects.toThrow("public");
      expect(() => normalizeRemote(`https://${host}/acme/app.git`)).toThrow();
    }
    expect(seen).toEqual([]);
  });

  test("a name that resolves to a private address is refused, a public one is read", async () => {
    const seen = gitHost();
    const resolve = async (host: string) => (host === "inside.example.com" ? ["203.0.113.7", "10.0.0.4"] : ["203.0.113.8"]);
    await expect(lsRemote("https://inside.example.com/app.git", { resolve })).rejects.toThrow("public");
    expect(seen).toEqual([]);
    expect(await lsRemote("https://outside.example.com/app.git", { resolve })).toMatchObject({ names: ["dev", "main"] });
    // Each redirect hop is checked again.
    redirecting({
      "https://outside.example.com/app.git/info/refs?service=git-upload-pack": () =>
        new Response("", { status: 302, headers: { location: "https://inside.example.com/app.git/info/refs?service=git-upload-pack" } }),
    });
    await expect(lsRemote("https://outside.example.com/app.git", { resolve })).rejects.toThrow("public");
  });

  test("identical lookups share one request, and one host gets a few at a time", async () => {
    let running = 0;
    let most = 0;
    let requests = 0;
    globalThis.fetch = (async (_input: string | URL | Request) => {
      requests++;
      running++;
      most = Math.max(most, running);
      await Bun.sleep(5);
      running--;
      return v0Refs();
    }) as typeof fetch;
    const remote = new RemoteBranches(() => undefined);
    await Promise.all([remote.branches("https://git.example.com/a.git", true), remote.branches("https://git.example.com/a.git", true)]);
    expect(requests).toBe(1);
    const urls = Array.from({ length: 12 }, (_, index) => `https://git.example.com/r${index}.git`);
    const lists = await Promise.all(urls.map((url) => remote.branches(url)));
    expect(lists.every((list) => list.names[0] === "main")).toBe(true);
    expect(most).toBeLessThanOrEqual(4);
  });
});
