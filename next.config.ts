import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  experimental: {
    serverActions: {
      bodySizeLimit: "5mb",
    },
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
