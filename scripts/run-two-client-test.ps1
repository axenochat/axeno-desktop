#!/usr/bin/env pwsh
#Requires -Version 7.0

# Axeno local two-client test harness (Windows / PowerShell port).
#
# Run it from the desktop client repo (this script lives in axeno-desktop/). It
# spins up two Tauri dev clients side by side so you can pair them and message.
# Both clients use the official relay that a fresh install defaults to, so no
# local relay is started.
#
# It will:
#   1. Copy axeno-desktop -> axeno-desktop2 (client B), preserving its deps/build
#   2. Patch client B to a second bundle identifier, Vite port, and window title
#   3. With -Reset, wipe both clients' app data first for a clean identity;
#      by default the existing data (identities, contacts) is kept
#   4. npm install in both clients
#   5. Launch both Tauri dev clients, each in its own terminal window
#
# Flags:
#   -Reset   wipe both clients' app data before running (default: keep it)

[CmdletBinding()]
param(
    [switch]$Reset,
    [Alias('h')]
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Help) {
    # Print the descriptive comment block (mirrors the bash --help behaviour).
    Get-Content -LiteralPath $PSCommandPath |
        Select-Object -Skip 3 -First 17 |
        ForEach-Object { $_ -replace '^# ?', '' }
    exit 0
}

$SCRIPT_DIR = Split-Path -Parent $PSCommandPath
$REPO_ROOT  = (Resolve-Path (Join-Path $SCRIPT_DIR '..')).Path

$CLIENT_A = $REPO_ROOT
$CLIENT_B = Join-Path (Split-Path -Parent $REPO_ROOT) 'axeno-desktop2'

$PORT_A = '1420'
$PORT_B = '1421'

function Write-Log  { param([string]$Message) Write-Host "[axeno-test] $Message" -ForegroundColor Cyan }
function Write-Warn { param([string]$Message) Write-Host "[axeno-test warning] $Message" -ForegroundColor Yellow }
function Stop-Fail  { param([string]$Message) Write-Host "[axeno-test error] $Message" -ForegroundColor Red; exit 1 }

function Test-Dir { param([string]$Path) if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Stop-Fail "Missing directory: $Path" } }
function Test-Cmd { param([string]$Name) if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Stop-Fail "Missing command: $Name" } }

Test-Dir (Join-Path $CLIENT_A 'src-tauri')
Test-Cmd npm
Test-Cmd cargo   # tauri dev compiles the Rust backend

# Read the bundle identifier from tauri.conf.json so the app-data paths and the
# client B patch stay correct even if the identifier changes. Client B gets the
# same identifier with a "2" suffix so the two clients use separate app data.
$confPathA = Join-Path $CLIENT_A 'src-tauri\tauri.conf.json'
try {
    $APP_ID_A = (Get-Content -Raw -LiteralPath $confPathA | ConvertFrom-Json).identifier
} catch {
    $APP_ID_A = $null
}
if ([string]::IsNullOrWhiteSpace($APP_ID_A)) { $APP_ID_A = 'chat.axeno.desktop' }
$APP_ID_B = "${APP_ID_A}2"

# Tauri's app_data_dir / app_config_dir on Windows are both
# %APPDATA%\<identifier> (C:\Users\<user>\AppData\Roaming\<identifier>). The
# vault, message store, and unified state all live under app_data_dir.
$DATA_A = Join-Path $env:APPDATA $APP_ID_A; $CONF_A = $DATA_A
$DATA_B = Join-Path $env:APPDATA $APP_ID_B; $CONF_B = $DATA_B

if ($Reset) {
    Write-Log "Reset: wiping both clients' app data"
    foreach ($p in @($DATA_A, $CONF_A, $DATA_B, $CONF_B)) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
    }
} else {
    Write-Log "Keeping existing client app data (use -Reset to wipe)"
}

Write-Log "Syncing $CLIENT_A -> $CLIENT_B (preserving its node_modules/target)"
if (-not (Test-Path -LiteralPath $CLIENT_B)) { New-Item -ItemType Directory -Path $CLIENT_B | Out-Null }

if (Get-Command robocopy -ErrorAction SilentlyContinue) {
    # robocopy /MIR mirrors A into B (deleting files removed from A). The /XD
    # exclusions keep B's compiled output and dependencies for reuse across runs.
    # robocopy exit codes 0-7 are success; 8+ are real errors.
    robocopy $CLIENT_A $CLIENT_B /MIR /XD node_modules dist target .git /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Stop-Fail "robocopy failed with exit code $LASTEXITCODE" }
    $global:LASTEXITCODE = 0
} else {
    Write-Warn "robocopy not found; falling back to Copy-Item (will not delete removed files)"
    foreach ($sub in @('src', 'src-tauri')) {
        $src = Join-Path $CLIENT_A $sub
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $CLIENT_B -Recurse -Force }
    }
    Get-ChildItem -LiteralPath $CLIENT_A -File | Copy-Item -Destination $CLIENT_B -Force
    $viteCache = Join-Path $CLIENT_B 'node_modules\.vite'
    if (Test-Path -LiteralPath $viteCache) { Remove-Item -LiteralPath $viteCache -Recurse -Force }
}

Write-Log "Patching client B (identifier $APP_ID_B, Vite port $PORT_B)"

$packagePath = Join-Path $CLIENT_B 'package.json'
$configPath  = Join-Path $CLIENT_B 'src-tauri\tauri.conf.json'

