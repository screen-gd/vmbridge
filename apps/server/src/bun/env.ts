/**
 * Variables a helper program VM Bridge runs (cloudflared, tailscale, ps, launchctl, systemctl) may need: where to find
 * programs and its home, temp files and locale, a proxy, and the user session systemd talks to. Everything else stays
 * in VM Bridge, such as VMBRIDGE_PASSWORD, VMBRIDGE_ENCRYPTION_KEY and whatever the shell that started it held.
 */
export const childVariables = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];

/** The environment for a helper program: `childVariables` from VM Bridge's own, plus `extra`. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of childVariables) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}
