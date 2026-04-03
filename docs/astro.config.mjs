import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
export default defineConfig({
  site: "https://effortless-aws.website",
  integrations: [
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
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", slug: "configuration" },
            { label: "Handler Definitions", slug: "definitions" },
            { label: "CLI Commands", slug: "cli" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Authentication", slug: "use-cases/authentication" },
            { label: "HTTP API", slug: "use-cases/http-api" },
            { label: "Database", slug: "use-cases/database" },
            { label: "Website", slug: "use-cases/web-app" },
            { label: "Queue", slug: "use-cases/queue" },
            { label: "Storage", slug: "use-cases/storage" },
            { label: "Email", slug: "use-cases/email" },
            { label: "MCP Server", slug: "use-cases/mcp-server" },
          ],
        },
        {
          label: "Resources",
          items: [
            { label: "Why serverless?", slug: "why-serverless" },
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
