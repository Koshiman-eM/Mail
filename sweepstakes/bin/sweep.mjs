#!/usr/bin/env node
// tsx 経由で TypeScript の CLI を起動する薄いラッパー
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(root, "src/cli.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
