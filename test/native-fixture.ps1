param([Parameter(Mandatory=$true)][string]$ArtifactDirectory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FixtureVisibility {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[void][FixtureVisibility]::SetProcessDpiAwarenessContext([IntPtr](-4))
$form = New-Object Windows.Forms.Form
$form.Text = 'DSH Desktop Control isolated test'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object Drawing.Size(620, 360)
$form.TopMost = $false
$label = New-Object Windows.Forms.Label
$label.Text = 'DSH Desktop Control test window'
$label.AutoSize = $true; $label.Location = New-Object Drawing.Point(24, 20)
$edit = New-Object Windows.Forms.RichTextBox
$edit.Name = 'desktop-test-edit'; $edit.Text = 'native seed'; $edit.Multiline = $true
$edit.Location = New-Object Drawing.Point(24, 60); $edit.Size = New-Object Drawing.Size(560, 150)
$button = New-Object Windows.Forms.Button
$button.Name = 'desktop-test-button'; $button.Text = 'Verify click'
$button.Location = New-Object Drawing.Point(24, 232); $button.Size = New-Object Drawing.Size(160, 40)
$status = New-Object Windows.Forms.Label
$status.Name = 'desktop-test-status'; $status.AutoSize = $true; $status.Text = 'Clicks: 0'
$status.Location = New-Object Drawing.Point(210, 244)
$script:clicks = 0
$button.Add_Click({ $script:clicks++; $status.Text = 'Clicks: ' + $script:clicks })
$form.Controls.AddRange(@($label, $edit, $button, $status))
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  $state = @{ text = $edit.Text; clicks = $script:clicks; hwnd = $form.Handle.ToInt64(); focused = $edit.Focused }
  [IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'fixture-state.json'), ($state | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  if ([IO.File]::Exists((Join-Path $ArtifactDirectory 'fixture-close'))) { $form.Close() }
})
$form.Add_Shown({
  # Hidden PowerShell startup info may hide its first GUI window too.
  # Explicitly show only this fixture's HWND; no other windows are touched.
  [void][FixtureVisibility]::ShowWindow($form.Handle, 5)
  [Console]::WriteLine((@{ ready = $true; hwnd = $form.Handle.ToInt64(); pid = $PID } | ConvertTo-Json -Compress))
  $timer.Start()
})
try { [Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); $form.Dispose() }