# package.json: point the dev script at client B's Vite port.
$pkg = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
if (-not $pkg.PSObject.Properties['scripts']) {
    $pkg | Add-Member -NotePropertyName scripts -NotePropertyValue ([pscustomobject]@{})
}
if ($pkg.scripts.PSObject.Properties['dev']) {
    $pkg.scripts.dev = "vite --port $PORT_B"
} else {
    $pkg.scripts | Add-Member -NotePropertyName dev -NotePropertyValue "vite --port $PORT_B"
}
($pkg | ConvertTo-Json -Depth 100) + "`n" | Set-Content -LiteralPath $packagePath -NoNewline

# tauri.conf.json: second identifier, product/window title, dev URL, and CSP.
$conf = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json

function Set-JsonProp {
    param([object]$Object, [string]$Name, [object]$Value)
    if ($Object.PSObject.Properties[$Name]) { $Object.$Name = $Value }
    else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}
function Get-OrAddObject {
    param([object]$Object, [string]$Name)
    if (-not $Object.PSObject.Properties[$Name]) {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue ([pscustomobject]@{})
    }
    return $Object.$Name
}

Set-JsonProp $conf 'productName' 'Axeno 2'
Set-JsonProp $conf 'identifier'  $APP_ID_B

$build = Get-OrAddObject $conf 'build'
Set-JsonProp $build 'devUrl' "http://localhost:$PORT_B"

$app = Get-OrAddObject $conf 'app'
if (-not $app.PSObject.Properties['windows']) {
    $app | Add-Member -NotePropertyName windows -NotePropertyValue @()
}
if ($app.windows -and $app.windows.Count -gt 0) {
    Set-JsonProp $app.windows[0] 'title' 'Axeno 2'
}

# Keep the CSP connect-src aligned with client B's Vite port.
$security = Get-OrAddObject $app 'security'
if ($security.PSObject.Properties['csp'] -and $security.csp -is [pscustomobject]) {
    $csp = $security.csp
    $connectSrc = if ($csp.PSObject.Properties['connect-src']) { [string]$csp.'connect-src' } else { '' }
    foreach ($item in @("http://localhost:$PORT_B", "http://127.0.0.1:$PORT_B")) {
        if ($connectSrc -notmatch [regex]::Escape($item)) {
            $connectSrc = ("$connectSrc $item").Trim()
        }
    }
    Set-JsonProp $csp 'connect-src' $connectSrc
}

($conf | ConvertTo-Json -Depth 100) + "`n" | Set-Content -LiteralPath $configPath -NoNewline

Write-Log "Installing npm dependencies (client A)"
Push-Location $CLIENT_A; try { npm install } finally { Pop-Location }
Write-Log "Installing npm dependencies (client B)"
Push-Location $CLIENT_B; try { npm install } finally { Pop-Location }

foreach ($p in @($PORT_A, $PORT_B)) {
    $inUse = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue
    if ($inUse) {
        Write-Warn "Port $p is already in use. Free it first (e.g. find the PID with: Get-NetTCPConnection -LocalPort $p; then Stop-Process)."
    }
}

function Start-InTerminal {
    param([string]$Title, [string]$Dir, [string]$Command)

    # Launch a new console window that cd's into $Dir, runs $Command, then waits
    # so the window stays open after the dev client exits. The command is passed
    # as a Base64 -EncodedCommand so semicolons/quotes survive argument parsing.
    # We launch pwsh/powershell directly (not via `wt`, whose command-line parser
    # mangles titles with spaces and treats ';' as a tab delimiter); on Windows
    # 11 the new window is still hosted by Windows Terminal if it's the default.
    $inner = "Set-Location -LiteralPath '$Dir'; `$Host.UI.RawUI.WindowTitle = '$Title'; $Command; Write-Host ''; Read-Host '[axeno-test] $Title exited. Press Enter to close'"
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($inner))

    if (Get-Command pwsh -ErrorAction SilentlyContinue) {
        Start-Process pwsh -ArgumentList @('-NoExit', '-EncodedCommand', $encoded)
    } elseif (Get-Command powershell -ErrorAction SilentlyContinue) {
        Start-Process powershell -ArgumentList @('-NoExit', '-EncodedCommand', $encoded)
    } else {
        Write-Warn "No pwsh/powershell found; running '$Title' in the background, logging to $REPO_ROOT\$($Title -replace ' ', '_').log"
        $log = Join-Path $REPO_ROOT ("$($Title -replace ' ', '_').log")
        Start-Process powershell -ArgumentList @('-EncodedCommand', $encoded) -RedirectStandardOutput $log -RedirectStandardError $log -WindowStyle Hidden
    }
}

# WEBKIT_DISABLE_COMPOSITING_MODE is a Linux WebKitGTK workaround and is not
# needed on Windows (WebView2), so it is omitted here.
Write-Log "Starting client A (Vite port $PORT_A)"
Start-InTerminal 'Axeno Client A' $CLIENT_A 'npm run tauri dev'
Start-Sleep -Seconds 2

Write-Log "Starting client B (Vite port $PORT_B)"
Start-InTerminal 'Axeno Client B' $CLIENT_B 'npm run tauri dev'

Write-Host ""
Write-Log "Both clients are launching."
Write-Log "Client A app data: $DATA_A"
Write-Log "Client B app data: $DATA_B"
Write-Host @"

Next, in EACH client:
  1. Create an identity (display name + passphrase).
  2. Wait for Tor to connect (first launch takes a bit). Both clients use the
     official relay that a fresh install already has set as the default.
  3. In one client, open Add Contact and generate a connection code.
  4. Paste that code into the other client's Add Contact, then start messaging.
"@
