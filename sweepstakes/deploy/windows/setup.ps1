#Requires -Version 5.1
<#
.SYNOPSIS
  懸賞ツールを Windows PC で動かすための準備 (何度実行しても同じ結果になる)。管理者権限は不要。

.DESCRIPTION
  1. Node.js (22.13 以上) が無ければ winget で Node.js LTS (OpenJS.NodeJS.LTS) をユーザー範囲で導入
  2. npm ci (依存関係)
  3. npx playwright install chromium (Windows では --with-deps 不要)
  4. data\ / data\logs\ / data\screenshots\ を作成
  5. .env が無ければ .env.example から作成し、SWEEP_MCP_TOKEN を暗号学的乱数で生成 (64 桁の 16 進数)
  6. profile.json が無ければ profile.example.json からコピーして編集を促す

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\setup.ps1
#>
[CmdletBinding()]
param(
    # Node.js の自動導入をしない (自分で入れる場合)
    [switch]$SkipNodeInstall,
    # Chromium のダウンロードをしない
    [switch]$SkipBrowser
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-SweepConsole
Set-Location -LiteralPath $SweepRoot

$MinNode = [version]'22.13.0'   # node:sqlite と --env-file-if-exists (22.9+) のため

function Write-Step([string]$Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }

function Get-NodeVersion {
    $node = Get-SweepCommandPath 'node.exe'
    if (-not $node) { return $null }
    $v = $null
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $v = (& $node -p 'process.versions.node' 2>$null) } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0 -or -not $v) { return $null }
    try { return [version]($v.Trim()) } catch { return $null }
}

function Invoke-Native([string]$File, [string[]]$Arguments, [string]$What) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$What に失敗しました (終了コード $LASTEXITCODE)" }
}

# ---------------------------------------------------------------------------
Write-Step "Node.js ($MinNode 以上)"
$nodeVer = Get-NodeVersion
if ($nodeVer -and $nodeVer -ge $MinNode) {
    Write-Host "Node.js $nodeVer を使います"
} elseif ($SkipNodeInstall) {
    throw "Node.js $MinNode 以上が必要です (現在: $(if ($nodeVer) { $nodeVer } else { 'なし' }))。https://nodejs.org/ から LTS を入れてください"
} else {
    $winget = Get-SweepCommandPath 'winget.exe'
    if (-not $winget) {
        throw 'winget が見つかりません。Microsoft Store の「アプリ インストーラー」を更新するか、https://nodejs.org/ から Node.js LTS を手動で入れてください'
    }
    $common = @('--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements')
    $verb = if ($nodeVer) { 'upgrade' } else { 'install' }
    Write-Host "winget $verb OpenJS.NodeJS.LTS (ユーザー範囲) ..."
    & $winget $verb @common --scope user
    if ($LASTEXITCODE -ne 0) {
        # パッケージがユーザー範囲のインストーラーを提供していない場合は既定の範囲で再試行する
        # (この場合は UAC の確認が表示されることがある)
        Write-Warning "ユーザー範囲での導入に失敗しました (終了コード $LASTEXITCODE)。既定の範囲で再試行します。UAC の確認が出たら許可してください"
        & $winget $verb @common
    }
    Update-SweepPath
    $nodeVer = Get-NodeVersion
    if (-not $nodeVer -or $nodeVer -lt $MinNode) {
        throw "Node.js $MinNode 以上を確認できませんでした (現在: $(if ($nodeVer) { $nodeVer } else { 'なし' }))。新しい PowerShell を開いて再実行するか、https://nodejs.org/ から手動で入れてください"
    }
    Write-Host "Node.js $nodeVer を導入しました"
}

# ---------------------------------------------------------------------------
Write-Step 'npm ci (依存関係)'
$npm = Get-SweepNpm
Invoke-Native $npm @('ci', '--no-audit', '--no-fund') 'npm ci'

if (-not $SkipBrowser) {
    Write-Step 'Playwright の Chromium'
    $npx = Get-SweepCommandPath 'npx.cmd'
    if (-not $npx) { throw 'npx が見つかりません' }
    Invoke-Native $npx @('playwright', 'install', 'chromium') 'Chromium のダウンロード'
}

