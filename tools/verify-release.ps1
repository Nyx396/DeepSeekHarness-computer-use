#Requires -Version 5.1
[CmdletBinding()]
param([string]$ZipPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-layout.ps1')
$sourceRoot = Split-Path -Parent $PSScriptRoot
$manifest = [IO.File]::ReadAllText((Join-Path $sourceRoot 'package.json')) | ConvertFrom-Json
if (-not $ZipPath) { $ZipPath = Join-Path (Split-Path -Parent $sourceRoot) ($manifest.name + '-' + $manifest.version + '-win-x64.zip') }
$ZipPath = [IO.Path]::GetFullPath($ZipPath)
$actualZipHash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$sidecar = [IO.File]::ReadAllText($ZipPath + '.sha256.txt').Trim()
if ($sidecar -ne ($actualZipHash + '  ' + [IO.Path]::GetFileName($ZipPath))) { throw 'External ZIP checksum mismatch.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
$checks = 1
try {
    $expected = @($script:DesktopControlZipFiles) + @('SHA256SUMS.txt')
    $names = @($zip.Entries | ForEach-Object { $_.FullName })
    if ($names.Count -ne $expected.Count -or @($names | Select-Object -Unique).Count -ne $names.Count) { throw 'ZIP entry count/uniqueness mismatch.' }
    foreach ($name in $names) { if ($expected -cnotcontains $name) { throw ('Unexpected ZIP member: ' + $name) } }
    $checks += $names.Count
    $reader = New-Object IO.StreamReader($zip.GetEntry('SHA256SUMS.txt').Open(), [Text.Encoding]::UTF8)
    try { $lines = @($reader.ReadToEnd() -split '\r?\n' | Where-Object { $_.Trim() }) } finally { $reader.Dispose() }
    if ($lines.Count -ne $script:DesktopControlZipFiles.Count) { throw 'Incomplete per-file checksum manifest.' }
    $sums = @{}
    foreach ($line in $lines) {
        if ($line -notmatch '^([0-9a-f]{64})  (.+)$' -or $sums.ContainsKey($Matches[2])) { throw 'Invalid or duplicate checksum entry.' }
        $sums[$Matches[2]] = $Matches[1]
    }
    foreach ($name in $script:DesktopControlZipFiles) {
        if (-not $sums.ContainsKey($name)) { throw ('Missing checksum: ' + $name) }
        $entry = $zip.GetEntry($name)
        $entryStream = $entry.Open()
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($hasher.ComputeHash($entryStream)).Replace('-','').ToLowerInvariant() } finally { $entryStream.Dispose(); $hasher.Dispose() }
        if ($hash -ne $sums[$name]) { throw ('Payload checksum mismatch: ' + $name) }
        if ($name.StartsWith('plugin/')) { $original = Join-Path $sourceRoot $name.Substring(7) }
        elseif ($name -eq 'tools/portable.ps1') { $original = Join-Path $sourceRoot $name }
        else { $original = Join-Path $sourceRoot ('delivery/' + $name) }
        if ($name.EndsWith('.cmd')) {
            $text = [IO.File]::ReadAllText($original, [Text.Encoding]::ASCII).Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd("`n").Replace("`n", "`r`n") + "`r`n"
            $hasher = [Security.Cryptography.SHA256]::Create()
            try { $sourceHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::ASCII.GetBytes($text))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
        } else { $sourceHash = (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLowerInvariant() }
        if ($sourceHash -ne $hash) { throw ('ZIP differs from current source: ' + $name) }
        $checks += 2
    }
    Write-Host ('Release verification passed: ' + $checks + ' checks; exact allowlist, all payload hashes and current source match.')
} finally { $zip.Dispose() }
