# dsh-vision-bridge installer — repository convenience wrapper.
# NOT a release asset. This wrapper exists only for clone/repository users:
# it locates Node, verifies the built installer exists, and forwards every
# argument to it. All installer logic lives in dist-installer/setup.mjs.
#
# Build the installer first:
#   node scripts\installer\build.mjs
# Then run:
#   .\scripts\setup.ps1 --what-if --profile work --upstream-provider a --vision-provider b --vision-model c

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $SetupArgs
)

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error 'node was not found on PATH. Node.js 22.19 or newer is required.'
    exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$setup = Join-Path $repoRoot 'dist-installer\setup.mjs'
if (-not (Test-Path $setup)) {
    Write-Error "dist-installer\setup.mjs was not found. Build it first: node scripts\installer\build.mjs"
    exit 1
}

& node $setup @SetupArgs
exit $LASTEXITCODE
