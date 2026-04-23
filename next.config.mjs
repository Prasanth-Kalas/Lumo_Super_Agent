/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@lumo/agent-sdk"],
  experimental: {
    typedRoutes: false,
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
