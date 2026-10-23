param([Parameter(Mandatory=$true)][string]$ArtifactDirectory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VisionFixtureNative {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[void][VisionFixtureNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
$script:challenge = 'CU-' + [Guid]::NewGuid().ToString('N').Substring(0,4).ToUpperInvariant()
$form = New-Object Windows.Forms.Form
$form.Text = 'DSH Computer Use vision validation'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object Drawing.Size(620,360)
$canvas = New-Object Windows.Forms.Panel
$canvas.Location = New-Object Drawing.Point(24,15)
$canvas.Size = New-Object Drawing.Size(560,65)
$font = New-Object Drawing.Font('Consolas',28,[Drawing.FontStyle]::Bold)
$canvas.Add_Paint({ param($sender,$event) $event.Graphics.DrawString($script:challenge,$font,[Drawing.Brushes]::DarkBlue,10,8) })
$edit = New-Object Windows.Forms.RichTextBox
$edit.Name = 'vision-test-edit'
$edit.Text = ''
$edit.Location = New-Object Drawing.Point(24,100)
$edit.Size = New-Object Drawing.Size(560,105)
$button = New-Object Windows.Forms.Button
$button.Name = 'vision-test-verify'
$button.Text = 'Verify'
$button.Location = New-Object Drawing.Point(24,240)
$button.Size = New-Object Drawing.Size(160,42)
$status = New-Object Windows.Forms.Label
$status.Text = 'Waiting'; $status.AutoSize = $true
$status.Location = New-Object Drawing.Point(210,254)
$script:clicks = 0
$button.Add_Click({ $script:clicks++; $status.Text = if ($edit.Text -ceq $script:challenge) { 'PASS' } else { 'MISMATCH' } })
$form.Controls.AddRange(@($canvas,$edit,$button,$status))
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({
  $state = @{expected=$script:challenge;text=$edit.Text;clicks=$script:clicks;status=$status.Text;hwnd=$form.Handle.ToInt64()}
  [IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'fixture-state.json'),($state | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
  if ([IO.File]::Exists((Join-Path $ArtifactDirectory 'fixture-close'))) { $form.Close() }
})
$form.Add_Shown({
  [void][VisionFixtureNative]::ShowWindow($form.Handle,5)
  [Console]::WriteLine((@{ready=$true;hwnd=$form.Handle.ToInt64();pid=$PID} | ConvertTo-Json -Compress))
  $timer.Start()
})
try { [Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose();$font.Dispose();$form.Dispose() }
