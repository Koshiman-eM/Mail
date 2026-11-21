// テスト用のコンテキスト生成 (インメモリ DB、ローカルホスト以外への通信は遮断)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { loadConfig, type Config } from "../../src/core/config.js";
import { Store } from "../../src/core/db.js";
import { evaluateCampaign } from "../../src/core/score.js";
import { createContext, type SweepContext } from "../../src/core/service.js";
import type { Campaign, CampaignInput, Profile } from "../../src/core/types.js";

export const TEST_PROFILE: Profile = {
  lastName: "山田",
  firstName: "太郎",
  lastNameKana: "ヤマダ",
  firstNameKana: "タロウ",
  email: "taro.yamada@example.com",
  phone: "090-1234-5678",
  zip: "100-0001",
  prefecture: "東京都",
  city: "千代田区",
  address1: "千代田1-1",
  address2: "サンプルマンション101",
  birthday: "1990-04-01",
  gender: "male",
};

export function launchTestBrowser() {
  // ブラウザのダウンロードはしない。事前インストール済みの Chromium を使う
  const executablePath = process.env.SWEEP_CHROMIUM_PATH || undefined;
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

export function makeTestContext(overrides: Partial<Config> = {}, extra: Partial<SweepContext> = {}): SweepContext {
  const screenshotDir = mkdtempSync(join(tmpdir(), "sweep-shots-"));
  const config: Config = { ...loadConfig({}), dbPath: ":memory:", screenshotDir, minIntervalSec: 0, maxIntervalSec: 0, ...overrides };
  return createContext({
    config,
    store: new Store(":memory:"),
    profile: () => TEST_PROFILE,
    launchBrowser: launchTestBrowser,
    allowedHosts: ["127.0.0.1"],
    sleep: async () => undefined,
    ...extra,
  });
}

export function addCampaign(ctx: SweepContext, input: Partial<CampaignInput> & { url: string }): Campaign {
  const ev = evaluateCampaign({
    kind: "web_form",
    source: "test",
    title: input.title ?? input.url,
    prize: "テスト賞品",
    prizeValueJpy: 10000,
    winners: 10,
    participants: 1000,
    deadline: "2099-12-31",
    conditions: {},
    estMinutes: 3,
    ...input,
  });
  return ctx.store.upsertCampaign(ev).campaign;
}
