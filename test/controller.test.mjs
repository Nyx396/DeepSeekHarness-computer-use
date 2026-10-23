import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { artifactsDir } from './paths.mjs';
import { DesktopController, normalizedPoint } from '../lib/controller.js';
import { createTools } from '../lib/tools.js';
import { normalizeSettings } from '../lib/settings.js';
import { createRoute } from '../lib/index.js';

const exec = (id = 'a', turn = 1) => ({ signal: new AbortController().signal, agent: { session: { id, requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }) }, phase: { kind: 'running', turn } } });
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
async function fixture(t) {
  await fs.mkdir(artifactsDir, { recursive: true });
  const root = await fs.mkdtemp(path.join(artifactsDir, 'desktop-unit-'));
  const calls = [], win = { nativeWindowHandle: 12, name: 'Unit Fixture', processId: 34, boundingBox: { x: -800, y: 30, width: 500, height: 300 }, isOffscreen: false };
  const engine = { close: async () => {}, call: async (action, args, options) => {
    calls.push({ action, args });
    if (engine.override) return engine.override(action, args, options);
    if (action === 'list_windows') return result({ ok: true, windows: [win] });
    if (action === 'snapshot' || action === 'screenshot') return result({ ok: true, tree: { id: 'root', children: [{ id: 'edit', hasKeyboardFocus: true }] }, screenshot: { bounds: win.boundingBox } });
    return result({ ok: true, action, verification: 'sent' });
  } };
  const ctx = { approval: { request: async () => 'allowed-once' }, llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }, attachments: { saveImage: async () => { throw Error('Unexpected image'); } } };
  const controller = await new DesktopController(ctx, { configPath: path.join(root, 'config.json'), tempParent: root, engineFactory: () => engine }).init();
  const tools = Object.fromEntries(createTools(controller).map(tool => [tool.name.slice(8), tool]));
  const tokens = new Map();
  const call = async (name, args = {}, e = exec()) => {
    const id=e.agent.session.id;
    if (!tokens.has(id)) tokens.set(id,JSON.parse((await controller.beginTask(e,{task:'unit fixture task',windowTitles:['Unit Fixture'],benefit:'necessary',reason:'Exercise fixture only'})).text).authorizationId);
    return tools[name].execute({authorizationId:tokens.get(id),...args},e);
  };
  const observe = async (e = exec()) => JSON.parse((await call('observe', { window: 12 }, e)).text).observationId;
  t.after(async () => { await controller.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, calls, win, engine, ctx, controller, tools, call, observe };
}
test('every operating tool rejects a missing/forged task token before touching the engine',async t=>{
  const f=await fixture(t);
  for(const name of ['health','windows','activate','observe','click','type_text','keypress','scroll','drag']) {
    await assert.rejects(f.tools[name].execute({authorizationId:'forged',window:12},exec()),/AUTHORIZATION_REQUIRED/);
  }
  assert.equal(f.calls.length,0);
  const listed=JSON.parse((await f.call('windows')).text);
  assert.equal(listed.windows.length,1);assert.equal(listed.windows[0].name,'Unit Fixture');
  const granted=f.controller.authorization.grants.get('a');
  await f.controller.endTask(exec(),{authorizationId:granted.id});
  await assert.rejects(f.tools.windows.execute({authorizationId:granted.id},exec()),/AUTHORIZATION_REQUIRED/);
});
test('normalized window coordinates support negative monitors and clamp edges inside capture', () => {
  assert.deepEqual(normalizedPoint({ x: -1920, y: -200, width: 1920, height: 1080 }, 0, 1000), { x: -1920, y: 879 });
  assert.deepEqual(normalizedPoint({ x: 100, y: 200, width: 101, height: 101 }, 500, 500), { x: 150, y: 250 });
  assert.throws(() => normalizedPoint({}, 500, 500), /边界/);
  assert.throws(() => normalizedPoint({}, NaN, 500), /0–1000/);
  assert.throws(() => normalizedPoint({}, 1001, 500), /0–1000/);
});
test('input binds to the latest observation and is consumed once; dispatch never asserts task success', async t => {
  const f = await fixture(t), id = await f.observe();
  const action = JSON.parse((await f.call('click', { observationId: id, x: 500, y: 500 })).text);
  assert.equal(action.verification, 'sent');
  assert.deepEqual(f.calls.find(call => call.action === 'click').args, { nativeWindowHandle: 12, activate: true, x: -550, y: 180, button: 'left', dispatch: 'foreground' });
  await assert.rejects(f.call('type_text', { observationId: id, text: '你好' }), /观察已过期/);
  assert.equal(f.calls.filter(call => call.action === 'type_text').length, 0);
});
test('wrong session, old turn, unknown element and moved window never dispatch input', async t => {
  const f = await fixture(t); let id = await f.observe();
  await assert.rejects(f.call('click', { observationId: id, elementId: 'evil' }), /元素/);
  id = await f.observe();
  await assert.rejects(f.call('click', { observationId: id, elementId: 'edit' }, exec('b')), /DESKTOP_BUSY/);
  await assert.rejects(f.call('click', { observationId: id, elementId: 'edit' }, exec('a', 2)), /观察已过期/);
  id = await f.observe(); f.win.boundingBox = { ...f.win.boundingBox, x: 100 };
  await assert.rejects(f.call('click', { observationId: id, x: 500, y: 500 }), /位置已变化/);
  assert.equal(f.calls.filter(call => call.action === 'click').length, 0);
});

