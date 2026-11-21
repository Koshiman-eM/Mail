import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 資産クラスの選択 (crypto・meme) を全テストの前に決める
    setupFiles: ["tests/setup.ts"],
    // 誤発注防止: テスト中は常にペーパーモードを強制し、外部 API キーを空にする
    env: {
      NODE_ENV: "test",
      TRADING_MODE: "paper",
      LIVE_TRADING_CONFIRM: "",
      ANTHROPIC_API_KEY: "",
    },
  },
});
