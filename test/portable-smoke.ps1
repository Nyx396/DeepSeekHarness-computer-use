#Requires -Version 5.1
param(
    [Parameter(Mandatory=$true)][string]$DshPath,
    [Parameter(Mandatory=$true)][string]$HubRoot
)
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$artifactRoot = $env:DSH_TEST_ARTIFACTS
if (-not $artifactRoot) { $artifactRoot = Join-Path (Split-Path -Parent $source) ((Split-Path -Leaf $source) + '-local-records\artifacts') }
$artifactRoot = [IO.Path]::GetFullPath($artifactRoot)
$sourceRoot = [IO.Path]::GetFullPath($source).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
if ($artifactRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Equals($sourceRoot, [StringComparison]::OrdinalIgnoreCase) -or $artifactRoot.StartsWith(($sourceRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'DSH_TEST_ARTIFACTS must be outside the plugin source directory.'
}
$root = Join-Path $artifactRoot ('portable-' + [Guid]::NewGuid().ToString('N'))
$payloadSource = Join-Path $root 'source'
New-Item -ItemType Directory -Path $payloadSource -Force | Out-Null
foreach ($item in @('package.json','cordis.patch.yml','lib','vendor','skills','README.md','LICENSE','THIRD_PARTY.md')) {
    Copy-Item -LiteralPath (Join-Path $source $item) -Destination $payloadSource -Recurse
}
$profile = Join-Path $root 'profiles\desktop'
New-Item -ItemType Directory -Path (Join-Path $profile 'node_modules') -Force | Out-Null
$hubCopy = Join-Path $root 'hub-fixture'
New-Item -ItemType Directory -Path $hubCopy | Out-Null
foreach ($item in @('package.json','cordis.patch.yml','lib')) {
    Copy-Item -LiteralPath (Join-Path $HubRoot $item) -Destination $hubCopy -Recurse
}
New-Item -ItemType Junction -Path (Join-Path $profile 'node_modules\dsh-plugin-hub') -Target $hubCopy | Out-Null
$manifest = [ordered]@{name='desktop-control-portable-fixture';private=$true;dsh=@{profile=@{bundles=@('dsh-plugin-hub')}};dependencies=@{'dsh-plugin-hub'=('link:' + $hubCopy.Replace('\','/'))}}
[IO.File]::WriteAllText((Join-Path $profile 'package.json'),($manifest | ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
$portable = Join-Path $source 'tools\portable.ps1'
& $portable -Mode Install -DshPath $DshPath -DshHome $root -PluginSource $payloadSource
if ($LASTEXITCODE -ne 0) { throw 'Isolated install failed.' }
$after = Get-Content -Raw -LiteralPath (Join-Path $profile 'package.json') | ConvertFrom-Json
if (@($after.dsh.profile.bundles) -notcontains 'dsh-desktop-control') { throw 'Missing bundle after install.' }
$payload = Join-Path $root 'custom-plugins\dsh-desktop-control\desktop'
if (Test-Path -LiteralPath (Join-Path $payload 'test')) { throw 'Test artifacts leaked into installed payload.' }
& $portable -Mode Uninstall -DshPath $DshPath -DshHome $root -PluginSource $payloadSource
if ($LASTEXITCODE -ne 0) { throw 'Isolated removal failed.' }
$after = Get-Content -Raw -LiteralPath (Join-Path $profile 'package.json') | ConvertFrom-Json
if (@($after.dsh.profile.bundles) -contains 'dsh-desktop-control' -or $after.dependencies.PSObject.Properties['dsh-desktop-control']) { throw 'Registration remains after removal.' }
if ($after.dependencies.'dsh-plugin-hub' -ne $manifest.dependencies.'dsh-plugin-hub' -or @($after.dsh.profile.bundles).Count -ne 1) { throw 'Unrelated registration changed.' }
if (Test-Path -LiteralPath $payload) { throw 'Payload remains in the active installation directory.' }
Write-Output ('Isolated install/remove passed: ' + $root)
