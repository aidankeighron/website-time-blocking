# build.ps1 - Build Chrome and Firefox extension zips
# Chrome zip  → one level up from this dir, wraps the project folder
# Firefox zip → inside this dir, zips contents with Firefox manifest as manifest.json

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectDir = $PSScriptRoot
$parentDir  = Split-Path $projectDir -Parent
$version    = (Get-Content "$projectDir\manifest.json" | ConvertFrom-Json).version

$chromeZip  = "$parentDir\wtb-chrome-v$version.zip"
$firefoxZip = "$projectDir\wtb-firefox-v$version.zip"

$excludeDirs = @('node_modules', '.git', 'playwright-report', 'test-results', 'tests', '.claude')

function Get-ExtFiles($sourceDir) {
    Get-ChildItem -Path $sourceDir -Recurse -File | Where-Object {
        $rel   = $_.FullName.Substring($sourceDir.Length).TrimStart('\','/')
        $parts = $rel -split '[/\\]'
        $parts[0] -notin $excludeDirs -and
        $parts[-1] -notlike 'wtb-chrome-v*.zip' -and
        $parts[-1] -notlike 'wtb-firefox-v*.zip'
    }
}

# Write a zip using forward-slash entry paths (required by Firefox AMO and the ZIP spec)
function Write-Zip($zipPath, $files, $sourceDir, $entryPrefix) {
    $stream  = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
    $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($f in $files) {
            $rel       = $f.FullName.Substring($sourceDir.Length).TrimStart('\','/')
            $entryName = ($entryPrefix + $rel) -replace '\\','/'
            $entry     = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            $fileStream  = [System.IO.File]::OpenRead($f.FullName)
            $fileStream.CopyTo($entryStream)
            $fileStream.Dispose()
            $entryStream.Dispose()
        }
    } finally {
        $archive.Dispose()
        $stream.Dispose()
    }
}

# ── Chrome ────────────────────────────────────────────────────────────────────
Write-Host "Building Chrome zip (v$version)..."
if (Test-Path $chromeZip) { Remove-Item $chromeZip -Force }

$tmpChromeRoot = "$env:TEMP\wtb-chrome-build"
$tmpChrome     = "$tmpChromeRoot\website-time-blocking"
if (Test-Path $tmpChromeRoot) { Remove-Item $tmpChromeRoot -Recurse -Force }
New-Item -ItemType Directory -Path $tmpChrome -Force | Out-Null

foreach ($f in (Get-ExtFiles $projectDir)) {
    $rel  = $f.FullName.Substring($projectDir.Length).TrimStart('\','/')
    $dest = "$tmpChrome\$rel"
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Copy-Item $f.FullName $dest
}

# Prefix "website-time-blocking/" so the folder appears at the zip root
Write-Zip -zipPath $chromeZip -files (Get-ChildItem $tmpChrome -Recurse -File) -sourceDir $tmpChrome -entryPrefix 'website-time-blocking/'
Remove-Item $tmpChromeRoot -Recurse -Force
Write-Host "  -> $chromeZip"

# ── Firefox ───────────────────────────────────────────────────────────────────
Write-Host "Building Firefox zip (v$version)..."
if (Test-Path $firefoxZip) { Remove-Item $firefoxZip -Force }

$tmpFirefox = "$env:TEMP\wtb-firefox-build"
if (Test-Path $tmpFirefox) { Remove-Item $tmpFirefox -Recurse -Force }
New-Item -ItemType Directory -Path $tmpFirefox -Force | Out-Null

foreach ($f in (Get-ExtFiles $projectDir)) {
    $rel = $f.FullName.Substring($projectDir.Length).TrimStart('\','/')
    if ($rel -eq 'manifest.json') { continue }   # drop Chrome manifest
    $dest = "$tmpFirefox\$rel"
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Copy-Item $f.FullName $dest
}

# Promote Firefox manifest
Rename-Item "$tmpFirefox\manifest-firefox.json" 'manifest.json'

# No prefix — files sit at zip root
Write-Zip -zipPath $firefoxZip -files (Get-ChildItem $tmpFirefox -Recurse -File) -sourceDir $tmpFirefox -entryPrefix ''
Remove-Item $tmpFirefox -Recurse -Force
Write-Host "  -> $firefoxZip"

Write-Host "Done. v$version"
