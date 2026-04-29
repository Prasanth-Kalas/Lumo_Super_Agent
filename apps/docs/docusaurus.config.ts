import type { Config } from "@docusaurus/types";
import type { Options as PresetOptions } from "@docusaurus/preset-classic";

const config: Config = {
  title: "Lumo Agents",
  tagline: "Build, ship, and operate third-party agents for Lumo.",
  favicon: "img/lumo-mark.svg",
  url: "https://docs.lumo.rentals",
  baseUrl: "/agents/",
  organizationName: "Prasanth-Kalas",
  projectName: "Lumo_Super_Agent",
  trailingSlash: false,
  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "throw",
  onDuplicateRoutes: "throw",
  customFields: {
    feedbackEndpoint:
      process.env.LUMO_DOCS_FEEDBACK_ENDPOINT ??
      "https://lumo-super-agent.vercel.app/api/docs/feedback",
    plausibleDomain: "docs.lumo.rentals",
  },
  scripts: [
    {
      src: "https://plausible.io/js/script.js",
      defer: true,
      "data-domain": "docs.lumo.rentals",
    },
  ],
  plugins: [
    [
      "@docusaurus/plugin-content-docs",
      {
        id: "api",
        path: "docs/reference/api",
        routeBasePath: "reference/api",
        sidebarPath: false,
        showLastUpdateAuthor: false,
        showLastUpdateTime: false,
      },
    ],
  ],
  presets: [
    [
      "classic",
      {
        docs: {
          path: "../../docs/developers",
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl:
            "https://github.com/Prasanth-Kalas/Lumo_Super_Agent/edit/main/docs/developers/",
          showLastUpdateAuthor: false,
          showLastUpdateTime: false,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies PresetOptions,
    ],
  ],
  themeConfig: {
    image: "img/lumo-mark.svg",
    navbar: {
      title: "Lumo Agents",
      logo: {
        alt: "Lumo mark",
        src: "img/lumo-mark.svg",
      },
      items: [
        { type: "docSidebar", sidebarId: "agentsSidebar", position: "left", label: "Docs" },
        { to: "/quickstart", label: "Quickstart", position: "left" },
        { to: "/publishing", label: "Ship", position: "left" },
        {
          href: "https://lumo-super-agent.vercel.app/marketplace",
          label: "Marketplace",
          position: "right",
        },
        {
          href: "https://github.com/Prasanth-Kalas/Lumo_Super_Agent",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Build",
          items: [
            { label: "Quickstart", to: "/quickstart" },
            { label: "SDK reference", to: "/sdk-reference" },
            { label: "Testing", to: "/testing-your-agent" },
          ],
        },
        {
          title: "Ship",
          items: [
            { label: "Publishing", to: "/publishing" },
            { label: "Platform", to: "/appstore-platform" },
            { label: "Examples", to: "/example-agents" },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Lumo.`,
    },
    prism: {
      theme: {
        plain: { color: "#18212f", backgroundColor: "#f7f9fc" },
        styles: [],
      },
      darkTheme: {
        plain: { color: "#f6f8fb", backgroundColor: "#111827" },
        styles: [],
      },
    },
    colorMode: {
      defaultMode: "light",
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
  },
};

export default config;
