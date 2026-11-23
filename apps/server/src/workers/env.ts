import { base64Key, keyBytes, keyVariable, minPassphraseLength } from "../encryption.ts";
import { securityHeaders } from "../security-headers.ts";

/** The Worker's bindings, as wrangler.jsonc and the Deploy to Cloudflare screen set them. */
export interface Env {
  BRIDGE: DurableObjectNamespace;
  ASSETS: WorkersFetcher;
  VMBRIDGE_PASSWORD?: string;
  VMBRIDGE_ENCRYPTION_KEY?: string;
}

export const passwordVariable = "VMBRIDGE_PASSWORD";
/** Longer than on Bun (8): a Worker's dashboard is on the public internet from the first minute. */
export const minPasswordLength = 12;

/**
 * What is wrong with the Worker's secrets, in words for whoever deployed it, or an empty list when both are usable.
 * Cheap enough for every request: the key is only checked for shape, and stretched later, once, in the Durable Object.
 * Never includes the values.
 */
export function secretProblems(env: Env): string[] {
  const problems: string[] = [];
  const password = env.VMBRIDGE_PASSWORD ?? "";
  if (!password) problems.push(`${passwordVariable} is not set.`);
  else if (password.length < minPasswordLength) problems.push(`${passwordVariable} needs at least ${minPasswordLength} characters.`);
  const key = (env.VMBRIDGE_ENCRYPTION_KEY ?? "").trim();
  if (!key) problems.push(`${keyVariable} is not set.`);
  else if (key.length < minPassphraseLength && !base64Key(key)) {
    problems.push(`${keyVariable} must be a base64 ${keyBytes}-byte key or a passphrase of at least ${minPassphraseLength} characters.`);
  }
  return problems;
}

const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** The only page a Worker serves until its secrets are set. Nothing on it is secret, and no API answers meanwhile. */
export function setupPage(problems: string[]): Response {
  const items = problems.map((problem) => `<li>${escape(problem)}</li>`).join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VM Bridge needs setup</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --fg: #18181b; --muted: #52525b; --code: #f4f4f5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111113; --fg: #f4f4f5; --muted: #a1a1aa; --code: #27272a; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 24px; margin: 0 0 16px; }
  p, li { color: var(--muted); }
  code { background: var(--code); border-radius: 4px; padding: 1px 5px; font-size: 14px; }
</style>
</head>
<body>
<main>
<h1>VM Bridge needs setup</h1>
<ul>${items}</ul>
<p>In the Cloudflare dashboard, open this Worker, then <strong>Settings</strong>, <strong>Variables and Secrets</strong>, and set these secrets:</p>
<ul>
<li><code>${passwordVariable}</code>: the dashboard password, at least ${minPasswordLength} characters.</li>
<li><code>${keyVariable}</code>: encrypts your saved keys and sign-ins. Use the output of <code>openssl rand -base64 32</code>, or a passphrase of at least ${minPassphraseLength} characters. Keep a copy: without it, saved keys cannot be read.</li>
</ul>
<p>Then reload this page.</p>
</main>
</body>
</html>`;
  return new Response(html, { status: 503, headers: { ...securityHeaders, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
