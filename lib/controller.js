import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WindowsEngine, resultData } from './engine.js';
import { DEFAULTS, normalizeSettings } from './settings.js';
import { savePreview } from './preview.js';
import { TaskAuthorization } from './authorization.js';

const STALE_MS = 120000;
export const BUSY = 'DESKTOP_BUSY: 另一个会话正在操作桌面，请等待它结束或停止它。';
export function normalizedPoint(bounds, x, y) {
  for (const value of [x, y]) if (!Number.isFinite(value) || value < 0 || value > 1000) throw new Error('坐标须为窗口内 0–1000 的比例坐标。');
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error('当前观察没有有效截图边界，请重新截图。');
  return { x: Math.round(bounds.x + (bounds.width - 1) * x / 1000), y: Math.round(bounds.y + (bounds.height - 1) * y / 1000) };
}
export function collectIds(tree, out = new Set()) {
  if (!tree || typeof tree !== 'object') return out;
  if (typeof tree.id === 'string') out.add(tree.id);
  for (const child of tree.children || []) collectIds(child, out);
  return out;
}
function identity(exec) {
  const id = exec.agent?.session?.id;
  const turn = exec.agent?.phase?.kind === 'running' ? exec.agent.phase.turn : undefined;
  if (!id || turn === undefined) throw new Error('桌面工具需要一个正在运行的 DSH 会话。');
  return { id, turn, key: JSON.stringify([id, turn]) };
}
async function atomicJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx' }); await fs.rename(temporary, filename); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

