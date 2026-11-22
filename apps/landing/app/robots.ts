import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

// Crawlers may read every address. The vercel.app copy is kept out of results by canonical links, not by blocking it here.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${site.url}/sitemap.xml`,
  };
}
