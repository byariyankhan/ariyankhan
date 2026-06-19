<#
.SYNOPSIS
    Deploy ariyankhan.com to the live FTP server.

.DESCRIPTION
    Reads FTP credentials from .env and uploads files via FTPS (TLS).
    Skips deploy/config files automatically.

.PARAMETER Files
    One or more relative file paths to upload. Omit to upload everything.

.PARAMETER DryRun
    Preview which files would be uploaded without actually uploading.

.EXAMPLE
    .\deploy.ps1                            # deploy all site files
    .\deploy.ps1 index.html                 # deploy one file
    .\deploy.ps1 index.html js\site-footer.js   # deploy multiple files
    .\deploy.ps1 -DryRun                    # preview only
#>
param(
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$Files,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Colour helpers ────────────────────────────────────────────────────────────
function Write-Ok   ($m) { Write-Host "  v $m" -ForegroundColor Green }
function Write-Skip ($m) { Write-Host "  - $m" -ForegroundColor DarkGray }
function Write-Fail ($m) { Write-Host "  x $m" -ForegroundColor Red }

# ── Load .env ─────────────────────────────────────────────────────────────────
$envFile = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: .env not found. Copy .env.example to .env and add your credentials." -ForegroundColor Red
    exit 1
}
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*(#|$)') { continue }
    $k, $v = $line -split '=', 2
    Set-Variable -Name $k.Trim() -Value $v.Trim() -Scope Script
}

# ── Skip list (never uploaded to the server) ──────────────────────────────────
$SKIP = @('deploy.ps1','deploy.sh','.env','.env.example','.gitignore',
          'ftp_download.ps1','.git','.claude','.deploy-cache','.DS_Store','Thumbs.db',
          'mail-config.local.php')

# ── Resolve target files ──────────────────────────────────────────────────────
if ($Files -and $Files.Count -gt 0) {
    $targets = $Files | ForEach-Object {
        $full = Join-Path $PSScriptRoot ($_ -replace '/', '\')
        if (-not (Test-Path $full)) { Write-Fail "Not found: $_"; exit 1 }
        Get-Item $full
    }
} else {
    $targets = Get-ChildItem -Path $PSScriptRoot -Recurse -File | Where-Object {
        $rel = $_.FullName.Substring($PSScriptRoot.Length).TrimStart('\/')
        $top = ($rel -split '[/\\]')[0]
        ($top -notin $SKIP) -and ($_.Name -notin $SKIP)
    }
}

# ── Deploy ────────────────────────────────────────────────────────────────────
$ok = 0; $fail = 0

Write-Host ""
Write-Host "  ariyankhan.com$(if ($DryRun) { ' [DRY RUN]' })" -ForegroundColor Yellow
Write-Host "  $FTP_HOST$FTP_REMOTE_DIR" -ForegroundColor DarkGray
Write-Host ""

foreach ($file in $targets) {
    $rel       = $file.FullName.Substring($PSScriptRoot.Length).TrimStart('\/').Replace('\', '/')
    $remoteUrl = "ftp://${FTP_HOST}${FTP_REMOTE_DIR}/${rel}"

    if ($DryRun) { Write-Skip $rel; continue }

    $out = & curl -s -S --ftp-ssl -k --ftp-create-dirs `
        -u "${FTP_USER}:${FTP_PASS}" `
        -T $file.FullName `
        $remoteUrl 2>&1

    if ($LASTEXITCODE -eq 0) { Write-Ok $rel; $ok++ }
    else                     { Write-Fail "$rel  ($out)"; $fail++ }
}

Write-Host ""
if ($DryRun) {
    Write-Host "  Dry run: $($targets.Count) file(s) would be uploaded." -ForegroundColor Yellow
} elseif ($fail -gt 0) {
    Write-Host "  Done: $ok uploaded, $fail failed." -ForegroundColor Red
} else {
    Write-Host "  Done: $ok file(s) uploaded." -ForegroundColor Green
}
Write-Host ""