export class DesktopController {
  constructor(ctx, { configPath, tempParent = os.tmpdir(), engineFactory = options => new WindowsEngine(options), now = Date.now } = {}) {
    this.ctx = ctx; this.configPath = configPath; this.tempParent = tempParent; this.engineFactory = engineFactory; this.now = now;
    this.previewDirectory = path.join(path.dirname(configPath), 'cache', 'dsh-desktop-control', 'previews');
    this.observations = new Map(); this.settings = { ...DEFAULTS }; this.closed = false; this.lastError = null;
    this.authorization = new TaskAuthorization({ approver: () => this.ctx.get?.('approval') ?? this.ctx.approval, now });
  }
  async init() {
    try { this.settings = normalizeSettings(JSON.parse(await fs.readFile(this.configPath, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') { this.settings.enabled = false; this.lastError = '配置无法读取，桌面工具已暂停。请在插件配置中重新保存。'; } }
    await fs.mkdir(this.tempParent, { recursive: true });
    this.runtimeDir = await fs.mkdtemp(path.join(this.tempParent, 'dsh-desktop-control-'));
    this.configFile = path.join(this.runtimeDir, 'engine.json'); this.stateFile = path.join(this.runtimeDir, 'state.json'); this.activityFile = path.join(this.runtimeDir, 'activity.json');
    await atomicJson(this.configFile, { indicatorText: 'DSH 正在操作桌面', stopShortcut: 'Ctrl+Alt+F12' });
    await this.publish();
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      this.publish().catch(error => { this.lastError = error.message; this.active?.abort(error); });
    }, 1000);
    this.heartbeat.unref();
    return this;
  }
  async publish() {
    const update = (this.publishing ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.owner && !this.active && this.now() - this.owner.touched > 30000) this.owner = null;
      await atomicJson(this.activityFile, { active: !!this.owner, sessionId: this.owner?.id ?? null, turn: this.owner?.turn ?? null, expiresAt: this.owner ? Date.now() + 5000 : 0 });
    });
    this.publishing = update;
    return update;
  }
  getEngine() {
    if (!this.engine) this.engine = this.engineFactory({ runtimeDirectory: this.runtimeDir, env: { WCU_CONFIG_FILE: this.configFile, WCU_STATE_FILE: this.stateFile, WCU_ACTIVITY_FILE: this.activityFile, TEMP: this.runtimeDir, TMP: this.runtimeDir } });
    return this.engine;
  }
  async beginTask(exec, args) {
    if (this.closed || !this.settings.enabled) throw new Error('桌面插件已关闭或暂停。');
    if (this.active) throw new Error(BUSY);
    const who = identity(exec); this.observations.delete(who.id);
    return { text: JSON.stringify(await this.authorization.begin(exec, who, args)), images: [] };
  }
  async endTask(exec, args) {
    if (this.active) throw new Error(BUSY);
    const who = identity(exec); this.authorization.require(who, args.authorizationId);
    this.authorization.revoke(who.id); this.observations.delete(who.id);
    if (this.owner?.id === who.id && !this.active) {
      this.owner = null; const engine = this.engine; this.engine = null; await engine?.close(); await this.publish();
    }
    return { text: JSON.stringify({ ended: true, next: 'New tasks require fresh approval.' }), images: [] };
  }
  async run(exec, action, authorizationId) {
    if (this.closed) throw new Error('桌面插件已关闭。');
    if (!this.settings.enabled) throw new Error('桌面工具已暂停。请在插件配置 > 桌面操作中启用。');
    const who = identity(exec);
    const grant = this.authorization.require(who, authorizationId);
    if (this.active || this.owner && this.owner.id !== who.id && this.now() - this.owner.touched <= 30000) throw new Error(BUSY);
    // A new turn in the same conversation may replace the previous idle turn.
    if (this.owner?.id === who.id && !this.active) this.owner = null;
    this.owner = { ...who, touched: this.now() };
    const active = this.active = new AbortController();
    let done;
    this.currentDone = new Promise(resolve => { done = resolve; });
    const signal = AbortSignal.any([exec.signal, active.signal]);
    try {
      signal.throwIfAborted(); await this.publish();
      const value = await action(signal, who, grant);
      this.lastError = null;
      return value;
    } catch (error) {
      this.lastError = error.message;
      // Outcomes of failed input calls are unknown. No retry, no queue replay.
      this.observations.delete(who.id);
      const engine = this.engine; this.engine = null;
      await engine?.close();
      throw error;
    } finally {
      if (this.active === active) this.active = null;
      if (this.owner?.key === who.key) this.owner.touched = this.now();
      try { await this.publish(); } finally { done(); }
    }
  }
  async call(action, args, signal) { return this.getEngine().call(action, args, { signal }); }
  async window(handle, signal, who) {
    if (!Number.isSafeInteger(handle) || handle <= 0) throw new Error('必须使用 desktop_windows 返回的明确窗口句柄。');
    const result = resultData(await this.call('list_windows', { maxWindows: 200 }, signal));
    const win = result.windows?.find(window => window.nativeWindowHandle === handle);
    if (!win || win.isOffscreen) throw new Error('目标窗口不存在、已最小化或不可见。请重新列出窗口。');
    if (win.responsive === false || win.targetResponsive === false) throw new Error('目标窗口无响应，请稍后重新观察。');
    this.authorization.window(who, win);
    return win;
  }
  async vision(exec, signal) {
    const config = exec.agent.session.requestHeader()?.config;
    const provider = config?.provider ?? exec.agent.options?.provider, model = config?.model ?? exec.agent.options?.model;
    if (!provider || !model) throw new Error('请先在当前会话选择一个支持图片输入的模型。');
    const info = await this.ctx.llm.resolveModelInfo(provider, model, signal);
    if (!info?.inputModalities?.includes('image')) throw new Error(`当前模型 ${model} 未声明看图能力，请切换模型；无需安装本地大模型。`);
    return { provider, model };
  }
  async output(result, extra = {}, signal) {
    const data = resultData(result);
    const raw = data.screenshot?.path ?? (data.action === 'ocr' ? data.image : undefined);
    try {
      // Upstream can fall back to the virtual desktop or an occluded screen
      // crop. Never persist/forward those pixels as the requested window.
      if (data.screenshot?.windowCaptureFailed || data.screenshot?.method === 'screen' || data.screenshot?.occludedPossible || data.captureMethod === 'screen' || data.source === 'desktop' || data.action === 'ocr' && data.occludedPossible) throw new Error('未能取得无遮挡的目标窗口画面。请激活或还原该窗口后重新观察。');
      if (data.screenshot) { delete data.screenshot.path; delete data.screenshot.base64; }
      if (data.action === 'ocr') delete data.image;
      const images = [], imagePreviews = [];
      for (const block of result.content || []) {
        if (block.type !== 'image') continue;
        if (!data.screenshot) throw new Error('截图缺少目标窗口元数据。请重新观察。');
        signal?.throwIfAborted();
        const bytes = Buffer.from(block.data, 'base64');
        if (block.mimeType !== 'image/png' || bytes.length > 16 * 1024 * 1024) throw new Error('截图格式或大小超出限制。');
        const attachment = await this.ctx.attachments.saveImage({ data: bytes, mediaType: block.mimeType, name: 'desktop-window.png' });
        images.push(attachment);
        try { imagePreviews.push({ attachmentId: attachment.attachmentId, ...await savePreview(this.previewDirectory, bytes, signal) }); }
        catch (error) {
          signal?.throwIfAborted();
          imagePreviews.push({ attachmentId: attachment.attachmentId, error: '原生截图附件已保存，但最终回复预览生成失败：' + error.message });
        }
      }
      return { text: JSON.stringify({ ...data, ...extra, ...(imagePreviews.length ? { imagePreviews } : {}) }), images };
    } finally {
      // Only the engine's exact per-instance capture path may be removed.
      if (raw && path.dirname(path.resolve(raw)) === path.resolve(this.runtimeDir) && /^windows-computer-use-[0-9a-f-]+\.png$/i.test(path.basename(raw))) await fs.unlink(raw).catch(() => {});
    }
  }
  async observe(args, exec, signal, who) {
    const win = await this.window(args.window, signal, who);
    const mode = args.mode ?? 'both';
    if (!['both', 'screenshot', 'tree', 'ocr'].includes(mode)) throw new Error('mode 须为 both、screenshot、tree 或 ocr。');
    const image = mode === 'both' || mode === 'screenshot';
    if (image) await this.vision(exec, signal);
    const target = { nativeWindowHandle: args.window, activate: false, scope: 'active_window' };
    const width = this.settings.screenshotWidth;
    const result = mode === 'screenshot' ? await this.call('screenshot', { ...target, maxWidth: width }, signal)
      : mode === 'ocr' ? await this.call('ocr', { ...target, maxWidth: width, resolveControl: false, includeScreenshot: false }, signal)
        : await this.call('snapshot', { ...target, includeScreenshot: image, captureWindow: true, maxWidth: width, maxNodes: 250, maxDepth: 6, treeTimeoutMs: 3500 }, signal);
    const data = resultData(result);
    const observationId = randomUUID();
    this.observations.set(who.id, { id: observationId, who: who.key, time: this.now(), handle: args.window, processId: win.processId, bounds: data.screenshot?.bounds, windowBox: win.boundingBox, ids: collectIds(data.tree), occluded: data.screenshot?.occludedPossible === true });
    return this.output(result, { observationId, window: args.window, coordinates: 'For coordinate input, x/y are 0–1000 within this WINDOW image: left/top=0, right/bottom=1000. Do not send physical screen pixels. UIA elementId may be used instead. One input consumes this observation; observe again after each input.', expiresInSeconds: 120 }, signal);
  }
  async input(action, args, signal, who) {
    const observation = this.observations.get(who.id);
    if (!observation || observation.id !== args.observationId || observation.who !== who.key || this.now() - observation.time > STALE_MS) throw new Error('观察已过期或不属于当前轮次。先调用 desktop_observe 再操作。');
    // Consume before any await, including failure. Unknown outcomes are never replayed.
    this.observations.delete(who.id);
    const win = await this.window(observation.handle, signal, who);
    if (win.processId !== observation.processId || JSON.stringify(win.boundingBox) !== JSON.stringify(observation.windowBox)) throw new Error('目标窗口或位置已变化，请重新观察后再操作。');
    // Re-activating an already foreground window taps Alt in this engine and
    // can enter menu mode, swallowing the next paste/chord. Keep current focus.
    const target = { nativeWindowHandle: observation.handle, activate: win.hasKeyboardFocus !== true };
    const point = () => {
      if (args.elementId) {
        if (args.x !== undefined || args.y !== undefined || !observation.ids.has(args.elementId)) throw new Error('元素须来自本次观察，且不能同时提供坐标。');
        return { elementId: args.elementId };
      }
      if (observation.occluded) throw new Error('截图可能被遮挡。先激活目标窗口并重新观察。');
      return normalizedPoint(observation.bounds, args.x, args.y);
    };
    let payload;
    if (action === 'click') {
      if (args.button !== undefined && !['left', 'right', 'middle'].includes(args.button)) throw new Error('未知鼠标按键。');
      if (args.double !== undefined && typeof args.double !== 'boolean') throw new Error('double 必须为布尔值。');
      payload = { ...target, ...point(), button: args.button ?? 'left', dispatch: 'foreground' };
      if (args.double) action = 'double_click';
    } else if (action === 'scroll') {
      for (const n of [args.deltaY, args.deltaX ?? 0]) if (!Number.isSafeInteger(n) || Math.abs(n) > 3000) throw new Error('滚动量须为 -3000 至 3000 的整数。');
      payload = { ...target, ...point(), deltaY: args.deltaY, deltaX: args.deltaX ?? 0 };
    } else if (action === 'type_text') {
      if (typeof args.text !== 'string' || !args.text || args.text.length > 20000) throw new Error('文本须为 1–20000 个字符。');
      payload = { ...target, text: args.text, method: 'clipboard', focusMode: 'preserve', restoreClipboard: true };
    } else if (action === 'keypress') {
      if (!Array.isArray(args.keys) || !args.keys.length || args.keys.length > 5 || args.keys.some(key => typeof key !== 'string' || !key || key.length > 24)) throw new Error('keys 须为 1–5 个按键名称。');
      if (args.keys.some(key => /^(win|windows|meta|super|os|cmd|command)$/i.test(key))) throw new Error('初版不支持 Windows 键。');
      payload = { ...target, keys: args.keys, dispatch: 'foreground' };
    } else if (action === 'drag') {
      if (observation.occluded || !Array.isArray(args.path) || args.path.length < 2 || args.path.length > 100) throw new Error('拖动需要无遮挡截图及 2–100 个比例坐标点。');
      payload = { ...target, path: args.path.map(p => normalizedPoint(observation.bounds, p.x, p.y)), button: 'left' };
    } else throw new Error('未知输入动作。');
    return this.output(await this.call(action, payload, signal), { next: 'Observe the target again and verify the expected effect before claiming success or sending another input.' }, signal);
  }
  async release(sessionId, turn) {
    if (this.owner?.id !== sessionId || this.owner.turn !== turn || this.active) return;
    this.owner = null; this.observations.delete(sessionId); await this.publish();
  }
  async saveSettings(input) {
    const settings = normalizeSettings(input);
    await atomicJson(this.configPath, settings); this.settings = settings;
    if (!settings.enabled) {
      this.authorization.clear();
      this.active?.abort(new Error('用户已暂停桌面工具。'));
      const engine = this.engine; this.engine = null; await engine?.close();
      await this.currentDone;
      this.owner = null; this.observations.clear(); await this.publish();
    }
    this.lastError = null;
    return settings;
  }
  async status() {
    let engineState;
    try { engineState = JSON.parse(await fs.readFile(this.stateFile, 'utf8')); } catch {}
    return { version: '0.1.5', settings: this.settings, running: !!this.engine?.child, busy: !!this.owner, stopped: engineState?.paused ?? false, lastError: this.lastError, stopKeys: 'Esc / Ctrl+Alt+F12', platform: process.platform };
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.heartbeat);
    this.authorization.clear();
    this.active?.abort(new Error('桌面插件已停用。')); this.owner = null;
    await this.publish(); await this.engine?.close(); await this.currentDone; await this.publish();
    this.observations.clear();
    // Only remove the exact mkdtemp directory created by this instance.
    if (this.runtimeDir && path.dirname(path.resolve(this.runtimeDir)) === path.resolve(this.tempParent) && path.basename(this.runtimeDir).startsWith('dsh-desktop-control-') && !(await fs.lstat(this.runtimeDir)).isSymbolicLink()) {
      try { await fs.rm(this.runtimeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
      catch (error) { this.ctx.logger?.warn('桌面引擎临时文件稍后才能释放：' + error.message); }
    }
  }
}
