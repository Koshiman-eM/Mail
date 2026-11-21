#!/usr/bin/env bash
# sweep-run.service から呼ばれる。収集 → Webフォーム一括応募。
# 送信 (--submit) は SWEEP_AUTO_SUBMIT=1 のときだけ。それ以外は dry-run (スクリーンショットのみ)。
# ガード (CAPTCHA・規約禁止・重複・日次上限・送信間隔など) は CLI と同じサービス層で適用される。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# 同時に 2 つ走らないようにする (前回の実行が長引いた場合など)
exec 9>"${SWEEP_RUN_LOCK:-./data/.sweep-run.lock}"
if ! flock -n 9; then
  echo "前回の実行がまだ終わっていないため今回は見送ります"
  exit 0
fi

SWEEP=(node --disable-warning=ExperimentalWarning --import tsx src/cli.ts)
# 未指定なら CLI の既定 (all → 全サブカテゴリ)
CATEGORIES="${SWEEP_RUN_CATEGORIES:-}"
MAX_DETAILS="${SWEEP_RUN_MAX_DETAILS:-60}"
COLLECT_ARGS=(collect --source koubo --max-details "$MAX_DETAILS")
[[ -n "$CATEGORIES" ]] && COLLECT_ARGS+=(--categories "$CATEGORIES")

echo "== 収集 (koubo, categories=${CATEGORIES:-既定}, max-details=$MAX_DETAILS)"
if ! "${SWEEP[@]}" "${COLLECT_ARGS[@]}"; then
  echo "収集でエラーがありました (一括応募は続行します)"
fi

if [[ "${SWEEP_AUTO_SUBMIT:-0}" == "1" ]]; then
  echo "== Webフォーム一括応募 (送信あり: SWEEP_AUTO_SUBMIT=1)"
  "${SWEEP[@]}" run --submit
else
  echo "== Webフォーム一括応募 (dry-run。送信するには /etc/sweep/env で SWEEP_AUTO_SUBMIT=1)"
  "${SWEEP[@]}" run
fi
