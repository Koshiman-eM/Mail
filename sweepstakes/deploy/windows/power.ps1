#Requires -Version 5.1
<#
.SYNOPSIS
  (任意) AC 電源接続中にスリープ・休止状態に入らないようにする。実行前に確認する。

.DESCRIPTION
  変更内容 (現在の電源プランの AC 電源時の設定のみ。バッテリー駆動時の設定は変えない):
    powercfg /change standby-timeout-ac 0     スリープしない
    powercfg /change hibernate-timeout-ac 0   休止状態にしない
  画面の消灯 (monitor-timeout) は変えない (画面が消えても動作に影響はない)。
  ふた (カバー) を閉じたときの動作は、確認した上で別途変更できる (既定は案内のみ)。

  元に戻す例: powercfg /change standby-timeout-ac 30 / powercfg /change hibernate-timeout-ac 180
  (元の値は実行前に表示する)
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-SweepConsole

function Confirm-Sweep([string]$Question) {
    $a = Read-Host "$Question [y/N]"
    return ($a -match '^(y|yes)$')
}

function Invoke-PowerCfg([string[]]$Arguments) {
    Write-Host ('> powercfg {0}' -f ($Arguments -join ' '))
    & powercfg.exe @Arguments
    if ($LASTEXITCODE -ne 0) { Write-Warning "powercfg が失敗しました (終了コード $LASTEXITCODE)" }
}

Write-Host '現在の電源プラン:' -ForegroundColor Cyan
& powercfg.exe /getactivescheme
Write-Host ''
Write-Host '現在の設定 (AC = 電源接続時 / DC = バッテリー駆動時、秒単位の 16 進数。0x00000000 = しない):' -ForegroundColor Cyan
& powercfg.exe /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
& powercfg.exe /query SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE
Write-Host ''
Write-Host 'この PC で使えるスリープ状態 (モダン スタンバイ (S0) の機種は設定が効きにくい場合があります):' -ForegroundColor Cyan
& powercfg.exe /a
Write-Host ''

if (Confirm-Sweep 'AC 電源接続中のスリープと休止状態を無効にしますか?') {
    Invoke-PowerCfg @('/change', 'standby-timeout-ac', '0')
    Invoke-PowerCfg @('/change', 'hibernate-timeout-ac', '0')
    Write-Host '変更しました (バッテリー駆動時の設定はそのままです)' -ForegroundColor Green
} else {
    Write-Host '変更しませんでした'
}

Write-Host ''
Write-Host 'ふた (カバー) を閉じたときの動作:' -ForegroundColor Cyan
Write-Host '  ノート PC はふたを閉じるとスリープするのが既定です。閉じたまま運用する場合は'
Write-Host '  「コントロール パネル > ハードウェアとサウンド > 電源オプション > カバーを閉じたときの動作の選択」で'
Write-Host '  「電源に接続」列を「何もしない」にします。閉じたままだと熱がこもりやすいので、通気に注意してください。'
if (Confirm-Sweep 'いま AC 電源接続時の「カバーを閉じたときの動作」を「何もしない」に変更しますか?') {
    # SUB_BUTTONS / LIDACTION: 0 = 何もしない
    Invoke-PowerCfg @('/setacvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', '0')
    Invoke-PowerCfg @('/setactive', 'SCHEME_CURRENT')
    Write-Host '変更しました' -ForegroundColor Green
} else {
    Write-Host '変更しませんでした'
}

Write-Host ''
Write-Host '補足:'
Write-Host '  - タスクは「ログオン中のみ」実行されます。サインアウトせず、離席時は Win+L のロックにしてください (ロック中も動作します)'
Write-Host '  - Windows Update の自動再起動後はサインインするまで動きません。「設定 > Windows Update > 詳細オプション」でアクティブ時間を設定してください'
