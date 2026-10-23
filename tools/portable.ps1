#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall', 'Check')][string]$Mode = 'Check',
    [string]$DshPath,
    [string]$DshHome,
    [string]$Profile = 'desktop',
    [string]$PluginSource,
    [switch]$Library
)

$ErrorActionPreference = 'Stop'
$script:DesktopControlPackageName = 'dsh-desktop-control'
$script:DesktopControlMetadataNames = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml', 'compatibility.json')
$script:DesktopControlPayloadNames = @('package.json', 'cordis.patch.yml', 'lib', 'vendor', 'skills', 'README.md', 'LICENSE', 'THIRD_PARTY.md')

function Read-DesktopControlJson([string]$Path) {
    return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}

function Write-DesktopControlUtf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Get-DesktopControlAbsolutePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'An empty path is not allowed.' }
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-DesktopControlChildPath([string]$Path, [string]$Root) {
    $fullPath = Get-DesktopControlAbsolutePath $Path
    $fullRoot = Get-DesktopControlAbsolutePath $Root
    $prefix = $fullRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('Refusing a file operation outside the expected directory: ' + $fullPath)
    }
    return $fullPath
}

function Test-DesktopControlReparsePoint([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return ($null -ne $item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0))
}

function Assert-DesktopControlNoLinkedAncestors([string]$Path, [string]$Root) {
    $current = Get-DesktopControlAbsolutePath $Path
    $boundary = Get-DesktopControlAbsolutePath $Root
    if ($current -ne $boundary) { $null = Assert-DesktopControlChildPath $current $boundary }
    while ($true) {
        if (Test-DesktopControlReparsePoint $current) { throw ('A managed directory is a reparse point: ' + $current) }
        if ($current.Equals($boundary, [StringComparison]::OrdinalIgnoreCase)) { break }
        $current = Split-Path -Parent $current
        if (-not $current) { throw 'Cannot verify the managed directory boundary.' }
    }
}

function Assert-DesktopControlTreeNoLinks([string]$Path) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Path)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        if (Test-DesktopControlReparsePoint $directory) { throw ('A managed directory is a reparse point: ' + $directory) }
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('A managed directory contains a reparse point: ' + $item.FullName) }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
}

function Remove-DesktopControlOwnedDirectory([string]$Path, [string]$Root) {
    $checked = Assert-DesktopControlChildPath $Path $Root
    if (-not (Test-Path -LiteralPath $checked)) { return }
    Assert-DesktopControlNoLinkedAncestors $checked $Root
    Assert-DesktopControlTreeNoLinks $checked
    Remove-Item -LiteralPath $checked -Recurse -Force
}

function Get-DesktopControlDshProcesses {
    return @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
}

function Get-DesktopControlUserProfile {
    $value = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ([string]::IsNullOrWhiteSpace($value)) { $value = $env:USERPROFILE }
    if ([string]::IsNullOrWhiteSpace($value)) { throw 'Cannot determine the current Windows user directory.' }
    return Get-DesktopControlAbsolutePath $value
}

