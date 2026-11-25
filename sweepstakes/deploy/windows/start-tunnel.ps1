#Requires -Version 5.1
<#
.SYNOPSIS
  Cloudflare Tunnel (名前付きトンネル) を起動する。ログは data\logs\tunnel.log。
  タスク スケジューラの SweepTunnel (register-tasks.ps1 -Tunnel) から呼ばれる。終了したら待って再起動する。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\start-tunnel.ps1 -Name sweep -Once
#>
[CmdletBinding()]
param(
    # cloudflared tunnel create で作ったトンネル名
    [string]$Name = 'sweep',
    # 既定: %USERPROFILE%\.cloudflared\config.yml
    [string]$Config = '',
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-SweepConsole
Set-Location -LiteralPath $SweepRoot

if (-not $Config) { $Config = Join-Path $env:USERPROFILE '.cloudflared\config.yml' }
$log = Join-Path $SweepLogDir 'tunnel.log'
$delaySec = 5

while ($true) {
    Limit-SweepLog $log
    Update-SweepPath
    $cloudflared = Get-SweepCommandPath 'cloudflared.exe'
    if (-not $cloudflared) {
        Write-SweepLog $log 'cloudflared が見つかりません。winget install --id Cloudflare.cloudflared で導入してください'
    } elseif (-not (Test-Path -LiteralPath $Config)) {
        Write-SweepLog $log "設定ファイルがありません: $Config (deploy\windows\cloudflared-config.example.yml を参考に作成)"
    } else {
        Write-SweepLog $log "== トンネル $Name を起動します (config: $Config)"
        $started = Get-Date
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $cloudflared tunnel --no-autoupdate --config $Config run $Name 2>&1 |
                ForEach-Object { Write-SweepLog -LogFile $log -Message ($_.ToString()) -Raw -Quiet }
            $rc = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $prev
        }
        Write-SweepLog $log "cloudflared が終了しました (終了コード $rc)"
        if ($Once) { exit $rc }
        if (((Get-Date) - $started).TotalMinutes -ge 10) { $delaySec = 5 }
    }
    if ($Once) { exit 1 }
    Write-SweepLog $log "$delaySec 秒後に再試行します"
    Start-Sleep -Seconds $delaySec
    $delaySec = [Math]::Min($delaySec * 2, 300)
}
