#Requires -Version 5.1
<#
.SYNOPSIS
  タスク スケジューラに懸賞ツールのタスクを登録する (現在のユーザー、ログオン中に実行。管理者権限は不要)。

.DESCRIPTION
  SweepMcp    : ログオン時に start-mcp.ps1 (MCP サーバー)。失敗時に再起動、実行時間の制限なし、バッテリー駆動でも継続
  SweepRun    : 毎日 -RunTimes の時刻 (既定 09:10 / 13:10 / 20:10) に run-once.ps1 (収集 → 一括応募)
  SweepTunnel : -Tunnel 指定時のみ。ログオン時に start-tunnel.ps1 (cloudflared の名前付きトンネル)
  何度実行しても同じ結果になる (既存のタスクは上書き)。-Unregister で 3 つとも削除する。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\register-tasks.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\register-tasks.ps1 -RunTimes 08:30,12:30,21:00 -Tunnel -TunnelName sweep
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\register-tasks.ps1 -Unregister
#>
[CmdletBinding()]
param(
    # 定期実行の時刻 (HH:mm)。カンマ区切りで複数
    [string[]]$RunTimes = @('09:10', '13:10', '20:10'),
    # cloudflared の名前付きトンネルもタスク登録する
    [switch]$Tunnel,
    [string]$TunnelName = 'sweep',
    # 既定: %USERPROFILE%\.cloudflared\config.yml
    [string]$TunnelConfig = '',
    # タスクの実行に PowerShell 7 (pwsh.exe) を使う (既定は Windows PowerShell 5.1)
    [switch]$UsePwsh,
    # 登録後に SweepMcp (と SweepTunnel) をすぐ開始しない
    [switch]$NoStart,
    # タスクを削除する
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-SweepConsole

$TaskNames = @('SweepMcp', 'SweepRun', 'SweepTunnel')
$TaskPath = '\'   # 一般ユーザーはルート直下のフォルダー作成が拒否されることがあるため、ルートに置く

function Remove-SweepTask([string]$Name) {
    $t = Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if ($t) {
        Stop-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Confirm:$false
        Write-Host "削除しました: $Name"
    }
}

if ($Unregister) {
    foreach ($n in $TaskNames) { Remove-SweepTask $n }
    Write-Host 'タスクを削除しました。MCP サーバーや cloudflared のプロセスが残っている場合はタスク マネージャーで node.exe / cloudflared.exe を終了してください'
    exit 0
}

# ---------------------------------------------------------------------------
$psExe = if ($UsePwsh) { Get-SweepCommandPath 'pwsh.exe' } else { Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
if (-not $psExe -or -not (Test-Path -LiteralPath $psExe)) { throw 'PowerShell の実行ファイルが見つかりません (-UsePwsh の場合は PowerShell 7 を導入してください)' }

$userId = if ($env:USERDOMAIN) { '{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME } else { $env:USERNAME }
# Interactive: ログオン中だけ実行 (パスワードの保存不要・管理者権限不要)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

function New-SweepAction([string]$Script, [string]$ExtraArgs = '') {
    $file = Join-Path $PSScriptRoot $Script
    $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $file
    if ($ExtraArgs) { $arg = "$arg $ExtraArgs" }
    return New-ScheduledTaskAction -Execute $psExe -Argument $arg -WorkingDirectory $SweepRoot
}

function Register-SweepTask([string]$Name, $Action, $Trigger, $Settings, [string]$Description) {
    try {
        Register-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Action $Action -Trigger $Trigger -Settings $Settings `
            -Principal $principal -Description $Description -Force | Out-Null
        Write-Host "登録しました: $Name"
    } catch {
        throw "タスク $Name を登録できませんでした: $($_.Exception.Message)`n(会社の PC などでタスクの登録が制限されている場合は、管理者として実行した PowerShell で再実行してください)"
    }
}

# 常駐タスク (MCP サーバー・トンネル) の設定: 実行時間の制限なし・失敗時に再起動・バッテリーでも継続
function New-ResidentSettings {
    return New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew -StartWhenAvailable
}

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId

# (a) MCP サーバー
Register-SweepTask -Name 'SweepMcp' -Action (New-SweepAction 'start-mcp.ps1') -Trigger $logonTrigger `
    -Settings (New-ResidentSettings) -Description '懸賞ツール MCP サーバー (127.0.0.1)。ログ: data\logs\mcp.log'

# (b) 定期実行
$triggers = @()
foreach ($t in $RunTimes) {
    foreach ($one in ($t -split ',')) {
        $one = $one.Trim()
        if (-not $one) { continue }
        $at = [datetime]::MinValue
        if (-not [datetime]::TryParseExact($one, 'H:mm', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$at)) {
            throw "-RunTimes の時刻が不正です: $one (例: 09:10)"
        }
        $triggers += New-ScheduledTaskTrigger -Daily -At $at
    }
}
if (-not $triggers.Count) { throw '-RunTimes を 1 つ以上指定してください' }
# スリープ等で予定時刻を逃したら復帰後に実行 (StartWhenAvailable)。送信間隔の待機があるため最大 4 時間
$runSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
    -MultipleInstances IgnoreNew -StartWhenAvailable
Register-SweepTask -Name 'SweepRun' -Action (New-SweepAction 'run-once.ps1') -Trigger $triggers `
    -Settings $runSettings -Description ('懸賞ツール 定期実行 (収集 → 一括応募、{0})。ログ: data\logs\run-YYYYMMDD.log' -f ($RunTimes -join ' / '))

# (c) トンネル (任意)
if ($Tunnel) {
    if (-not (Get-SweepCommandPath 'cloudflared.exe')) {
        Write-Warning 'cloudflared が見つかりません。winget install --id Cloudflare.cloudflared で導入してください (タスクは登録します)'
    }
    $extra = '-Name "{0}"' -f $TunnelName
    if ($TunnelConfig) { $extra += ' -Config "{0}"' -f $TunnelConfig }
    Register-SweepTask -Name 'SweepTunnel' -Action (New-SweepAction 'start-tunnel.ps1' $extra) -Trigger $logonTrigger `
        -Settings (New-ResidentSettings) -Description "懸賞ツール Cloudflare Tunnel ($TunnelName)。ログ: data\logs\tunnel.log"
} elseif (Get-ScheduledTask -TaskName 'SweepTunnel' -TaskPath $TaskPath -ErrorAction SilentlyContinue) {
    Write-Host 'SweepTunnel は登録済みのまま残しています (削除: -Unregister で全削除後に再登録)'
}

if (-not $NoStart) {
    Start-ScheduledTask -TaskName 'SweepMcp' -TaskPath $TaskPath
    Write-Host '開始しました: SweepMcp'
    if ($Tunnel) {
        Start-ScheduledTask -TaskName 'SweepTunnel' -TaskPath $TaskPath
        Write-Host '開始しました: SweepTunnel'
    }
}

Write-Host ''
Write-Host '確認:'
Write-Host '  Get-ScheduledTask -TaskName Sweep* | Get-ScheduledTaskInfo'
Write-Host '  Invoke-RestMethod http://127.0.0.1:8787/healthz    (数秒後に ok)'
Write-Host '  定期実行を今すぐ試す: Start-ScheduledTask -TaskName SweepRun  (ログ: data\logs\run-YYYYMMDD.log)'
