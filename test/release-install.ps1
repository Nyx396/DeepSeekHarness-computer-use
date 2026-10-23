#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ZipPath,
    [Parameter(Mandatory=$true)][string]$DshPath,
    [Parameter(Mandatory=$true)][string]$HubRoot
)

$ErrorActionPreference = 'Stop'
$requestedDshPath = $DshPath
$sourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\', '/')
$artifactRoot = $env:DSH_TEST_ARTIFACTS
if (-not $artifactRoot) {
    $artifactRoot = Join-Path (Split-Path -Parent $sourceRoot) ((Split-Path -Leaf $sourceRoot) + '-local-records\artifacts')
}
$artifactRoot = [IO.Path]::GetFullPath($artifactRoot).TrimEnd('\', '/')
if ($artifactRoot.Equals($sourceRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $artifactRoot.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Release test artifacts must be outside the source directory.'
}

function Assert-ReleaseTestNoLinkedAncestors([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $entry = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($entry -and (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw ('A test output ancestor is a reparse point: ' + $current)
        }
        $parent = Split-Path -Parent $current
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-ReleaseTestChild([string]$Path, [string]$Root) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if (-not $fullPath.StartsWith($fullRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('Test path escapes its isolated root: ' + $fullPath)
    }
    return $fullPath
}

Assert-ReleaseTestNoLinkedAncestors $artifactRoot
$testRoot = Assert-ReleaseTestChild (Join-Path $artifactRoot ('release-install-' + [Guid]::NewGuid().ToString('N'))) $artifactRoot
if (Test-Path -LiteralPath $testRoot) { throw 'The unique test directory already exists.' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$unpacked = Assert-ReleaseTestChild (Join-Path $testRoot 'unpacked') $testRoot
$fixtureHome = Assert-ReleaseTestChild (Join-Path $testRoot 'dsh-home') $testRoot
$resultPath = Join-Path $testRoot 'result.json'
$result = [ordered]@{ ok=$false; testRoot=$testRoot; realDshHomeUsed=$false; userProcessesClosed=$false; processGateOverride='test harness only'; zip=[IO.Path]::GetFullPath($ZipPath) }
$originalProcessFunction = $null

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($result.zip)
    try {
        # Validate every member before extracting anything. Windows treats both
        # slash styles as separators; reject drive names, ADS and symlink entries.
        $members = @()
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not $name -or $name.StartsWith('/') -or $name.Contains(':') -or $name.Contains([char]0)) {
                throw ('Unsafe ZIP member: ' + $entry.FullName)
            }
            $segments = $name.Split('/')
            if (@($segments | Where-Object { $_ -eq '..' -or $_ -eq '.' -or $_ -match '[. ]$' }).Count) {
                throw ('Unsafe ZIP path component: ' + $entry.FullName)
            }
            if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960 -or
                (($entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0)) {
                throw ('ZIP links are not allowed: ' + $entry.FullName)
            }
            $target = Assert-ReleaseTestChild (Join-Path $unpacked ($name.Replace('/', '\'))) $unpacked
            if (-not $seen.Add($target.TrimEnd('\', '/'))) { throw ('Duplicate ZIP member: ' + $entry.FullName) }
            $members += [pscustomobject]@{ Entry=$entry; Target=$target; Directory=$name.EndsWith('/') }
        }
        New-Item -ItemType Directory -Path $unpacked | Out-Null
        foreach ($member in $members) {
            if ($member.Directory) { New-Item -ItemType Directory -Path $member.Target -Force | Out-Null; continue }
            New-Item -ItemType Directory -Path (Split-Path -Parent $member.Target) -Force | Out-Null
            $inputStream = $member.Entry.Open()
            try {
                $outputStream = [IO.File]::Open($member.Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
                try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
            } finally { $inputStream.Dispose() }
        }
        $result.zipEntries = $members.Count
    } finally { $archive.Dispose() }

    $payloadSource = Assert-ReleaseTestChild (Join-Path $unpacked 'plugin') $unpacked
    $portablePath = Assert-ReleaseTestChild (Join-Path $unpacked 'tools\portable.ps1') $unpacked
    if (-not (Test-Path -LiteralPath $portablePath -PathType Leaf)) { throw 'The ZIP installer is missing.' }
    $package = Get-Content -LiteralPath (Join-Path $payloadSource 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($package.name -ne 'dsh-desktop-control') { throw 'Unexpected ZIP plugin name.' }
    $result.version = $package.version
    $result.zipSha256 = (Get-FileHash -LiteralPath $result.zip -Algorithm SHA256).Hash.ToLowerInvariant()

    $profileDir = Assert-ReleaseTestChild (Join-Path $fixtureHome 'profiles\desktop') $testRoot
    New-Item -ItemType Directory -Path (Join-Path $profileDir 'node_modules') -Force | Out-Null
    $hubCopy = Assert-ReleaseTestChild (Join-Path $testRoot 'hub-fixture') $testRoot
    New-Item -ItemType Directory -Path $hubCopy | Out-Null
    foreach ($item in @('package.json', 'cordis.patch.yml', 'lib')) {
        Copy-Item -LiteralPath (Join-Path $HubRoot $item) -Destination $hubCopy -Recurse
    }
    $hubManifest = Get-Content -LiteralPath (Join-Path $hubCopy 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($hubManifest.name -ne 'dsh-plugin-hub' -or $hubManifest.version -ne '1.0.0') { throw 'The fixture requires real dsh-plugin-hub 1.0.0.' }
    New-Item -ItemType Junction -Path (Join-Path $profileDir 'node_modules\dsh-plugin-hub') -Target $hubCopy | Out-Null
    $manifest = [ordered]@{
        name='desktop-control-release-fixture'; private=$true
        releaseFixtureSentinel='preserve unrelated metadata'
        dsh=@{profile=@{bundles=@('dsh-plugin-hub')}}
        dependencies=@{'dsh-plugin-hub'=('link:' + $hubCopy.Replace('\', '/'))}
    }
    $utf8 = New-Object Text.UTF8Encoding($false)
    $profileManifest = Join-Path $profileDir 'package.json'
    [IO.File]::WriteAllText($profileManifest, ($manifest | ConvertTo-Json -Depth 10), $utf8)
    $patchPath = Join-Path $profileDir 'cordis.patch.yml'
    $patchText = "# Isolated release fixture: preserve unrelated hub configuration.`r`n"
    [IO.File]::WriteAllText($patchPath, $patchText, $utf8)

    # Import the SHIPPED installer, never the source installer. This override
    # affects only its process-presence guard in this disposable test harness.
    # No process is stopped; every deployment receives the isolated DshHome.
    . $portablePath -Library
    $originalProcessFunction = (Get-Command Get-DesktopControlDshProcesses -CommandType Function).ScriptBlock
    function Get-DesktopControlDshProcesses { return @() }

    function Invoke-IsolatedReleaseDeployment([string]$Action) {
        $checkedHome = Assert-ReleaseTestChild $fixtureHome $testRoot
        Assert-ReleaseTestNoLinkedAncestors $checkedHome
        if (-not $checkedHome.Equals([IO.Path]::GetFullPath((Join-Path $testRoot 'dsh-home')), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The deployment home is not the exact disposable fixture home.'
        }
        $deployment = Invoke-DesktopControlDeployment -Mode $Action -DshPath $requestedDshPath -DshHome $checkedHome -Profile desktop -PluginSource $payloadSource
        if (-not $deployment.Home.Equals($checkedHome, [StringComparison]::OrdinalIgnoreCase)) { throw 'The installer used an unexpected DSH home.' }
    }

    Invoke-IsolatedReleaseDeployment 'Install'
    $installed = Assert-ReleaseTestChild (Join-Path $fixtureHome 'custom-plugins\dsh-desktop-control\desktop') $testRoot
    $required = @('lib\index.js', 'lib\client.js', 'lib\controller.js', 'lib\engine.js', 'lib\tools.js', 'lib\settings.js', 'lib\authorization.js', 'lib\preview.js', 'lib\skill.js', 'lib\overlay.js', 'lib\windows\visuals.cs', 'skills\computer-use\SKILL.md')
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $installed $relative) -PathType Leaf)) { throw ('Installed file missing: ' + $relative) }
    }
    foreach ($entry in @(Get-ChildItem -LiteralPath $installed -Recurse -Force)) {
        if ($entry.Name -match '^(VERIFICATION(?:\..*)?|TEST-NOTES.*|test|artifacts)$') { throw ('Local test material leaked: ' + $entry.FullName) }
    }
    $installedManifest = Get-Content -LiteralPath (Join-Path $installed 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($installedManifest.name -ne $package.name -or $installedManifest.version -ne $package.version) { throw 'Installed package version differs from the ZIP.' }
    $after = Get-Content -LiteralPath $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($after.dsh.profile.bundles) -notcontains 'dsh-desktop-control') { throw 'The release bundle was not registered.' }
    if ($after.dependencies.'dsh-plugin-hub' -ne $manifest.dependencies.'dsh-plugin-hub' -or $after.releaseFixtureSentinel -ne $manifest.releaseFixtureSentinel) { throw 'Unrelated hub metadata changed on installation.' }
    if ([IO.File]::ReadAllText($patchPath) -cne $patchText) { throw 'The unrelated patch changed on installation.' }
    $result.installedRequiredFiles = $required.Count
    $result.installedFiles = @(Get-ChildItem -LiteralPath $installed -File -Recurse).Count

    Invoke-IsolatedReleaseDeployment 'Uninstall'
    $after = Get-Content -LiteralPath $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($after.dsh.profile.bundles) -contains 'dsh-desktop-control' -or $after.dependencies.PSObject.Properties['dsh-desktop-control']) { throw 'Release registration remains after uninstall.' }
    if (Test-Path -LiteralPath $installed) { throw 'The release payload remains active after uninstall.' }
    if ($after.dependencies.'dsh-plugin-hub' -ne $manifest.dependencies.'dsh-plugin-hub' -or @($after.dsh.profile.bundles).Count -ne 1 -or $after.releaseFixtureSentinel -ne $manifest.releaseFixtureSentinel) { throw 'Unrelated hub metadata changed on uninstall.' }
    if ([IO.File]::ReadAllText($patchPath) -cne $patchText) { throw 'The unrelated patch changed on uninstall.' }
    $result.install = $true
    $result.uninstall = $true
    $result.hubPreserved = $true
    $result.ok = $true
} catch {
    $result.error = $_.Exception.Message
    throw
} finally {
    if ($originalProcessFunction) { Set-Item -Path Function:Get-DesktopControlDshProcesses -Value $originalProcessFunction }
    [IO.File]::WriteAllText($resultPath, (($result | ConvertTo-Json -Depth 10) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
    Write-Output ($result | ConvertTo-Json -Depth 10 -Compress)
}
