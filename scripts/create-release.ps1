<#
.SYNOPSIS
Cut a new Axeno desktop release in one shot.

.DESCRIPTION
  .\scripts\create-release.ps1 0.2.0

Sets the version everywhere, commits the bump, creates the v<version> tag,
and pushes the branch + tag to origin. Pushing the tag triggers the GitHub
release workflow, which builds the signed bundles into a DRAFT release for
you to review and publish.

Version is set in:
  - package.json + package-lock.json   (npm version)
  - src-tauri/tauri.conf.json          (the version the bundler and updater use)
  - src-tauri/Cargo.toml + Cargo.lock

The tag must match the version set here: the release workflow builds whatever
is in the files, and the in-app updater compares versions by semver.

Assumptions: the local checkout is already synced with origin and the working
tree is clean. Pass -Yes to skip the confirmation prompt.

.PARAMETER Version
The semver version to release (e.g. 0.2.0).

.PARAMETER Yes
Skip the confirmation prompt.
#>
param(
    [Parameter(Position = 0)]
    [string]$Version,
    [Alias('y')]
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
Set-Location "$PSScriptRoot\.."

function Fail([string]$msg) {
    Write-Host "error: $msg" -ForegroundColor Red
    exit 1
}

if (-not $Version) {
    Write-Host "usage: .\scripts\create-release.ps1 <version> [-Yes]   (e.g. .\scripts\create-release.ps1 0.2.0)"
    exit 1
}
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') {
    Fail "'$Version' is not a valid semver version"
}
if ($Version -match '-') {
    Write-Host "WARN: '$Version' is a prerelease. Semver orders it BEFORE the bare version" -ForegroundColor Yellow
    Write-Host "WARN: (0.2.0-beta < 0.2.0), which is what the in-app updater compares by." -ForegroundColor Yellow
}

$tag = "v$Version"

# ── Pre-flight git checks ──────────────────────────────────────────────────
git rev-parse --git-dir 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "not inside a git repository" }

$branch = (git rev-parse --abbrev-ref HEAD).Trim()

if (git status --porcelain) {
    Fail "working tree is not clean. Commit, stash, or discard changes first.`n       This script commits only the version bump, so the tree must start clean."
}

git rev-parse -q --verify "refs/tags/$tag" 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Fail "tag $tag already exists locally. Pick a new version or delete the tag."
}

git ls-remote --exit-code --tags origin "refs/tags/$tag" 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Fail "tag $tag already exists on origin. Pick a new version."
}

Write-Host "About to release ${tag}:"
Write-Host "  - set version to $Version in the project files"
Write-Host "  - commit the bump on branch '$branch'"
Write-Host "  - create annotated tag $tag"
Write-Host "  - push '$branch' and $tag to origin (this triggers the release build)"
Write-Host ""

if (-not $Yes) {
    $reply = Read-Host "Proceed? [y/N]"
    if ($reply -notmatch '^[yY]([eE][sS])?$') {
        Write-Host "aborted."
        exit 1
    }
}

Write-Host "==> package.json + package-lock.json"
npm version $Version --no-git-tag-version --allow-same-version | Out-Null

Write-Host "==> src-tauri/tauri.conf.json"
# Use node (not ConvertTo-Json) to preserve key order and formatting, mirroring
# the .sh script. With `node -e`, process.argv[1] is the first passed argument.
$nodeScript = @'
const fs = require("fs");
const path = "src-tauri/tauri.conf.json";
const conf = JSON.parse(fs.readFileSync(path, "utf8"));
conf.version = process.argv[1];
fs.writeFileSync(path, JSON.stringify(conf, null, 2) + "\n");
'@
node -e $nodeScript $Version
if ($LASTEXITCODE -ne 0) { Fail "node failed to update src-tauri/tauri.conf.json" }

Write-Host "==> src-tauri/Cargo.toml + Cargo.lock"
$cargoContent = Get-Content -LiteralPath src-tauri\Cargo.toml -Raw
$cargoContent = [System.Text.RegularExpressions.Regex]::new('(?m)^version = "[^"]*"').Replace($cargoContent, "version = `"$Version`"", 1)
[System.IO.File]::WriteAllText((Get-Item src-tauri\Cargo.toml).FullName, $cargoContent)
Push-Location src-tauri
cargo update --package axeno-client --offline --quiet
Pop-Location

Write-Host "==> committing version bump"
git add -A
git diff --cached --quiet 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "    (files already at $Version; tagging the current commit)"
} else {
    git commit -m "release $tag" | Out-Null
}

Write-Host "==> creating tag $tag"
git tag -a $tag -m "Axeno desktop $tag"

Write-Host "==> pushing branch '$branch' and tag $tag"
git push origin $branch
git push origin $tag

Write-Host ""
Write-Host "Done. $tag is pushed; the release workflow is building."
Write-Host "It publishes a DRAFT release — review and publish it to ship the update:"
Write-Host "  https://github.com/axenochat/axeno-desktop/releases"
