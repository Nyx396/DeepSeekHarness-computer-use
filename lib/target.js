// Adapt only the private runtime copy. Missing/ambiguous anchors fail closed
// rather than silently running an upstream worker without the input guards.
export function composeTargetSource(original, helper) {
  let source = original.replace(/\r\n/g, '\n');
  const replace = (before, after, count = 1) => {
    if (source.split(before).length !== count + 1) throw new Error('上游目标窗口适配结构变化：' + before.slice(0, 70));
    source = source.split(before).join(after);
  };
  const action = 'function Invoke-Action {\n  param([string]$Action, [object]$inputObject = $null)';
  replace(action, helper + '\n\n' + action + '\n  $script:DshInputArgs = $inputObject\n  $script:DshPointerPoint = $null');
  // Minimized windows are still discoverable targets for restoration. Truly
  // hidden windows remain excluded from the normal model-facing enumeration.
  replace('if (-not $IncludeInvisible -and (-not $visible -or [WindowsComputerUseNative]::IsIconic($handle))) { continue }',
    'if (-not $IncludeInvisible -and -not $visible) { continue }');
  const start = source.indexOf('    "activate_window" {');
  const end = source.indexOf('    "cursor_pos" {', start);
  if (start < 0 || end <= start || source.split('    "activate_window" {').length !== 2) throw new Error('上游激活入口结构变化。');
  source = source.slice(0, start) + '    "activate_window" { return (Prepare-DshTarget $inputObject) }\n' + source.slice(end);
  // Check before moving, and again immediately before each mouse-down/wheel.
  replace('function Move-ToPoint {\n  param([int]$X, [int]$Y)', 'function Move-ToPoint {\n  param([int]$X, [int]$Y)\n  Assert-DshPoint -X $X -Y $Y\n  $script:DshPointerPoint = @{x=$X;y=$Y}');
  const down = 'if ([WindowsComputerUseNative]::SendMouseEvent(0, 0, [uint32]$flags[0], 0) -ne 1)';
  replace(down, 'Assert-DshCurrentPointer\n    ' + down, 2);
  for (const flag of ['MOUSEEVENTF_WHEEL', 'MOUSEEVENTF_HWHEEL']) {
    const lines = source.split('\n').filter(line => line.includes('SendMouseEvent(') && line.includes('::' + flag + ','));
    if (lines.length !== 1) throw new Error('上游滚动入口结构变化：' + flag);
    replace(lines[0], lines[0].match(/^\s*/u)[0] + 'Assert-DshCurrentPointer\n' + lines[0]);
  }
  for (const call of ["[System.Windows.Forms.SendKeys]::SendWait('^v')", '[System.Windows.Forms.SendKeys]::SendWait($chord)']) {
    replace(call, 'Assert-TargetIsForeground $script:DshInputArgs\n    ' + call);
  }
  return source;
}
