import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WindowsEngine, resultData, preparationError, TargetFocusNotReadyError } from './engine.js';
import { DEFAULTS, normalizeSettings } from './settings.js';
import { savePreview } from './preview.js';
import { TaskAuthorization, permissionMode } from './authorization.js';

const STALE_MS = 120000;
export const BUSY = 'DESKTOP_BUSY: 另一个会话正在操作桌面，请等待它结束或停止它。';
export const STOPPED = 'DESKTOP_REAPPROVAL_REQUIRED: 桌面控制已停止，旧令牌已撤销。不得自行恢复或反复尝试；用户要求继续时，可调用 desktop_begin_task 请求人工恢复确认。确认后立即刷新令牌，无需等待或重启。';
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
export async function atomicJson(filename, value, { io = fs, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  await io.mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await io.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx' });
    // Windows readers may briefly hold activity.json without FILE_SHARE_DELETE.
    // Retry only atomic replacement, never delete the old state or replay input.
    const delays = [10, 25, 50, 100, 200];
    for (let attempt = 0; ; attempt++) {
      try { await io.rename(temporary, filename); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error;
        await wait(delays[attempt]);
      }
    }
  } finally { await io.unlink(temporary).catch(() => {}); }
}

export class DesktopController {
  constructor(ctx, { configPath, tempParent = os.tmpdir(), engineFactory = options => new WindowsEngine(options), now = Date.now } = {}) {
    this.ctx = ctx; this.configPath = configPath; this.tempParent = tempParent; this.engineFactory = engineFactory; this.now = now;
    this.previewDirectory = path.join(path.dirname(configPath), 'cache', 'dsh-desktop-control', 'previews');
    this.stopFile = path.join(path.dirname(configPath), 'dsh-desktop-control-stop.json');
    this.stopped = false; this.resumeToken = 0;
    this.observations = new Map(); this.settings = { ...DEFAULTS }; this.closed = false; this.lastError = null;
    this.authorization = new TaskAuthorization({ approver: () => this.ctx.get?.('approval') ?? this.ctx.approval, confirmer: () => this.ctx.get?.('userQuestions') ?? this.ctx.userQuestions, mode: exec => permissionMode(this.ctx, exec), now });
  }
  async init() {
    try { this.settings = normalizeSettings(JSON.parse(await fs.readFile(this.configPath, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') { this.settings.enabled = false; this.lastError = '配置无法读取，桌面工具已暂停。请在插件配置中重新保存。'; } }
    try {
      const saved = JSON.parse(await fs.readFile(this.stopFile, 'utf8'));
      if (typeof saved.stopped !== 'boolean') throw new Error('Invalid desktop stop state');
      this.stopped = saved.stopped;
    } catch (error) { if (error.code !== 'ENOENT') { this.stopped = true; this.lastError = '停止状态无法读取，须人工确认恢复桌面控制。'; } }
    await fs.mkdir(this.tempParent, { recursive: true });
    this.runtimeDir = await fs.mkdtemp(path.join(this.tempParent, 'dsh-desktop-control-'));
    this.configFile = path.join(this.runtimeDir, 'engine.json'); this.stateFile = path.join(this.runtimeDir, 'state.json'); this.activityFile = path.join(this.runtimeDir, 'activity.json');
    await atomicJson(this.configFile, { indicatorText: 'DSH 正在操作桌面', stopShortcut: 'Ctrl+Alt+F12', resumeToken: this.resumeToken });
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
      if (!this.closed) await this.refreshStop();
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
  async markStopped() {
    if (this.stopped || this.closed) return;
    this.stopped = true; this.lastError = STOPPED;
    this.authorization.clear(); this.observations.clear(); this.owner = null;
    this.active?.abort(new Error(STOPPED));
    await atomicJson(this.stopFile, { stopped: true, updatedAt: new Date().toISOString() });
    if (!this.active) { const engine = this.engine; this.engine = null; await engine?.close(); }
  }
  async refreshStop() {
    try {
      const state = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      // A human-confirmed resume advances the upstream's public resumeToken.
      // Until its next sync, the old state file belongs to the previous epoch.
      if (state.paused === true && (state.resumeToken ?? 0) === this.resumeToken) await this.markStopped();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this.stopped;
  }
  async resumeApproved(exec, who, grant) {
    const assertCurrent = () => {
      exec.signal.throwIfAborted();
      if (this.closed || !this.settings.enabled) throw new Error('桌面插件已关闭或暂停。');
      this.authorization.require(who, grant.authorizationId, exec);
    };
    assertCurrent();
    const engine = this.engine; this.engine = null; await engine?.close();
    const config = JSON.parse(await fs.readFile(this.configFile, 'utf8'));
    assertCurrent();
    const next = this.resumeToken + 1;
    await atomicJson(this.configFile, { ...config, resumeToken: next });
    this.resumeToken = next;
    assertCurrent();
    await atomicJson(this.stopFile, { stopped: false, updatedAt: new Date().toISOString() });
    assertCurrent();
    this.stopped = false; this.lastError = null; this.owner = null;
  }
  async beginTask(exec, args) {
    if (this.closed || !this.settings.enabled) throw new Error('桌面插件已关闭或暂停。');
    if (this.active || this.beginning) throw new Error(BUSY);
    const who = identity(exec); this.observations.delete(who.id);
    let restoring = false;
    this.beginning = true;
    try {
      restoring = await this.refreshStop();
      const grant = await this.authorization.begin(exec, who, args, { forceHuman: restoring });
      if (this.closed || !this.settings.enabled) throw new Error('桌面插件已关闭或暂停。');
      if (restoring) {
        if (grant.authorizationSource !== 'human-resume') throw new Error('恢复必须由人工确认。');
        await this.resumeApproved(exec, who, grant);
      }
      exec.signal.throwIfAborted();
      return { text: JSON.stringify({ ...grant, resumed: restoring }), images: [] };
    } catch (error) {
      this.authorization.revoke(who.id);
      if (this.stopped || restoring) { this.stopped = true; await atomicJson(this.stopFile, { stopped: true, updatedAt: new Date().toISOString() }); }
      throw error;
    }
    finally { this.beginning = false; }
  }
  async endTask(exec, args) {
    if (this.active) throw new Error(BUSY);
    const who = identity(exec); this.authorization.require(who, args.authorizationId, exec);
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
    if (await this.refreshStop()) throw new Error(STOPPED);
    if (this.beginning) throw new Error(BUSY);
    const grant = this.authorization.require(who, authorizationId, exec);
    if (this.active || this.owner && this.owner.id !== who.id && this.now() - this.owner.touched <= 30000) throw new Error(BUSY);
    // A new turn in the same conversation may replace the previous idle turn.
    if (this.owner?.id === who.id && !this.active) this.owner = null;
    this.owner = { ...who, touched: this.now() };
    const active = this.active = new AbortController();
    let done;
    this.currentDone = new Promise(resolve => { done = resolve; });
    const signal = AbortSignal.any([exec.signal, active.signal]);
    try {
      signal.throwIfAborted(); await this.publish(); signal.throwIfAborted();
      const value = await action(signal, who, grant);
      this.lastError = null;
      return value;
    } catch (error) {
      this.lastError = error.message;
      if (/COMPUTER_USE_(?:STOPPED_BY_USER|PAUSED)/.test(error.message)) { await this.markStopped(); error = new Error(STOPPED, { cause: error }); }
      // Outcomes of failed input calls are unknown. No retry, no queue replay.
      this.observations.delete(who.id);
      if (error instanceof TargetFocusNotReadyError && !signal.aborted &&
          !this.stopped && !this.closed && this.settings.enabled) {
        // The activation response proves preparation failed before input. Keep
        // its live stop listener and task grant; only the old observation dies.
        return {
          text: JSON.stringify({
            ok: false, code: error.code, inputDispatched: false,
            error: error.message, targetPreparation: error.preparation,
            recovery: { requiresSkillReload: false, requiresNewTask: false, action: 'activate-once-then-observe' },
            next: 'No input was sent and no observationId was issued. Keep the SAME task token and loaded skill. You may explicitly activate this target once, then observe afresh before any input. If focus still fails, report the actual foreground window and pause this target; do not loop, reload the skill, close an overlay, or bypass focus checks. Esc/pause still requires human recovery.',
          }),
          images: [],
        };
      }
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
  async window(handle, signal, who, { allowMinimized = false } = {}) {
    if (!Number.isSafeInteger(handle) || handle <= 0) throw new Error('必须使用 desktop_windows 返回的明确窗口句柄。');
    const result = resultData(await this.call('list_windows', { maxWindows: 200 }, signal));
    const win = result.windows?.find(window => window.nativeWindowHandle === handle);
    if (!win || win.isOffscreen && !allowMinimized) throw new Error('目标窗口不存在、已最小化或不可见。请重新列出窗口。');
    if (win.responsive === false || win.targetResponsive === false) throw new Error('目标窗口无响应，请稍后重新观察。');
    this.authorization.window(who, win);
    return win;
  }
  async prepareWindow(handle, signal, who) {
    await this.window(handle, signal, who, { allowMinimized: true });
    const result = await this.call('activate_window', { nativeWindowHandle: handle }, signal);
    const data = resultData(result);
    if (data.interactionReady !== true || data.activated !== true) {
      throw preparationError((data.preparation?.reason || 'DESKTOP_TARGET_NOT_READY: 未能使目标窗口置前并可交互，未发送输入。') +
        ' Preparation: ' + JSON.stringify(data.preparation ?? {}), handle);
    }
    const win = await this.window(handle, signal, who);
    return { result, win, preparation: data.preparation };
  }
  async activate(args, signal, who) {
    this.observations.delete(who.id);
    return this.output((await this.prepareWindow(args.window, signal, who)).result, {}, signal);
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
    const mode = args.mode ?? 'both';
    if (!['both', 'screenshot', 'tree', 'ocr'].includes(mode)) throw new Error('mode 须为 both、screenshot、tree 或 ocr。');
    const image = mode === 'both' || mode === 'screenshot';
    if (image) await this.vision(exec, signal);
    this.observations.delete(who.id);
    const { win, preparation } = await this.prepareWindow(args.window, signal, who);
    const target = { nativeWindowHandle: args.window, activate: false, scope: 'active_window' };
    const width = this.settings.screenshotWidth;
    const result = mode === 'screenshot' ? await this.call('screenshot', { ...target, maxWidth: width }, signal)
      : mode === 'ocr' ? await this.call('ocr', { ...target, maxWidth: width, resolveControl: false, includeScreenshot: false }, signal)
        : await this.call('snapshot', { ...target, includeScreenshot: image, captureWindow: true, maxWidth: width, maxNodes: 250, maxDepth: 6, treeTimeoutMs: 3500 }, signal);
    const data = resultData(result);
    const observationId = randomUUID();
    this.observations.set(who.id, { id: observationId, who: who.key, time: this.now(), handle: args.window, processId: win.processId, bounds: data.screenshot?.bounds, windowBox: win.boundingBox, ids: collectIds(data.tree), occluded: data.screenshot?.occludedPossible === true });
    return this.output(result, { observationId, window: args.window, targetPreparation: preparation, coordinates: 'For coordinate input, x/y are 0–1000 within this WINDOW image: left/top=0, right/bottom=1000. Do not send physical screen pixels. UIA elementId may be used instead. One input consumes this observation; observe again after each input.', expiresInSeconds: 120 }, signal);
  }
  async input(action, args, signal, who) {
    const observation = this.observations.get(who.id);
    if (!observation || observation.id !== args.observationId || observation.who !== who.key || this.now() - observation.time > STALE_MS) throw new Error('观察已过期或不属于当前轮次。先调用 desktop_observe 再操作。');
    // Consume before any await, including failure. Unknown outcomes are never replayed.
    this.observations.delete(who.id);
    const win = await this.window(observation.handle, signal, who);
    if (win.processId !== observation.processId || JSON.stringify(win.boundingBox) !== JSON.stringify(observation.windowBox)) throw new Error('目标窗口或位置已变化，请重新观察后再操作。');
    const prepared = await this.prepareWindow(observation.handle, signal, who);
    if (prepared.preparation?.changed || JSON.stringify(prepared.win.boundingBox) !== JSON.stringify(observation.windowBox)) {
      throw new Error('DESKTOP_REOBSERVE_REQUIRED: 目标已重新置前/移除遮挡，请重新观察再输入；本次未发送输入，不必重新申请任务授权。');
    }
    // Preparation is idempotent; the worker must not tap Alt or activate again
    // between this observation and its final point/focus guard.
    const target = { nativeWindowHandle: observation.handle, activate: false };
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
    if (!this.closed) await this.refreshStop();
    return { version: '0.2.5', focusRecoveryRevision: 1, settings: this.settings, running: !!this.engine?.child, busy: !!this.owner, stopped: this.stopped, recovery: this.stopped ? 'human-confirmation-required' : null, lastError: this.lastError, stopKeys: 'Esc / Ctrl+Alt+F12', platform: process.platform };
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
