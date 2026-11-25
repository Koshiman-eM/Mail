#Requires -Version 5.1
<#
.SYNOPSIS
  定期実行 1 回分: 収集 (公募ガイド) → Webフォーム一括応募。タスク スケジューラの SweepRun から呼ばれる。

.DESCRIPTION
  - npm run sweep -- collect --source koubo  → npm run sweep -- run
  - 送信 (--submit) は SWEEP_AUTO_SUBMIT=1 (.env または環境変数) のときだけ。それ以外は dry-run
  - ログは data\logs\run-YYYYMMDD.log に追記
  - 他の処理 (前回の実行 / MCP サーバーのジョブ) が収集・応募中ならロックで即終了するので、正常終了扱いでスキップ
  - ガード (CAPTCHA・規約禁止・重複・日次上限・送信間隔など) は CLI と同じサービス層で適用される
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-SweepConsole
Set-Location -LiteralPath $SweepRoot

$log = Join-Path $SweepLogDir ('run-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))

try {
    $categories = Get-SweepSetting 'SWEEP_RUN_CATEGORIES' ''
    $maxDetails = Get-SweepSetting 'SWEEP_RUN_MAX_DETAILS' '60'
    $autoSubmit = (Get-SweepSetting 'SWEEP_AUTO_SUBMIT' '0') -eq '1'

    Write-SweepLog $log ('== 開始 (pid {0}, PowerShell {1})' -f $PID, $PSVersionTable.PSVersion)

    $collectArgs = @('collect', '--source', 'koubo', '--max-details', $maxDetails)
    if ($categories) { $collectArgs += @('--categories', $categories) }
    Write-SweepLog $log ('== 収集 (koubo, categories={0}, max-details={1})' -f $(if ($categories) { $categories } else { '既定' }), $maxDetails)
    $rc = Invoke-SweepNpmScript -Script 'sweep' -Arguments $collectArgs -LogFile $log
    if ($rc -eq $ExitLockBusy) {
        Write-SweepLog $log '他の処理 (前回の実行 / MCP のジョブ) が実行中のため今回は見送ります'
        exit 0
    } elseif ($rc -ne 0) {
        Write-SweepLog $log "収集でエラーがありました (終了コード $rc)。一括応募は続行します"
    }

    $runArgs = @('run')
    if ($autoSubmit) {
        $runArgs += '--submit'
        Write-SweepLog $log '== Webフォーム一括応募 (送信あり: SWEEP_AUTO_SUBMIT=1)'
    } else {
        Write-SweepLog $log '== Webフォーム一括応募 (dry-run。送信するには .env で SWEEP_AUTO_SUBMIT=1)'
    }
    $rc = Invoke-SweepNpmScript -Script 'sweep' -Arguments $runArgs -LogFile $log
    if ($rc -eq $ExitLockBusy) {
        Write-SweepLog $log '他の処理が実行中のため一括応募は見送ります'
        exit 0
    }
    Write-SweepLog $log "== 終了 (終了コード $rc)"
    exit $rc
} catch {
    Write-SweepLog $log ('エラー: {0}' -f $_.Exception.Message)
    exit 1
}
