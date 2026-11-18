import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright / BullMQ はサーバー側でのみ使用し、バンドル対象から外す
  serverExternalPackages: ["playwright-core", "bullmq", "ioredis"],
};

export default nextConfig;