test('an already foreground window preserves focus without an extra activation Alt tap', async t => {
  const f = await fixture(t); f.win.hasKeyboardFocus = true;
  const id = await f.observe();
  await f.call('keypress', { observationId: id, keys: ['ctrl', 'a'] });
  assert.equal(f.calls.find(call => call.action === 'keypress').args.activate, false);
});

test('window screenshot returns a native attachment plus exact real PNG preview; preview errors are explicit',async t=>{
  const f=await fixture(t);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=','base64');
  f.ctx.attachments.saveImage=async()=>({attachmentId:'sha256:'+'1'.repeat(64),mediaType:'image/png',bytes:png.length,width:1,height:1});
  f.engine.override=async action=>action==='list_windows'?result({windows:[f.win]}):{content:[{type:'text',text:JSON.stringify({screenshot:{bounds:f.win.boundingBox,method:'printwindow'}})},{type:'image',mimeType:'image/png',data:png.toString('base64')}]};
  const output=await f.call('observe',{window:12}),data=JSON.parse(output.text);
  assert.equal(output.images.length,1);assert.deepEqual(await fs.readFile(data.imagePreviews[0].path),png);
  assert.equal(data.imagePreviews[0].attachmentId,output.images[0].attachmentId);
  f.controller.previewDirectory=path.join(f.root,'not-a-directory');await fs.writeFile(f.controller.previewDirectory,'occupied');
  const failed=await f.call('observe',{window:12});
  assert.equal(failed.images.length,1);assert.match(JSON.parse(failed.text).imagePreviews[0].error,/预览生成失败/);
});

test('failed, whole-desktop and occluded captures never reach attachment storage or authorize input', async t => {
  const f = await fixture(t);
  let saved = 0;
  f.ctx.attachments.saveImage = async () => { saved++; throw Error('Unexpected image persistence'); };
  for (const screenshot of [{ method: 'screen' }, { method: 'printwindow', windowCaptureFailed: true }, { method: 'screen-region', occludedPossible: true }]) {
    f.engine.override = async action => action === 'list_windows' ? result({ windows: [f.win] }) : { content: [
      { type: 'text', text: JSON.stringify({ screenshot: { ...screenshot, bounds: f.win.boundingBox } }) },
      { type: 'image', mimeType: 'image/png', data: 'blocked-before-decoding' },
    ] };
    await assert.rejects(f.observe(), /目标窗口画面/);
    assert.equal(f.controller.observations.size, 0);
  }
  f.engine.override = async action => action === 'list_windows' ? result({ windows: [f.win] }) : result({ action: 'ocr', source: 'window', occludedPossible: true });
  await assert.rejects(f.call('observe', { window: 12, mode: 'ocr' }), /目标窗口画面/);
  assert.equal(saved, 0);
});
test('text-only models can use tree observations; screenshots check the current session model', async t => {
  const f = await fixture(t); f.ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['text'] });
  await assert.rejects(f.observe(), /未声明看图/);
  assert.equal(f.calls.some(call => call.action === 'snapshot'), false);
  await f.call('observe', { window: 12, mode: 'tree' });
  assert.equal(f.calls.find(call => call.action === 'snapshot').args.includeScreenshot, false);
});
test('a failed input is not retried, old observation is invalid, and a new turn may proceed', async t => {
  const f = await fixture(t), id = await f.observe();
  const original = f.engine.call;
  f.engine.call = async (...args) => { if (args[0] === 'click') { f.calls.push({ action: 'click' }); throw Error('input timed out'); } return original(...args); };
  await assert.rejects(f.call('click', { observationId: id, elementId: 'edit' }), /timed out/);
  await assert.rejects(f.call('click', { observationId: id, elementId: 'edit' }), /观察已过期/);
  assert.equal(f.calls.filter(call => call.action === 'click').length, 1);
  await f.call('windows', {}, exec('a', 2));
  await f.controller.release('a', 2); await f.call('windows', {}, exec('b'));
});
test('pause aborts an in-flight call and rejects further calls until enabled', async t => {
  const f = await fixture(t); let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.engine.override = (_action, _args, { signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  const pending = f.call('windows'); const rejected = assert.rejects(pending, /暂停/); await ready;
  await f.controller.saveSettings({ enabled: false, screenshotWidth: 960 }); await rejected;
  await assert.rejects(f.call('windows'), /暂停/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, 'config.json'), 'utf8')), { enabled: false, screenshotWidth: 960 });
});
test('route validates config and exposes status only, without arbitrary actions or paths', async t => {
  const f = await fixture(t), route = createRoute(f.controller);
  assert.equal((await route.fetch(new Request('http://localhost/api/plugins/desktop-control'))).status, 200);
  assert.equal((await route.fetch(new Request('http://localhost/', { method: 'POST', body: '{}' }))).status, 415);
  assert.equal((await route.fetch(new Request('http://localhost/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"command":"evil"}' }))).status, 400);
  assert.throws(() => normalizeSettings({ enabled: 'false' }), /布尔值/);
});
