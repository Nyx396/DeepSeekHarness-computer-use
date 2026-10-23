import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeTargetSource } from './target.js';

const upstream = new URL('../vendor/windows-engine/', import.meta.url);
const visuals = new URL('./windows/visuals.cs', import.meta.url);
const runtimeFiles = ['package.json', 'LICENSE', 'mcp/server.mjs', 'mcp/settings.mjs', 'mcp/takeover.mjs', 'scripts/windows-uia.ps1', 'scripts/windows-takeover.ps1'];

// Only the package-owned disposable copy is adapted. The pinned vendor bytes,
// stop hook remains unchanged; target preparation/guards are composed separately.
export function composeOverlaySource(original, rendering) {
  const source = original.replace(/\r\n/g, '\n');
  const pointerStart = '    internal static Bitmap Draw(float zoom,bool left,bool up) {';
  const frameStart = '  internal sealed class Frame : Form {';
  const tick = '        if (elapsed >= 0) foreach (var frame in frames) frame.Present(alpha);';
  for (const marker of [pointerStart, frameStart, tick]) {
    if (source.split(marker).length !== 2) throw new Error('上游覆盖层结构变化，拒绝套用视觉适配：' + marker.trim());
  }
  const at = source.indexOf(pointerStart);
  const after = source.indexOf('    protected override void Dispose(bool disposing) {', at);
  const frameAt = source.indexOf(frameStart);
  if (after < at || after > frameAt || !source.trimEnd().endsWith('}\n}')) throw new Error('上游覆盖层结构不匹配。');
  const pointer = '    internal static Bitmap Draw(float zoom,bool left,bool up) {\n      return OverlayVisuals.DrawPointer(zoom,left,up);\n    }\n';
  return (source.slice(0, at) + pointer + source.slice(after, frameAt) + '}\n' + rendering)
    .replace(tick, '        foreach (var frame in frames) frame.Present(alpha);');
}

export async function prepareWindowsRuntime(directory) {
  const root = path.join(directory, 'windows-engine');
  await fs.mkdir(path.join(root, 'mcp'), { recursive: true });
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  for (const relative of runtimeFiles) await fs.copyFile(fileURLToPath(new URL(relative, upstream)), path.join(root, relative));
  const [original, rendering] = await Promise.all([
    fs.readFile(new URL('scripts/windows-takeover.cs', upstream), 'utf8'), fs.readFile(visuals, 'utf8'),
  ]);
  await fs.writeFile(path.join(root, 'scripts/windows-takeover.cs'), composeOverlaySource(original, rendering), 'utf8');
  const [backend, targetHelper] = await Promise.all([
    fs.readFile(new URL('scripts/windows-uia.ps1', upstream), 'utf8'),
    fs.readFile(new URL('./windows/target.ps1', import.meta.url), 'utf8'),
  ]);
  await fs.copyFile(fileURLToPath(new URL('./windows/target.cs', import.meta.url)), path.join(root, 'scripts/dsh-window-target.cs'));
  await fs.writeFile(path.join(root, 'scripts/windows-uia.ps1'), composeTargetSource(backend, targetHelper), 'utf8');
  return path.join(root, 'mcp/server.mjs');
}
