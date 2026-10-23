#Requires -Version 5.1
[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'portable.ps1') -Library
. (Join-Path $PSScriptRoot 'release-layout.ps1')
$sourceRoot = Get-DesktopControlAbsolutePath (Split-Path -Parent $PSScriptRoot)
if (-not $OutputDirectory) { $OutputDirectory = Split-Path -Parent $sourceRoot }
$outputRoot = Get-DesktopControlAbsolutePath $OutputDirectory
if ($outputRoot.Equals($sourceRoot, [StringComparison]::OrdinalIgnoreCase) -or $outputRoot.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Release output must be outside the source directory.' }
$manifest = Read-DesktopControlJson (Join-Path $sourceRoot 'package.json')
if ($manifest.name -ne 'dsh-desktop-control' -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid release name/version.' }
$null = Assert-DesktopControlPluginSource ([pscustomobject]@{Source=$sourceRoot;InstallDir=(Join-Path ([IO.Path]::GetTempPath()) ('dsh-package-not-installed-' + [Guid]::NewGuid().ToString('N')))})
$actualRuntimeFiles = @()
foreach ($topLevel in $script:DesktopControlPayloadNames) {
    foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $sourceRoot $topLevel) -File -Recurse -Force)) { $actualRuntimeFiles += $file.FullName.Substring($sourceRoot.Length + 1).Replace('\','/') }
}
if (@(Compare-Object ($actualRuntimeFiles | Sort-Object) ($script:DesktopControlReleaseFiles | Sort-Object)).Count) { throw 'Runtime files differ from the explicit release allowlist. Review the layout before packaging.' }
foreach ($declared in @($manifest.files)) { if ($script:DesktopControlPayloadNames -notcontains $declared) { throw ('Unexpected package.files entry: ' + $declared) } }
foreach ($required in $script:DesktopControlPayloadNames) { if (@($manifest.files) -notcontains $required -and $required -ne 'package.json') { throw ('Missing package.files entry: ' + $required) } }
$recordsRoot = Join-Path (Split-Path -Parent $sourceRoot) ((Split-Path -Leaf $sourceRoot) + '-local-records')
Assert-DesktopControlNoLinkedAncestors $recordsRoot (Split-Path -Parent $sourceRoot)
New-Item -ItemType Directory -Path $recordsRoot -Force | Out-Null
$stage = Assert-DesktopControlChildPath (Join-Path $recordsRoot ('package-stage-' + [Guid]::NewGuid().ToString('N'))) $recordsRoot
New-Item -ItemType Directory -Path $stage | Out-Null
$zipPath = Join-Path $outputRoot ($manifest.name + '-' + $manifest.version + '-win-x64.zip')
$sidecar = $zipPath + '.sha256.txt'
$createdArchive = $false
try {
    if ((Test-Path -LiteralPath $zipPath) -or (Test-Path -LiteralPath $sidecar)) { throw ('Release already exists; use a new output directory/version: ' + $zipPath) }
    foreach ($relative in $script:DesktopControlReleaseFiles) {
        $sourceFile = Assert-DesktopControlChildPath (Join-Path $sourceRoot $relative) $sourceRoot
        Assert-DesktopControlNoLinkedAncestors $sourceFile $sourceRoot
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw ('Missing release file: ' + $relative) }
        $destination = Join-Path $stage ('plugin/' + $relative)
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $sourceFile -Destination $destination
    }
    New-Item -ItemType Directory -Path (Join-Path $stage 'tools') | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable.ps1') -Destination (Join-Path $stage 'tools/portable.ps1')
    foreach ($name in $script:DesktopControlDeliveryFiles) {
        $sourceFile = Join-Path $sourceRoot ('delivery/' + $name)
        Assert-DesktopControlNoLinkedAncestors $sourceFile $sourceRoot
        if ($name.EndsWith('.cmd')) {
            $bytes = [IO.File]::ReadAllBytes($sourceFile)
            if (@($bytes | Where-Object { $_ -gt 127 }).Count) { throw 'CMD launchers must use ASCII.' }
            $content = [Text.Encoding]::ASCII.GetString($bytes).Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd("`n").Replace("`n", "`r`n") + "`r`n"
            [IO.File]::WriteAllText((Join-Path $stage $name), $content, [Text.Encoding]::ASCII)
        } else { Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $stage $name) }
    }
    $hashLines = @($script:DesktopControlZipFiles | Sort-Object | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $stage $_) -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $_ })
    Write-DesktopControlUtf8 (Join-Path $stage 'SHA256SUMS.txt') (($hashLines -join "`n") + "`n")
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $createdArchive = $true
    try {
        $zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($name in @($script:DesktopControlZipFiles) + @('SHA256SUMS.txt')) {
                $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $stage $name), $name, [IO.Compression.CompressionLevel]::Optimal)
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-DesktopControlUtf8 $sidecar ($hash + '  ' + [IO.Path]::GetFileName($zipPath) + "`n")
    & (Join-Path $PSScriptRoot 'verify-release.ps1') -ZipPath $zipPath
    [pscustomobject]@{PackagePath=$zipPath;Bytes=(Get-Item -LiteralPath $zipPath).Length;Sha256=$hash;Sidecar=$sidecar}
} catch {
    # Remove only the newly created output, never an earlier release.
    if ($createdArchive) {
        if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
        if (Test-Path -LiteralPath $sidecar) { Remove-Item -LiteralPath $sidecar -Force }
    }
    throw
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-DesktopControlOwnedDirectory $stage $recordsRoot }
}
