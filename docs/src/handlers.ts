import { defineStaticSite } from "effortless-aws";

export const docsCDN = defineStaticSite({
  dir: "dist",
  build: "pnpm run build",
  domain: "effortless-aws.website",
  spa: false,
  seo: {
    sitemap: "sitemap.xml",
    googleIndexing: '~/google-index-seo.json'
  },
});
