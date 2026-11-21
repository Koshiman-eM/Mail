import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Playwright を使う結合テストがあるため長めに取る
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // テスト中は送信間隔を 0 にし、実在サイトには一切アクセスしない
    env: {
      SWEEP_MIN_INTERVAL_SEC: "0",
      SWEEP_MAX_INTERVAL_SEC: "0",
    },
  },
});
