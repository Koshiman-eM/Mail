import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // アプリの設定 (使う資産クラス) を全テストの前に読み込む
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
