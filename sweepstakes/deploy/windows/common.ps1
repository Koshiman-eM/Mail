# 懸賞ツール Windows 用スクリプトの共通処理 (各スクリプトから dot-source する)
# PowerShell 5.1 / 7 の両方で動くように書いている。このファイルは UTF-8 (BOM 付き) で保存すること。

Set-StrictMode -Version 2.0

# sweepstakes ディレクトリ (このファイルは sweepstakes\deploy\windows にある)
$script:SweepRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:SweepDataDir = Join-Path $script:SweepRoot 'data'
$script:SweepLogDir = Join-Path $script:SweepDataDir 'logs'
$script:SweepEnvFile = Join-Path $script:SweepRoot '.env'
# CLI の終了コード: 他の処理 (定期実行 / MCP のジョブ) が収集・応募中 (src/cli.ts の EXIT_LOCK_BUSY)
$script:ExitLockBusy = 75
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Initialize-SweepConsole {
    # Node の出力 (UTF-8) を正しく読み取るため。PowerShell 5.1 の既定 (cp932) だと文字化けする
    try { [Console]::OutputEncoding = $script:Utf8NoBom } catch { }
    $global:OutputEncoding = $script:Utf8NoBom
}

function New-SweepDirectory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

# ログに 1 行追記する (UTF-8 BOM なし。PowerShell のバージョンで文字コードが変わらないよう .NET で書く)
function Write-SweepLog {
    param([Parameter(Mandatory)][string]$LogFile, [AllowEmptyString()][string]$Message, [switch]$Raw, [switch]$Quiet)
    $line = if ($Raw) { $Message } else { '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message }
    New-SweepDirectory (Split-Path -Parent $LogFile)
    [System.IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, $script:Utf8NoBom)
    if (-not $Quiet) { Write-Host $line }
}

# ログファイルが大きくなりすぎたら .1 に退避する
function Limit-SweepLog([string]$LogFile, [long]$MaxBytes = 10MB) {
    if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt $MaxBytes)) {
        Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.1') -Force
    }
}

# .env を読む (KEY=VALUE。# から始まる行と空行は無視。値を囲む ' / " は外す)
function Read-SweepDotEnv([string]$Path = $script:SweepEnvFile) {
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in [System.IO.File]::ReadAllLines($Path, $script:Utf8NoBom)) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        if ($t.StartsWith('export ')) { $t = $t.Substring(7).Trim() }
        $i = $t.IndexOf('=')
        if ($i -lt 1) { continue }
        $k = $t.Substring(0, $i).Trim().TrimStart([char]0xFEFF)
        $v = $t.Substring($i + 1).Trim()
        if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        $map[$k] = $v
    }
    return $map
}

# 設定値: OS の環境変数 → .env → 既定値 の順 (Node の --env-file-if-exists と同じ優先順位)
function Get-SweepSetting([string]$Name, [string]$Default = '') {
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ($null -ne $v -and $v -ne '') { return $v }
    $envMap = Read-SweepDotEnv
    if ($envMap.ContainsKey($Name) -and $envMap[$Name] -ne '') { return $envMap[$Name] }
    return $Default
}

# winget などで PATH が変わった直後でも見つけられるよう、レジストリの PATH を読み直す
function Update-SweepPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Get-SweepCommandPath([string]$Name) {
    $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

# npm は npm.ps1 ではなく npm.cmd を使う (npm.ps1 は実行ポリシーの影響を受け、-- の扱いも異なるため)
function Get-SweepNpm {
    $npm = Get-SweepCommandPath 'npm.cmd'
    if (-not $npm) { throw 'npm が見つかりません。deploy\windows\setup.ps1 を先に実行してください' }
    return $npm
}

# npm run <script> -- <args> を実行し、標準出力・標準エラーをログに追記する。終了コードを返す
function Invoke-SweepNpmScript {
    param([Parameter(Mandatory)][string]$Script, [string[]]$Arguments = @(), [Parameter(Mandatory)][string]$LogFile)
    $npm = Get-SweepNpm
    # '--' を文字列として配列で渡す (PowerShell のパラメーター終端として解釈させない)
    $all = @('run', $Script, '--') + $Arguments
    $prev = $ErrorActionPreference
    # 5.1 では Stop のままだと標準エラーの 1 行目で例外になるため一時的に Continue にする
    $ErrorActionPreference = 'Continue'
    try {
        Push-Location -LiteralPath $script:SweepRoot
        & $npm @all 2>&1 | ForEach-Object { Write-SweepLog -LogFile $LogFile -Message ($_.ToString()) -Raw }
        return [int]$LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $prev
    }
}

# 指定ポートを LISTEN しているプロセス (なければ $null)
function Get-SweepPortOwner([int]$Port) {
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($c) {
            $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
            if ($p) { return '{0} (pid {1})' -f $p.ProcessName, $p.Id }
            return 'pid {0}' -f $c.OwningProcess
        }
    } catch { }
    return $null
}
