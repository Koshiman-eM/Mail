#Requires -Version 5.1
<#
.SYNOPSIS
  MCP サーバーを起動する (npm run mcp)。ログは data\logs\mcp.log に追記。タスク スケジューラの SweepMcp から呼ばれる。

.DESCRIPTION
  サーバーが異常終了したら待ってから再起動する (タスク スケジューラの「失敗時に再起動」は
  プログラムの終了コードでは発動しないことがあるため、スクリプト側でも再起動する)。
  -Once を付けると 1 回だけ起動する (動作確認用。Ctrl+C で終了)。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\start-mcp.ps1 -Once
#>
[CmdletBinding()]
param(
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-SweepConsole
Set-Location -LiteralPath $SweepRoot

$log = Join-Path $SweepLogDir 'mcp.log'
$port = [int](Get-SweepSetting 'SWEEP_MCP_PORT' '8787')
$delaySec = 5

while ($true) {
    Limit-SweepLog $log
    $owner = Get-SweepPortOwner $port
    if ($owner) {
        # 前回のサーバーが残っている / 別のアプリが使っている
        Write-SweepLog $log "ポート $port は使用中です: $owner。SWEEP_MCP_PORT を変えるか、そのプロセスを終了してください"
        if ($Once) { exit 1 }
    } else {
        Write-SweepLog $log "== MCP サーバーを起動します (port $port, pid $PID)"
        $started = Get-Date
        try {
            $rc = Invoke-SweepNpmScript -Script 'mcp' -LogFile $log
        } catch {
            Write-SweepLog $log ('起動できませんでした: {0}' -f $_.Exception.Message)
            $rc = 1
        }
        Write-SweepLog $log "MCP サーバーが終了しました (終了コード $rc)"
        if ($Once) { exit $rc }
        # しばらく正常に動いていたら待ち時間を戻す。起動直後に落ち続ける場合は最大 5 分まで延ばす
        if (((Get-Date) - $started).TotalMinutes -ge 10) { $delaySec = 5 }
    }
    Write-SweepLog $log "$delaySec 秒後に再起動します"
    Start-Sleep -Seconds $delaySec
    $delaySec = [Math]::Min($delaySec * 2, 300)
}
