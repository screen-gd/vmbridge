/**
 * Renders the Open Graph image, GitHub's social preview and the Apple touch icon as static PNGs.
 * Run with `bun run og` after changing the design. Needs Google Chrome and a network connection for the fonts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { providers } from "../lib/data";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const publicFile = (file: string) => readFileSync(path(`../public${file}`));
const dataUri = (file: string) => `data:${file.endsWith(".png") ? "image/png" : "image/svg+xml"};base64,${publicFile(file).toString("base64")}`;
const logo = publicFile("/logo.svg").toString();

// The landing's fonts, from the same source next/font uses.
const fonts = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Mona+Sans:wght@400;600&family=Fragment+Mono&display=block">`;

const vms = [
  { provider: providers[0], name: "api-server", asleep: false },
  { provider: providers[1], name: "web-app", asleep: true },
  { provider: providers[2], name: "docs", asleep: false },
];

/** Same palette as globals.css. The text column and the VM cards sit 80px or more from every edge. */
const card = (width: number, height: number) => `<style>
  * { box-sizing: border-box; margin: 0; }
  body { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: #000; color: #ededed; font-family: "Mona Sans"; -webkit-font-smoothing: antialiased; }
  .dots { position: absolute; inset: 0; background-image: radial-gradient(circle at 1px 1px, #262626 1px, transparent 0); background-size: 22px 22px; mask-image: radial-gradient(ellipse at 75% 50%, black 10%, transparent 60%); }
  .glow { position: absolute; right: -120px; top: 50%; width: 760px; height: 560px; transform: translateY(-50%); background: radial-gradient(closest-side, rgba(139, 92, 246, 0.24), transparent); }
  main { position: absolute; inset: 80px 88px; display: flex; align-items: center; justify-content: space-between; }
  .text { width: 620px; height: 100%; display: flex; flex-direction: column; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 34px; font-weight: 600; letter-spacing: -0.01em; }
  .brand svg { width: 54px; height: 54px; }
  h1 { font-size: 64px; line-height: 1.06; font-weight: 600; letter-spacing: -0.03em; }
  p { font-size: 26px; color: #8f8f8f; }
  .vms { display: flex; flex-direction: column; gap: 18px; width: 380px; }
  .vm { display: flex; align-items: center; gap: 18px; padding: 16px 22px 16px 16px; border: 1px solid #1f1f1f; border-radius: 18px; background: #0a0a0a; }
  .vm.asleep { opacity: 0.6; }
  .tile { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 13px; overflow: hidden; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1); }
  .tile img { width: 100%; height: 100%; object-fit: contain; }
  .name { flex: 1; font-family: "Fragment Mono"; font-size: 24px; }
  .state { display: flex; align-items: center; gap: 10px; font-size: 20px; color: #8f8f8f; }
  .state i { width: 10px; height: 10px; border-radius: 50%; background: #3ecf8e; }
  .asleep .state i { background: #5c5c5c; }
</style>
<div class="dots"></div>
<div class="glow"></div>
<main>
  <div class="text">
    <div class="brand">${logo}VM Bridge</div>
    <h1>Every T3 Code project gets its own cloud computer</h1>
    <p>Open source. Runs on macOS and Linux.</p>
  </div>
  <div class="vms">
    ${vms
      .map(
        ({ provider, name, asleep }) => `<div class="vm${asleep ? " asleep" : ""}">
      <span class="tile" style="background: ${provider.tile}"><img src="${dataUri(provider.logo)}" style="padding: ${provider.inset}"></span>
      <span class="name">${name}</span>
      <span class="state"><i></i>${asleep ? "Asleep" : "Online"}</span>
    </div>`,
      )
      .join("")}
  </div>
</main>`;

// iOS rounds the corners itself, so the touch icon is the mark on a full square.
const appleIcon = `<style>* { margin: 0; } svg { display: block; width: 180px; height: 180px; }</style>${logo.replace('rx="9"', 'rx="0"')}`;

const images = [
  { file: "../public/og.png", width: 1200, height: 630, html: card(1200, 630) },
  { file: "../../../docs/social-preview.png", width: 1280, height: 640, html: card(1280, 640) },
  { file: "../public/apple-icon.png", width: 180, height: 180, html: appleIcon },
];

const browser = await chromium.launch({ channel: "chrome" });
for (const { file, width, height, html } of images) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">${fonts}</head><body>${html}</body></html>`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() => [...document.fonts].filter((font) => font.status === "loaded").map((font) => font.family));
  if (html !== appleIcon && !["Mona Sans", "Fragment Mono"].every((family) => loaded.includes(family))) {
    throw new Error(`Fonts did not load for ${file}: ${loaded.join(", ") || "none"}`);
  }
  await page.screenshot({ path: path(file) });
  await page.close();
  console.log(`Wrote ${path(file)}`);
}
await browser.close();
