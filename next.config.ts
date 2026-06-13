import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server (.next/standalone) so the packaged Electron app
  // can run it with its own bundled Node — no system Node / full node_modules.
  output: "standalone",
};

export default nextConfig;
