import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Effortless",
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
      },
      favicon: "/logo.png",
      customCss: ["./src/styles/custom.css"],
      social: {
        github: "https://github.com/kondaurovDev/effortless-aws",
      },
      components: {
        SocialIcons: "./src/components/HeaderLinks.astro",
      },
      sidebar: [
        {
          label: "Guides",
          items: [
            { label: "Getting Started", slug: "getting-started" },
            { label: "Configuration", slug: "configuration" },
            { label: "CLI", slug: "cli" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Handlers", slug: "handlers" },
            { label: "Architecture", slug: "architecture" },
            { label: "Observability", slug: "observability" },
          ],
        },
        {
          label: "About",
          items: [
            { label: "FAQ", slug: "faq" },
            { label: "Roadmap", slug: "roadmap" },
            { label: "CLI Roadmap", slug: "roadmap-cli" },
          ],
        },
      ],
    }),
  ],
});
