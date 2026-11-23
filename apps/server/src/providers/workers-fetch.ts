const installed = Symbol.for("vmbridge.workersFetchCompat");

/**
 * Makes the global `fetch` safe for provider SDKs on Cloudflare Workers. The Workers entry calls it once; Bun never
 * needs it, and calling it there changes nothing an SDK can see.
 *
 * - Instabox passes `redirect: "error"`, which Workers refuses. It becomes `"manual"`, and a redirect still fails.
 * - Railway saves `globalThis.fetch` and calls it as a method of its config, which Workers' own fetch refuses
 *   ("Illegal invocation"). This wrapper calls the saved fetch without a receiver.
 */
export function workersFetchCompat() {
  const current = globalThis.fetch;
  if (installed in current) return;
  const native = current;
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.redirect !== "error") return native(input, init);
    const response = await native(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new TypeError(`fetch failed: redirected (${response.status}) where redirects are not allowed`);
    }
    return response;
  };
  globalThis.fetch = Object.assign(wrapped, current, { [installed]: true });
}
