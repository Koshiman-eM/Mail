#!/usr/bin/env bash
# sweep-run.service から呼ばれる。収集 → Webフォーム一括応募。
# 送信 (--submit) は SWEEP_AUTO_SUBMIT=1 のときだけ。それ以外は dry-run (スクリーンショットのみ)。
# ガード (CAPTCHA・規約禁止・重複・日次上限・送信間隔など) は CLI と同じサービス層で適用される。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# 排他: collect / run は CLI 自身がファイルロック (data/browser.lock) を取る。
# 前回の実行や MCP サーバーのジョブが収集・応募中なら終了コード 75 で即終了するので、今回は見送る。
EXIT_LOCK_BUSY=75

SWEEP=(node --disable-warning=ExperimentalWarning --import tsx src/cli.ts)
# 未指定なら CLI の既定 (all → 全サブカテゴリ)
CATEGORIES="${SWEEP_RUN_CATEGORIES:-}"
MAX_DETAILS="${SWEEP_RUN_MAX_DETAILS:-60}"
COLLECT_ARGS=(collect --source koubo --max-details "$MAX_DETAILS")
[[ -n "$CATEGORIES" ]] && COLLECT_ARGS+=(--categories "$CATEGORIES")

echo "== 収集 (koubo, categories=${CATEGORIES:-既定}, max-details=$MAX_DETAILS)"
"${SWEEP[@]}" "${COLLECT_ARGS[@]}"
rc=$?
if (( rc == EXIT_LOCK_BUSY )); then
  echo "他の処理 (前回の実行 / MCP のジョブ) が実行中のため今回は見送ります"
  exit 0
elif (( rc != 0 )); then
  echo "収集でエラーがありました (一括応募は続行します)"
fi

RUN_ARGS=(run)
if [[ "${SWEEP_AUTO_SUBMIT:-0}" == "1" ]]; then
  echo "== Webフォーム一括応募 (送信あり: SWEEP_AUTO_SUBMIT=1)"
  RUN_ARGS+=(--submit)
else
  echo "== Webフォーム一括応募 (dry-run。送信するには /etc/sweep/env で SWEEP_AUTO_SUBMIT=1)"
fi
"${SWEEP[@]}" "${RUN_ARGS[@]}"
rc=$?
if (( rc == EXIT_LOCK_BUSY )); then
  echo "他の処理が実行中のため一括応募は見送ります"
  exit 0
fi
exit "$rc"
