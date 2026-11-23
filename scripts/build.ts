// Builds the dashboard into static files for Cloudflare Workers Static Assets: the page and its files under
// dist/assets/dashboard (the dashboard lives at /dashboard), and a _headers file giving them the security headers the
// Bun server sends. The Bun server bundles the dashboard itself and does not use these.
import tailwind from "bun-plugin-tailwind";
import { securityHeaders } from "../apps/server/src/security-headers.ts";

const root = "dist/assets";
const outdir = `${root}/dashboard`;
const result = await Bun.build({
  entrypoints: ["apps/web/index.html"],
  outdir,
  publicPath: "/dashboard/",
  plugins: [tailwind],
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const headers = Object.entries(securityHeaders).map(([name, value]) => `  ${name}: ${value}`);
await Bun.write(`${root}/_headers`, ["/*", ...headers, ""].join("\n"));
console.log(`Built ${outdir}`);
