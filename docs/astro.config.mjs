import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import { mkdir, rename, unlink } from "node:fs/promises";

export default defineConfig({
  site: "https://effortless-aws.website",
  integrations: [
    sitemap(),
    {
      name: "flatten-sitemap",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          const sitemapDir = new URL("sitemap/", dir);
          await mkdir(sitemapDir, { recursive: true });
          await unlink(new URL("sitemap-index.xml", dir));
          await rename(
            new URL("sitemap-0.xml", dir),
            new URL("sitemap/sitemap.xml", dir),
          );
        },
      },
    },
    starlight({
      title: "Effortless",
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
      },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      social: {
        github: "https://github.com/kondaurovDev/effortless-aws",
      },
      components: {
        SocialIcons: "./src/components/HeaderLinks.astro",
      },
      head: [
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://effortless-aws.website/og-banner.png",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:type",
            content: "website",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:site_name",
            content: "Effortless AWS",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:card",
            content: "summary_large_image",
          },
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Why Effortless?", slug: "why-effortless" },
            { label: "Installation", slug: "installation" },
            { label: "Configuration", slug: "configuration" },
            { label: "Definitions", slug: "definitions" },
            { label: "CLI", slug: "cli" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "HTTP API", slug: "use-cases/http-api" },
            { label: "Database", slug: "use-cases/database" },
            { label: "Website", slug: "use-cases/web-app" },
            { label: "Queue", slug: "use-cases/queue" },
            { label: "Storage", slug: "use-cases/storage" },
            { label: "Email", slug: "use-cases/email" },
          ],
        },
        {
          label: "Resources",
          items: [
            { label: "Why AWS?", slug: "why-aws" },
            { label: "FAQ", slug: "faq" },
            { label: "Architecture", slug: "architecture" },
            { label: "Comparisons", slug: "comparisons" },
            { label: "Roadmap", slug: "roadmap" },
          ],
        },
      ],
    }),
  ],
});
