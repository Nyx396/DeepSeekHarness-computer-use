import fs from 'node:fs/promises';
import path from 'node:path';
import { testDir, artifactsDir } from './paths.mjs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { DesktopController } from '../lib/controller.js';
import { createTools } from '../lib/tools.js';

const artifacts = path.join(artifactsDir, 'native-' + Date.now());
await fs.mkdir(artifacts, { recursive: true });
const fixture = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(testDir, 'native-fixture.ps1'), '-ArtifactDirectory', artifacts], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let buffer = '', diagnostics = '';
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Fixture startup timed out: ' + diagnostics)), 20000);
  fixture.stderr.on('data', chunk => { diagnostics += chunk; });
  fixture.once('error', reject); fixture.once('exit', code => { clearTimeout(timer); reject(Error('Fixture exited: ' + code + diagnostics)); });
  fixture.stdout.on('data', chunk => { buffer += chunk; for (const line of buffer.split('\n')) { try { const value = JSON.parse(line); if (value.ready) { clearTimeout(timer); resolve(value); } } catch {} } });
});
const saved = [];
const ctx = {
  approval: { request: async () => 'allowed-once' },
  llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
  attachments: { saveImage: async ({ data, mediaType }) => {
    const filename = path.join(artifacts, 'capture-' + saved.length + '.png'); await fs.writeFile(filename, data); saved.push(filename);
    return { attachmentId: 'sha256:' + '1'.repeat(64), mediaType, bytes: data.length, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  } },
};
let controller;
const results = [];
try {
  const window = await ready;
  controller = await new DesktopController(ctx, { configPath: path.join(artifacts, 'settings.json'), tempParent: artifacts }).init();
  const exec = { signal: AbortSignal.timeout(150000), agent: { session: { id: 'isolated-native-test', requestHeader: () => ({ config: { provider: 'fixture', model: 'vision-contract-only' } }) }, phase: { kind: 'running', turn: 1 } } };
  const tools = Object.fromEntries(createTools(controller).map(tool => [tool.name.slice(8), tool]));
  let authorizationId = JSON.parse((await controller.beginTask(exec,{task:'native fixture test',windowTitles:[],benefit:'necessary',reason:'Exercise this isolated fixture only'})).text).authorizationId;
  const call = async (name, args = {}) => { const value = await tools[name].execute({authorizationId,...args}, exec); const data = JSON.parse(value.text); results.push({ tool: name, ...data }); console.log(JSON.stringify({ step: name, ok: data.ok ?? true, images: value.images.length })); return data; };
  await call('health');
  const listed = await call('windows');
  console.log(JSON.stringify({ fixture: window, found: listed.windows.some(item => item.nativeWindowHandle === window.hwnd) }));
  assert.ok(listed.windows.some(item => item.nativeWindowHandle === window.hwnd));
  const title = listed.windows.find(item => item.nativeWindowHandle === window.hwnd).name;
  authorizationId = JSON.parse((await controller.beginTask(exec,{task:'native fixture test',windowTitles:[title],benefit:'necessary',reason:'Exercise only the fixture window'})).text).authorizationId;
  await call('activate', { window: window.hwnd });
  let seen = await call('observe', { window: window.hwnd });
  const find = (tree, name) => { if (tree?.automationId === name) return tree; for (const child of tree?.children || []) { const match = find(child, name); if (match) return match; } };
  const edit = find(seen.tree, 'desktop-test-edit'); assert.ok(edit?.id, 'UIA sees isolated editor');
  await call('click', { observationId: seen.observationId, elementId: edit.id });
  seen = await call('observe', { window: window.hwnd });
  await call('keypress', { observationId: seen.observationId, keys: ['ctrl', 'a'] });
  seen = await call('observe', { window: window.hwnd });
  const text = '你好，桌面操作。Cloud API + local input ✓';
  await call('type_text', { observationId: seen.observationId, text });
  seen = await call('observe', { window: window.hwnd });
  const button = find(seen.tree, 'desktop-test-button'); assert.ok(button?.id, 'UIA sees button');
  const rect = button.boundingBox, bounds = seen.screenshot.bounds;
  assert.ok(rect && bounds);
  // Exercise normalized image coordinates, not just a UIA input path.
  await call('click', { observationId: seen.observationId, x: (rect.x + rect.width / 2 - bounds.x) * 1000 / (bounds.width - 1), y: (rect.y + rect.height / 2 - bounds.y) * 1000 / (bounds.height - 1) });
  await call('observe', { window: window.hwnd, mode: 'ocr' });
  await new Promise(resolve => setTimeout(resolve, 350));
  const final = JSON.parse(await fs.readFile(path.join(artifacts, 'fixture-state.json'), 'utf8'));
  assert.equal(final.text, text, 'Unicode text arrived in the intended editor'); assert.equal(final.clicks, 1, 'coordinate click reached button exactly once'); assert.ok(saved.length >= 4);
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ ok: true, window, final, imageCount: saved.length, steps: results }, null, 2));
  console.log(JSON.stringify({ ok: true, artifacts, final, imageCount: saved.length }));
} finally {
  await fs.writeFile(path.join(artifacts, 'steps.json'), JSON.stringify(results, null, 2));
  await controller?.release('isolated-native-test', 1); await controller?.close();
  await fs.writeFile(path.join(artifacts, 'fixture-close'), 'close');
  await new Promise(resolve => { if (fixture.exitCode !== null) return resolve(); const timer = setTimeout(() => { fixture.kill(); resolve(); }, 3000); fixture.once('exit', () => { clearTimeout(timer); resolve(); }); });
}
