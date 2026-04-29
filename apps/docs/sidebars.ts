import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  agentsSidebar: [
    {
      type: "category",
      label: "Get Started",
      collapsed: false,
      items: ["README", "quickstart", "authoring-guide"],
    },
    {
      type: "category",
      label: "Build",
      collapsed: false,
      items: [
        "sdk-reference",
        "oauth-integration",
        "lumo-id-integration",
        "testing-your-agent",
      ],
    },
    {
      type: "category",
      label: "Ship",
      collapsed: false,
      items: ["appstore-platform", "publishing", "example-agents"],
    },
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: [
        { type: "link", label: "API reference", href: "/reference/api" },
        "open-api-agent-candidates",
        "contributing",
      ],
    },
    {
      type: "category",
      label: "FAQ",
      collapsed: false,
      items: ["faq"],
    },
  ],
};

export default sidebars;
