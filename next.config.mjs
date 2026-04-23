/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@lumo/agent-sdk"],
  experimental: {
    typedRoutes: false,
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
