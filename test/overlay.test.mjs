import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactsDir } from './paths.mjs';
import { composeOverlaySource,prepareWindowsRuntime } from '../lib/overlay.js';

test('presentation adapts a disposable runtime while retaining upstream stop/input code',async t=>{
  const original=await fs.readFile(new URL('../vendor/windows-engine/scripts/windows-takeover.cs',import.meta.url),'utf8');
  const rendering=await fs.readFile(new URL('../lib/windows/visuals.cs',import.meta.url),'utf8');
  const adapted=composeOverlaySource(original,rendering);
  const stop=source=>source.slice(source.indexOf('    IntPtr OnKey('),source.indexOf('    void ShowFrames()'));
  assert.equal(stop(adapted),stop(original.replace(/\r\n/g,'\n')));
  assert.ok(adapted.includes('return OverlayVisuals.DrawPointer(zoom,left,up)'));
  assert.equal(adapted.includes('DrawEllipse'),false);
  assert.throws(()=>composeOverlaySource(original.replace('internal sealed class Frame : Form','internal sealed class NewFrame : Form'),rendering),/结构变化/);
  await fs.mkdir(artifactsDir,{recursive:true});
  const root=await fs.mkdtemp(path.join(artifactsDir,'overlay-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const script=await prepareWindowsRuntime(root);
  assert.equal(path.dirname(script),path.join(root,'windows-engine','mcp'));
  assert.equal(await fs.readFile(path.join(root,'windows-engine/scripts/windows-takeover.cs'),'utf8'),adapted);
  assert.equal(await fs.readFile(new URL('../vendor/windows-engine/scripts/windows-takeover.cs',import.meta.url),'utf8'),original);
});
