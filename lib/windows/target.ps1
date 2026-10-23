# Loaded only inside the plugin-owned disposable worker, before dispatch.
Add-Type -Path (Join-Path $PSScriptRoot 'dsh-window-target.cs')
$script:DshInputArgs = $null
$script:DshPointerPoint = $null
function Assert-DshPoint {
  param([int]$X,[int]$Y,[bool]$CheckCursor=$false)
  $target = [long](Get-Prop $script:DshInputArgs 'nativeWindowHandle' 0)
  if ($target -le 0) { throw 'DESKTOP_TARGET_REQUIRED: input has no exact target.' }
  [DshDesktopControl.TargetWorkflow]::AssertPoint($target,$X,$Y,$CheckCursor,[Action]{[void](Test-Failsafe)})
}
function Assert-DshCurrentPointer {
  if ($null -eq $script:DshPointerPoint) { throw 'DESKTOP_TARGET_REQUIRED: no checked pointer position.' }
  Assert-DshPoint -X $script:DshPointerPoint.x -Y $script:DshPointerPoint.y -CheckCursor $true
}
function Assert-TargetIsForeground {
  param([object]$InputObject)
  $target = [long](Get-Prop $InputObject 'nativeWindowHandle' 0)
  if ($target -le 0) { throw 'DESKTOP_TARGET_REQUIRED: input has no exact target.' }
  [DshDesktopControl.TargetWorkflow]::AssertKeyboard($target,[Action]{[void](Test-Failsafe)})
}
function Prepare-DshTarget {
  param([object]$InputObject)
  if (-not (Has-WindowTarget $InputObject)) { throw 'DESKTOP_TARGET_REQUIRED: preparation has no exact target.' }
  $window = Get-ObservationWindow $InputObject
  Assert-WindowIdentity $InputObject $window
  if (-not (Get-WindowResponsive $window)) { throw 'DESKTOP_TARGET_UNRESPONSIVE: target did not respond; no window/input mutation was attempted.' }
  $prepared = [DshDesktopControl.TargetWorkflow]::Prepare([long]$window.nativeWindowHandle,[Action]{[void](Test-Failsafe)})
  $window = Get-ObservationWindow $InputObject
  Update-WindowCache $window
  Update-WindowIdentity $InputObject $window
  $result = [ordered]@{ok=$prepared.ready;action='activate_window';activated=$prepared.ready;interactionReady=$prepared.ready;preparation=$prepared;window=$window}
  if (-not $prepared.ready) { $result.error = $prepared.reason + ' Preparation: ' + ($prepared | ConvertTo-Json -Depth 8 -Compress) }
  return $result
}
