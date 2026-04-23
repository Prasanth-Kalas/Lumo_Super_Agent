/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@lumo/agent-sdk"],
  experimental: {
    typedRoutes: false,
    // Next.js' file tracer only follows static imports, so the registry
    // JSON that `lib/agent-registry.ts` reads at runtime via `readFile()`
    // never gets shipped with the serverless function bundle. Without
    // this, /api/chat crashes on Vercel with
    //   ENOENT: config/agents.registry.vercel.json
    //
    // In Next.js 14.2 this option lives under `experimental`; it only
    // graduated to a top-level field in Next 15. Force-include the
    // config directory for every route that boots the registry.
    outputFileTracingIncludes: {
      "app/api/chat/route.ts": ["./config/**/*.json"],
      "app/api/health/route.ts": ["./config/**/*.json"],
      "app/api/registry/route.ts": ["./config/**/*.json"],
    },
  },
  // TypeScript source files use NodeNext-style ".js" extensions in imports
  // (e.g. `import "./foo.js"` that actually resolves to `foo.ts`). Webpack
  // doesn't do this rewrite on its own under moduleResolution: "Bundler",
  // so we teach it here. Fixes Vercel "Module not found: Can't resolve './system-prompt.js'".
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  // Remote agent UI bundles are loaded dynamically at runtime. Lock the list
  // in production to prevent supply-chain surprises.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