# ---------------------------------------------------------------------------
Write-Step 'データ用フォルダ'
foreach ($d in @($SweepDataDir, $SweepLogDir, (Join-Path $SweepDataDir 'screenshots'))) { New-SweepDirectory $d }
Write-Host $SweepDataDir

# ---------------------------------------------------------------------------
Write-Step '環境変数ファイル .env'
function New-SweepToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
}

$example = Join-Path $SweepRoot '.env.example'
if (-not (Test-Path -LiteralPath $SweepEnvFile)) {
    $lines = [System.IO.File]::ReadAllLines($example, $Utf8NoBom)
    $token = New-SweepToken
    $lines = $lines | ForEach-Object { if ($_ -match '^[ \t]*SWEEP_MCP_TOKEN[ \t]*=') { "SWEEP_MCP_TOKEN=$token" } else { $_ } }
    [System.IO.File]::WriteAllText($SweepEnvFile, (($lines -join "`r`n") + "`r`n"), $Utf8NoBom)
    Write-Host ".env を作成し、SWEEP_MCP_TOKEN を新規生成しました: $SweepEnvFile"
} else {
    # 既存の .env は上書きしない。ただしトークンが未生成 (例の値のまま / 空) なら生成する
    $content = [System.IO.File]::ReadAllText($SweepEnvFile, $Utf8NoBom)
    if ($content -match '(?m)^[ \t]*SWEEP_MCP_TOKEN[ \t]*=[ \t]*(change-me[^\r\n]*)?[ \t]*\r?$') {
        $token = New-SweepToken
        $content = [regex]::Replace($content, '(?m)^[ \t]*SWEEP_MCP_TOKEN[ \t]*=[^\r\n]*', "SWEEP_MCP_TOKEN=$token")
        [System.IO.File]::WriteAllText($SweepEnvFile, $content, $Utf8NoBom)
        Write-Host '既存の .env のトークンが未設定だったため生成しました'
    } elseif ($content -notmatch '(?m)^[ \t]*SWEEP_MCP_TOKEN[ \t]*=') {
        $token = New-SweepToken
        [System.IO.File]::AppendAllText($SweepEnvFile, "`r`nSWEEP_MCP_TOKEN=$token`r`n", $Utf8NoBom)
        Write-Host '既存の .env に SWEEP_MCP_TOKEN を追記しました'
    } else {
        Write-Host '既存の .env を使います (上書きしません)'
    }
}
Write-Host 'トークンの確認: Select-String -Path .env -Pattern SWEEP_MCP_TOKEN (他人に見せないこと)'

# ---------------------------------------------------------------------------
Write-Step 'プロフィール profile.json'
$profilePath = Get-SweepSetting 'SWEEP_PROFILE' './profile.json'
if (-not [System.IO.Path]::IsPathRooted($profilePath)) { $profilePath = Join-Path $SweepRoot $profilePath }
$profilePath = [System.IO.Path]::GetFullPath($profilePath)
if (-not (Test-Path -LiteralPath $profilePath)) {
    New-SweepDirectory (Split-Path -Parent $profilePath)
    Copy-Item -LiteralPath (Join-Path $SweepRoot 'profile.example.json') -Destination $profilePath
    Write-Warning "profile.json をひな形から作成しました。自分の情報に書き換えてください: $profilePath"
    Write-Host "  例: notepad `"$profilePath`"  (UTF-8 で保存。Muse から update_profile で登録しても可)"
} else {
    Write-Host "既存の $profilePath を使います"
}

Write-Step '完了'
Write-Host '次の手順:'
Write-Host '  1. profile.json を編集'
Write-Host '  2. MCP の起動確認: powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\start-mcp.ps1 -Once'
Write-Host '     別ウィンドウで: Invoke-RestMethod http://127.0.0.1:8787/healthz   (→ ok)'
Write-Host '  3. タスク登録: powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\register-tasks.ps1'
Write-Host '  詳しくは README の「Windows PC で運用する」を参照'