function Find-DesktopControlDshCli([string]$RequestedPath) {
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    if ($RequestedPath) {
        $requested = Get-DesktopControlAbsolutePath $RequestedPath
        if (Test-Path -LiteralPath $requested -PathType Container) {
            $requested = Join-Path $requested 'resources\runtime\cli\bin\dsh.cmd'
        }
        if (-not (Test-Path -LiteralPath $requested -PathType Leaf)) { throw ('DSH CLI was not found at: ' + $requested) }
        return $requested
    }
    $userRoot = Get-DesktopControlUserProfile
    $localRoots = @((Join-Path $userRoot 'AppData\Local'), $env:LOCALAPPDATA)
    foreach ($localRoot in $localRoots) {
        if ($localRoot) { $candidates.Add((Join-Path $localRoot 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')) }
    }
    foreach ($programRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($programRoot) { $candidates.Add((Join-Path $programRoot 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')) }
    }
    foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        try {
            foreach ($entry in @(Get-ItemProperty -Path $registryRoot -ErrorAction SilentlyContinue)) {
                if ($entry.DisplayName -like '*DeepSeek Harness*' -and $entry.InstallLocation) {
                    $candidates.Add((Join-Path $entry.InstallLocation 'resources\runtime\cli\bin\dsh.cmd'))
                }
            }
        } catch { }
    }
    foreach ($process in @(Get-DesktopControlDshProcesses)) {
        try {
            if ($process.Path) { $candidates.Add((Join-Path (Split-Path -Parent $process.Path) 'resources\runtime\cli\bin\dsh.cmd')) }
        } catch { }
    }
    $command = Get-Command dsh.cmd -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { $candidates.Add($command.Source) }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return Get-DesktopControlAbsolutePath $candidate }
    }
    throw 'DSH Desktop was not found. Start it once, or run portable.ps1 with -DshPath <DSH installation directory>.'
}

function Get-DesktopControlEnvironment([string]$RequestedDshPath, [string]$RequestedHome, [string]$ProfileName, [string]$Source) {
    if ($ProfileName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $ProfileName -eq '.' -or $ProfileName -eq '..') {
        throw 'The profile name may contain letters, numbers, dot, underscore and hyphen; path components are not allowed.'
    }
    if (-not [Environment]::Is64BitOperatingSystem -or (@($env:PROCESSOR_ARCHITECTURE, $env:PROCESSOR_ARCHITEW6432) -notcontains 'AMD64')) { throw 'This release supports Windows x64 only (not ARM64 or 32-bit Windows).' }
    $cli = Find-DesktopControlDshCli $RequestedDshPath
    $resolvedHome = $RequestedHome
    if (-not $resolvedHome) { $resolvedHome = $env:DSH_HOME }
    if (-not $resolvedHome) { $resolvedHome = Join-Path (Get-DesktopControlUserProfile) '.dsh' }
    $resolvedHome = Get-DesktopControlAbsolutePath $resolvedHome
    $profileDir = Assert-DesktopControlChildPath (Join-Path $resolvedHome ('profiles\' + $ProfileName)) $resolvedHome
    $manifestPath = Join-Path $profileDir 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw ('The DSH profile is not initialized: ' + $profileDir + '. Open DSH Desktop once before installing.')
    }
    $manifest = Read-DesktopControlJson $manifestPath
    if (-not $manifest.dsh -or -not $manifest.dsh.profile) { throw ('Not a DSH profile: ' + $profileDir) }
    if (-not $Source) {
        $packageRoot = Split-Path -Parent $PSScriptRoot
        if (Test-Path -LiteralPath (Join-Path $packageRoot 'plugin\package.json')) { $Source = Join-Path $packageRoot 'plugin' }
        else { $Source = $packageRoot }
    }
    $Source = Get-DesktopControlAbsolutePath $Source
    $pluginRoot = Assert-DesktopControlChildPath (Join-Path $resolvedHome ('custom-plugins\' + $script:DesktopControlPackageName)) $resolvedHome
    $installDir = Assert-DesktopControlChildPath (Join-Path $pluginRoot $ProfileName) $pluginRoot
    Assert-DesktopControlNoLinkedAncestors $profileDir $resolvedHome
    Assert-DesktopControlNoLinkedAncestors (Join-Path $profileDir 'node_modules') $resolvedHome
    Assert-DesktopControlNoLinkedAncestors $installDir $resolvedHome
    return [pscustomobject]@{ Cli = $cli; Home = $resolvedHome; Profile = $ProfileName; ProfileDir = $profileDir; Manifest = $manifestPath; Source = $Source; PluginRoot = $pluginRoot; InstallDir = $installDir; NodeLink = (Join-Path $profileDir ('node_modules\' + $script:DesktopControlPackageName)) }
}

function Invoke-DesktopControlCli($Environment, [string[]]$Arguments) {
    $processValues = @{
        DSH_HOME = $Environment.Home
        npm_config_offline = 'true'
        npm_config_ignore_scripts = 'true'
    }
    $previousValues = @{}
    foreach ($key in $processValues.Keys) { $previousValues[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
    try {
        # DSH may run a compatibility-repair pnpm subprocess without forwarding
        # the original command-line flags. Config environment reaches it too.
        foreach ($key in $processValues.Keys) { [Environment]::SetEnvironmentVariable($key, $processValues[$key], 'Process') }
        $global:LASTEXITCODE = 0
        & $Environment.Cli @Arguments | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw ('DSH CLI failed with exit code ' + $LASTEXITCODE + '.') }
    } finally {
        foreach ($key in $processValues.Keys) { [Environment]::SetEnvironmentVariable($key, $previousValues[$key], 'Process') }
    }
}

function ConvertTo-DesktopControlCanonicalValue($Value) {
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object)) { $ordered[$key] = ConvertTo-DesktopControlCanonicalValue $Value[$key] }
        return [pscustomobject]$ordered
    }
    if ($Value -is [Collections.IEnumerable]) {
        $items = New-Object 'System.Collections.Generic.List[object]'
        foreach ($item in $Value) { $items.Add((ConvertTo-DesktopControlCanonicalValue $item)) }
        return ,($items.ToArray())
    }
    $ordered = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Sort-Object Name)) {
        $ordered[$property.Name] = ConvertTo-DesktopControlCanonicalValue $property.Value
    }
    return [pscustomobject]$ordered
}

function Get-DesktopControlOtherManifestState($Manifest) {
    $copy = ($Manifest | ConvertTo-Json -Depth 100 | ConvertFrom-Json)
    if ($copy.dependencies) { $copy.dependencies.PSObject.Properties.Remove($script:DesktopControlPackageName) }
    if ($copy.dsh -and $copy.dsh.profile) {
        $copy.dsh.profile.bundles = @($copy.dsh.profile.bundles | Where-Object { $_ -ne $script:DesktopControlPackageName })
    }
    # pnpm may add/update its own packageManager annotation.
    $copy.PSObject.Properties.Remove('packageManager')
    if ($copy.dependencies -and @($copy.dependencies.PSObject.Properties).Count -eq 0) { $copy.PSObject.Properties.Remove('dependencies') }
    # Object key order is not semantic; array order remains significant.
    return ((ConvertTo-DesktopControlCanonicalValue $copy) | ConvertTo-Json -Depth 100 -Compress)
}

function New-DesktopControlBackup($Environment) {
    $backupRoot = Assert-DesktopControlChildPath (Join-Path $Environment.Home ('backups\' + $script:DesktopControlPackageName)) $Environment.Home
    Assert-DesktopControlNoLinkedAncestors $backupRoot $Environment.Home
    $backup = Assert-DesktopControlChildPath (Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))) $backupRoot
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $files = @()
    foreach ($name in $script:DesktopControlMetadataNames) {
        $path = Join-Path $Environment.ProfileDir $name
        $exists = Test-Path -LiteralPath $path -PathType Leaf
        $files += [pscustomobject]@{ Name = $name; Existed = $exists }
        if ($exists) { Copy-Item -LiteralPath $path -Destination (Join-Path $backup $name) }
    }
    $oldLink = Get-Item -LiteralPath $Environment.NodeLink -Force -ErrorAction SilentlyContinue
    $link = $null
    if ($oldLink) {
        if (($oldLink.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $target = @($oldLink.Target)[0]
            if (-not $target) { throw ('Cannot back up the existing plugin link: ' + $Environment.NodeLink) }
            if (-not [IO.Path]::IsPathRooted($target)) { $target = Get-DesktopControlAbsolutePath (Join-Path $oldLink.Parent.FullName $target) }
            $link = [pscustomobject]@{ Kind = 'Link'; Target = $target; Type = $oldLink.LinkType }
        } else {
            Assert-DesktopControlTreeNoLinks $oldLink.FullName
            Copy-Item -LiteralPath $oldLink.FullName -Destination (Join-Path $backup 'node-module-previous') -Recurse
            $link = [pscustomobject]@{ Kind = 'Directory' }
        }
    }
    $record = [pscustomobject]@{ Profile = $Environment.Profile; CreatedAt = (Get-Date).ToString('o'); InstallDir = $Environment.InstallDir; Files = $files; Link = $link }
    Write-DesktopControlUtf8 (Join-Path $backup 'transaction.json') (($record | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
    return [pscustomobject]@{ Directory = $backup; Record = $record; PreviousPluginMoved = $false; NewPluginCopied = $false }
}

function Remove-DesktopControlNodeLink($Environment) {
    $checked = Assert-DesktopControlChildPath $Environment.NodeLink (Join-Path $Environment.ProfileDir 'node_modules')
    $entry = Get-Item -LiteralPath $checked -Force -ErrorAction SilentlyContinue
    if (-not $entry) { return }
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        # Delete only the junction/symlink entry; never recurse into its target.
        [IO.Directory]::Delete($checked, $false)
    } else { Remove-DesktopControlOwnedDirectory $checked (Join-Path $Environment.ProfileDir 'node_modules') }
}

function Restore-DesktopControlBackup($Environment, $Backup) {
    foreach ($file in $Backup.Record.Files) {
        $target = Join-Path $Environment.ProfileDir $file.Name
        if ($file.Existed) { Copy-Item -LiteralPath (Join-Path $Backup.Directory $file.Name) -Destination $target -Force }
        elseif (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
    }
    if ($Backup.NewPluginCopied -and (Test-Path -LiteralPath $Environment.InstallDir)) {
        Remove-DesktopControlOwnedDirectory $Environment.InstallDir $Environment.PluginRoot
    }
    if ($Backup.PreviousPluginMoved) {
        $source = Assert-DesktopControlChildPath (Join-Path $Backup.Directory 'plugin-previous') $Backup.Directory
        $target = Assert-DesktopControlChildPath $Environment.InstallDir $Environment.PluginRoot
        Move-Item -LiteralPath $source -Destination $target
    }
    Remove-DesktopControlNodeLink $Environment
    if ($Backup.Record.Link) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $Environment.NodeLink) -Force | Out-Null
        if ($Backup.Record.Link.Kind -eq 'Link') {
            $kind = if ($Backup.Record.Link.Type -eq 'SymbolicLink') { 'SymbolicLink' } else { 'Junction' }
            New-Item -ItemType $kind -Path $Environment.NodeLink -Target $Backup.Record.Link.Target | Out-Null
        } else {
            Copy-Item -LiteralPath (Join-Path $Backup.Directory 'node-module-previous') -Destination $Environment.NodeLink -Recurse
        }
    }
}

function Assert-DesktopControlPluginSource($Environment) {
    $required = @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js', 'lib\controller.js', 'lib\engine.js', 'lib\tools.js', 'lib\settings.js', 'vendor\windows-engine\package.json', 'vendor\windows-engine\LICENSE', 'vendor\windows-engine\UPSTREAM.json', 'vendor\windows-engine\mcp\server.mjs', 'vendor\windows-engine\mcp\settings.mjs', 'vendor\windows-engine\mcp\takeover.mjs', 'vendor\windows-engine\scripts\windows-uia.ps1', 'vendor\windows-engine\scripts\windows-takeover.ps1', 'vendor\windows-engine\scripts\windows-takeover.cs')
    $required += @('lib\skill.js', 'lib\preview.js', 'lib\authorization.js', 'lib\overlay.js', 'lib\windows\visuals.cs', 'skills\computer-use\SKILL.md')
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Environment.Source $relative) -PathType Leaf)) { throw ('The plugin package is incomplete: missing ' + $relative) }
    }
    $self = Read-DesktopControlJson (Join-Path $Environment.Source 'package.json')
    if ($self.name -ne $script:DesktopControlPackageName) { throw 'The source package name is not dsh-desktop-control.' }
    if ($self.dependencies -and @($self.dependencies.PSObject.Properties).Count -gt 0) { throw 'This portable installer expects a prebuilt plugin with no external runtime dependencies.' }
    $installPrefix = $Environment.InstallDir + [IO.Path]::DirectorySeparatorChar
    $sourcePrefix = $Environment.Source + [IO.Path]::DirectorySeparatorChar
    if ($Environment.Source.Equals($Environment.InstallDir, [StringComparison]::OrdinalIgnoreCase) -or $Environment.Source.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase) -or $Environment.InstallDir.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The release source and target installation must be separate directories.'
    }
    if (Test-DesktopControlReparsePoint $Environment.Source) { throw 'The release source must be an ordinary directory, not a reparse point.' }
    # Only shipped payload is traversed/copied. Developer test artifacts may
    # contain isolated node_modules links and must not affect installation.
    foreach ($item in $script:DesktopControlPayloadNames) {
        $payloadItem = Join-Path $Environment.Source $item
        if (-not (Test-Path -LiteralPath $payloadItem)) { throw ('The plugin package is incomplete: missing ' + $item) }
        if (Test-DesktopControlReparsePoint $payloadItem) { throw ('A release payload item is a reparse point: ' + $payloadItem) }
        if (Test-Path -LiteralPath $payloadItem -PathType Container) { Assert-DesktopControlTreeNoLinks $payloadItem }
    }
    return $self
}

function Assert-DesktopControlHostVersion($Environment) {
    $global:LASTEXITCODE = 0
    $versionOutput = (& $Environment.Cli --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch '(?m)^0\.2\.1-rc\.2\s*$') {
        throw ('This release requires DSH 0.2.1-rc.2. Detected CLI output: ' + $versionOutput)
    }
    Write-Host 'DSH version: 0.2.1-rc.2'
}

function Assert-DesktopControlHubDependency($Environment, $Manifest) {
    $hubName = 'dsh-plugin-hub'
    if (-not $Manifest.dependencies -or -not $Manifest.dependencies.PSObject.Properties[$hubName] -or @($Manifest.dsh.profile.bundles) -notcontains $hubName) {
        throw 'Required dsh-plugin-hub is missing. Install dsh-plugin-hub 1.0.0 first, then run this installer again. Existing hub settings are not changed.'
    }
    $hubManifestPath = Join-Path $Environment.ProfileDir ('node_modules\' + $hubName + '\package.json')
    if (-not (Test-Path -LiteralPath $hubManifestPath -PathType Leaf)) { throw 'dsh-plugin-hub is registered but its installed package cannot be read. Repair the hub installation first.' }
    $hub = Read-DesktopControlJson $hubManifestPath
    if ($hub.name -ne $hubName -or $hub.version -ne '1.0.0') { throw ('This release requires dsh-plugin-hub 1.0.0. Found: ' + $hub.version + '. No hub downgrade or replacement was attempted.') }
    Write-Host 'Extension pocket dependency: dsh-plugin-hub 1.0.0 ready'
}

function Invoke-DesktopControlDeployment {
    [CmdletBinding()]
    param([ValidateSet('Install', 'Uninstall', 'Check')][string]$Mode = 'Check', [string]$DshPath, [string]$DshHome, [string]$Profile = 'desktop', [string]$PluginSource)
    $environment = Get-DesktopControlEnvironment $DshPath $DshHome $Profile $PluginSource
    Write-Host ('DSH CLI: ' + $environment.Cli)
    Write-Host ('DSH home: ' + $environment.Home)
    Write-Host ('Profile: ' + $environment.Profile)
    Write-Host ('Stable plugin directory: ' + $environment.InstallDir)
    $manifest = Read-DesktopControlJson $environment.Manifest
    if ($Mode -ne 'Uninstall') { Assert-DesktopControlHostVersion $environment }
    if ($Mode -ne 'Uninstall') { Assert-DesktopControlHubDependency $environment $manifest }
    $installed = ($manifest.dependencies -and $manifest.dependencies.PSObject.Properties[$script:DesktopControlPackageName]) -or (@($manifest.dsh.profile.bundles) -contains $script:DesktopControlPackageName)
    $running = @(Get-DesktopControlDshProcesses)
    if ($Mode -eq 'Check') {
        $self = Assert-DesktopControlPluginSource $environment
        Write-Host ('Release: ' + $self.name + ' ' + $self.version)
        Write-Host ('Currently registered: ' + [bool]$installed)
        Write-Host ('DSH Desktop processes: ' + $running.Count)
        if ($running.Count) { Write-Host 'Close DSH completely before installation or removal.' }
        Write-Host 'Check complete. No files or settings were changed.'
        return $environment
    }
    if ($running.Count -gt 0) { throw 'DSH Desktop is running. Completely exit it, including the tray icon, and run this action again.' }
    if ($Mode -eq 'Uninstall' -and -not $installed) {
        Write-Host 'The plugin is not registered in this profile. No changes were made.'
        return $environment
    }
    if ($Mode -eq 'Install') { $self = Assert-DesktopControlPluginSource $environment }
    if (Test-DesktopControlReparsePoint $environment.PluginRoot) { throw 'The plugin installation root is a reparse point; choose an ordinary DSH home directory.' }
    if (Test-DesktopControlReparsePoint $environment.InstallDir) { throw 'The plugin installation directory is a reparse point; remove it before installing.' }
    $otherBefore = Get-DesktopControlOtherManifestState $manifest
    $backup = New-DesktopControlBackup $environment
    Write-Host ('Transaction backup: ' + $backup.Directory)
    try {
        if ($Mode -eq 'Install') {
            New-Item -ItemType Directory -Path $environment.PluginRoot -Force | Out-Null
            if (Test-Path -LiteralPath $environment.InstallDir) {
                $old = Assert-DesktopControlChildPath $environment.InstallDir $environment.PluginRoot
                $backupTarget = Assert-DesktopControlChildPath (Join-Path $backup.Directory 'plugin-previous') $backup.Directory
                Move-Item -LiteralPath $old -Destination $backupTarget
                $backup.PreviousPluginMoved = $true
            }
            $backup.NewPluginCopied = $true
            New-Item -ItemType Directory -Path $environment.InstallDir -Force | Out-Null
            foreach ($item in $script:DesktopControlPayloadNames) {
                Copy-Item -LiteralPath (Join-Path $environment.Source $item) -Destination $environment.InstallDir -Recurse
            }
            $spec = 'link:' + $environment.InstallDir.Replace('\', '/')
            Invoke-DesktopControlCli $environment @('plugin', '--profile', $environment.Profile, 'add', $spec, '--offline', '--ignore-scripts')
            $after = Read-DesktopControlJson $environment.Manifest
            if (-not $after.dependencies -or -not $after.dependencies.PSObject.Properties[$script:DesktopControlPackageName] -or @($after.dsh.profile.bundles) -notcontains $script:DesktopControlPackageName) {
                throw 'DSH did not register both the plugin dependency and bundle.'
            }
            $registered = Read-DesktopControlJson (Join-Path $environment.NodeLink 'package.json')
            if ($registered.name -ne $script:DesktopControlPackageName -or $registered.version -ne $self.version) { throw 'The installed package could not be verified through the profile link.' }
        } else {
            # pnpm remove does not accept add/install's --offline or --ignore-scripts flags.
            # Config environment variables apply the same policy without invalid CLI options.
            $previousOffline = $env:npm_config_offline
            $previousIgnoreScripts = $env:npm_config_ignore_scripts
            try {
                $env:npm_config_offline = 'true'
                $env:npm_config_ignore_scripts = 'true'
                Invoke-DesktopControlCli $environment @('plugin', '--profile', $environment.Profile, 'remove', $script:DesktopControlPackageName)
            } finally {
                $env:npm_config_offline = $previousOffline
                $env:npm_config_ignore_scripts = $previousIgnoreScripts
            }
            $after = Read-DesktopControlJson $environment.Manifest
            if (($after.dependencies -and $after.dependencies.PSObject.Properties[$script:DesktopControlPackageName]) -or @($after.dsh.profile.bundles) -contains $script:DesktopControlPackageName) { throw 'DSH did not remove the plugin registration.' }
        }
        if ((Get-DesktopControlOtherManifestState $after) -ne $otherBefore) { throw 'An unrelated profile setting changed during installation; rolling back this transaction.' }
        $patchBefore = Join-Path $backup.Directory 'cordis.patch.yml'
        $patchNow = Join-Path $environment.ProfileDir 'cordis.patch.yml'
        if ((Test-Path -LiteralPath $patchBefore) -and ([IO.File]::ReadAllText($patchBefore) -ne [IO.File]::ReadAllText($patchNow))) { throw 'The user patch unexpectedly changed; rolling back this transaction.' }
        if ($Mode -eq 'Uninstall' -and (Test-Path -LiteralPath $environment.InstallDir)) {
            $old = Assert-DesktopControlChildPath $environment.InstallDir $environment.PluginRoot
            $backupTarget = Assert-DesktopControlChildPath (Join-Path $backup.Directory 'plugin-previous') $backup.Directory
            Move-Item -LiteralPath $old -Destination $backupTarget
            $backup.PreviousPluginMoved = $true
        }
        Write-DesktopControlUtf8 (Join-Path $backup.Directory 'result.txt') ($Mode + ' succeeded. This backup is retained for recovery.' + [Environment]::NewLine)
        Write-Host ($Mode + ' complete. Start DSH Desktop again.')
        return $environment
    } catch {
        $failure = $_
        try {
            Restore-DesktopControlBackup $environment $backup
            Write-Host 'The failed transaction was rolled back. Other plugin settings were preserved.'
        } catch {
            throw ('Deployment failed: ' + $failure.Exception.Message + ' Automatic rollback also failed: ' + $_.Exception.Message + ' Backup: ' + $backup.Directory)
        }
        throw ('Deployment failed and was rolled back: ' + $failure.Exception.Message + ' No online fallback was attempted. Backup: ' + $backup.Directory)
    }
}

if (-not $Library) {
    try {
        Invoke-DesktopControlDeployment -Mode $Mode -DshPath $DshPath -DshHome $DshHome -Profile $Profile -PluginSource $PluginSource | Out-Null
    } catch {
        Write-Host ('[ERROR] ' + $_.Exception.Message) -ForegroundColor Red
        exit 1
    }
}
