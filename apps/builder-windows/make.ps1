#!/usr/bin/env pwsh
# Build, test, and publish the Flagship Studio Windows GUI.
#
# Usage:
#   .\make.ps1 build       # dotnet build (Debug, fast iteration)
#   .\make.ps1 test        # dotnet test (xunit; cross-platform — runs on macOS too)
#   .\make.ps1 publish     # self-contained win-x64 release build
#   .\make.ps1 sign        # placeholder; signtool wiring below
#   .\make.ps1 clean       # delete bin/ + obj/
#
# Defaults: build + test in one go.

param(
    [string]$Target = "all"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

function Invoke-Build {
    Write-Host "==> dotnet build (Debug)" -ForegroundColor Cyan
    & dotnet build "$ScriptDir/FlagshipBuilder.csproj"
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
}

function Invoke-Test {
    Write-Host "==> dotnet test" -ForegroundColor Cyan
    & dotnet test "$ScriptDir/tests/FlagshipBuilder.Tests.csproj" --logger "console;verbosity=normal"
    if ($LASTEXITCODE -ne 0) { throw "tests failed" }
}

function Invoke-Publish {
    Write-Host "==> dotnet publish (Release, win-x64, self-contained)" -ForegroundColor Cyan
    & dotnet publish "$ScriptDir/FlagshipBuilder.csproj" `
        -c Release `
        -r win-x64 `
        --self-contained true `
        -p:PublishSingleFile=true `
        -p:PublishReadyToRun=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -o "$ScriptDir/dist"
    if ($LASTEXITCODE -ne 0) { throw "publish failed" }
    Write-Host "==> built: $ScriptDir/dist/FlagshipBuilder.exe" -ForegroundColor Green
}

function Invoke-Sign {
    # Placeholder. To sign for real:
    #   - Acquire an EV or OV code-signing cert
    #   - Set $env:FLAGSHIP_SIGN_CERT_THUMBPRINT to the cert's SHA1 thumbprint
    #   - Install Windows SDK (signtool.exe ships there)
    if (-not $env:FLAGSHIP_SIGN_CERT_THUMBPRINT) {
        Write-Warning "FLAGSHIP_SIGN_CERT_THUMBPRINT not set; skipping signtool"
        return
    }
    $exe = "$ScriptDir/dist/FlagshipBuilder.exe"
    if (-not (Test-Path $exe)) { throw "no exe at $exe; run 'make.ps1 publish' first" }
    Write-Host "==> signtool sign /sha1 $($env:FLAGSHIP_SIGN_CERT_THUMBPRINT) $exe" -ForegroundColor Cyan
    & signtool.exe sign /sha1 $env:FLAGSHIP_SIGN_CERT_THUMBPRINT /fd SHA256 `
        /tr http://timestamp.digicert.com /td SHA256 $exe
    if ($LASTEXITCODE -ne 0) { throw "signtool failed" }
}

function Invoke-Clean {
    Write-Host "==> clean" -ForegroundColor Cyan
    Remove-Item -Recurse -Force "$ScriptDir/bin", "$ScriptDir/obj",
        "$ScriptDir/tests/bin", "$ScriptDir/tests/obj",
        "$ScriptDir/dist" -ErrorAction SilentlyContinue
}

switch ($Target) {
    "build"   { Invoke-Build }
    "test"    { Invoke-Test }
    "publish" { Invoke-Publish }
    "sign"    { Invoke-Sign }
    "clean"   { Invoke-Clean }
    "all"     { Invoke-Build; Invoke-Test }
    default   { throw "unknown target: $Target (try build|test|publish|sign|clean|all)" }
}
