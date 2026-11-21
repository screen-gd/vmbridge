import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { copy } from "@/lib/copy";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: { default: copy.meta.title, template: "%s | VM Bridge" },
  description: copy.meta.description,
  icons: { icon: "/logo.svg" },
};

export const viewport: Viewport = { themeColor: "#070708" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
