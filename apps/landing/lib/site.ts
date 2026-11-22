import type { Metadata } from "next";
import pkg from "../../../package.json";

/** Facts about the site itself, for metadata, structured data and llms.txt. Server only. */
export const site = {
  /** The canonical address. The vercel.app address serves the same pages with canonical links to this one. */
  url: "https://vmbridge.ordinity.com",
  name: "VM Bridge",
  title: "VM Bridge: run T3 Code agents on cloud VMs",
  description:
    "VM Bridge runs T3 Code agents on cloud VMs. Each project gets its own VM, and more when it is busy. VMs sleep when idle and wake on your next message. Free and open source.",
  version: pkg.version,
};

/** Shared by every page, since a page's own openGraph replaces the layout's instead of merging with it. public/og.png comes from scripts/og.ts. */
export const openGraph = {
  type: "website",
  siteName: site.name,
  locale: "en_US",
  images: [{ url: "/og.png", type: "image/png", width: 1200, height: 630, alt: "VM Bridge: every T3 Code project gets its own cloud computer" }],
} satisfies Metadata["openGraph"];
