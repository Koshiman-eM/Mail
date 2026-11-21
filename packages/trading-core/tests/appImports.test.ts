/**
 * アプリ (コアを file: 依存で使うパッケージ) のコードは decimal.js を直接 import しない
 * (会計値は @trading/core/core/decimal を通す。decimal.js の実体を 2 つに分けない)。
 * zod はアプリの設定 (shape) ならコアの z (@trading/core/core/config) を使う。API の応答の解析だけはアプリの zod でもよい
 * (コアのスキーマと合成しない。trader の src/market/jupiter/)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** リポジトリ直下で @trading/core に依存するパッケージ (trader・fx-trader・stock-trader など) */
function appDirs(): string[] {
  return readdirSync(repoRoot)
    .map((d) => join(repoRoot, d))
    .filter((d) => existsSync(join(d, "package.json")) && existsSync(join(d, "src")))
    .filter((d) => readFileSync(join(d, "package.json"), "utf8").includes('"@trading/core"'));
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("アプリのコードの import", () => {
  it("decimal.js を直接 import しない (@trading/core/core/decimal を使う)", () => {
    const offenders: string[] = [];
    for (const app of appDirs()) {
      for (const f of tsFiles(join(app, "src"))) {
        if (/from\s+["']decimal\.js["']|import\(\s*["']decimal\.js["']\s*\)/.test(readFileSync(f, "utf8"))) offenders.push(relative(repoRoot, f));
      }
    }
    expect(offenders).toEqual([]);
  });
  it("アプリが見つかる (trader)", () => {
    expect(appDirs().some((d) => d.endsWith("trader"))).toBe(true);
  });
});
