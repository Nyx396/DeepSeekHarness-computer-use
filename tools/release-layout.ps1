#Requires -Version 5.1
# Explicit runtime file allowlist. Local records can never enter via recursion.
$script:DesktopControlReleaseFiles = @(
    'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD_PARTY.md',
    'lib/authorization.js', 'lib/client.js', 'lib/controller.js', 'lib/engine.js',
    'lib/index.js', 'lib/overlay.js', 'lib/preview.js', 'lib/settings.js',
    'lib/skill.js', 'lib/tools.js', 'lib/windows/visuals.cs',
    'skills/computer-use/SKILL.md',
    'vendor/windows-engine/package.json', 'vendor/windows-engine/LICENSE',
    'vendor/windows-engine/THIRD_PARTY.md', 'vendor/windows-engine/UPSTREAM.json',
    'vendor/windows-engine/mcp/server.mjs', 'vendor/windows-engine/mcp/settings.mjs',
    'vendor/windows-engine/mcp/takeover.mjs',
    'vendor/windows-engine/scripts/windows-uia.ps1',
    'vendor/windows-engine/scripts/windows-takeover.ps1',
    'vendor/windows-engine/scripts/windows-takeover.cs',
    'vendor/windows-engine/docs/wiki/Home.md',
    'vendor/windows-engine/docs/wiki/architecture.md',
    'vendor/windows-engine/docs/wiki/app-technology-matrix.md',
    'vendor/windows-engine/docs/wiki/mac-codex-computer-use.md',
    'vendor/windows-engine/docs/wiki/mcp-tools.md',
    'vendor/windows-engine/docs/wiki/safety.md'
)
# Unicode names are constructed so PS 5.1 can read this script without a BOM.
$script:DesktopControlDeliveryFiles = @(
    (([string][char]0x5B89) + [char]0x88C5 + '.cmd'),
    (([string][char]0x5378) + [char]0x8F7D + '.cmd'),
    (([string][char]0x68C0) + [char]0x67E5 + [char]0x73AF + [char]0x5883 + '.cmd'),
    (([string][char]0x4F7F) + [char]0x7528 + [char]0x8BF4 + [char]0x660E + '.txt')
)
$script:DesktopControlZipFiles = @($script:DesktopControlReleaseFiles | ForEach-Object { 'plugin/' + $_ }) + @('tools/portable.ps1') + $script:DesktopControlDeliveryFiles
