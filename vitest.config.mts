import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 外部誤送信防止: テスト中は常にモックアダプターを強制
    env: { SUPPLIER_ADAPTER: "mock", NODE_ENV: "test" },
  },
});
