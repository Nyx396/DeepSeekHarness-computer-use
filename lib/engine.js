import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareWindowsRuntime } from './overlay.js';

export const ENGINE_ACTIONS = Object.freeze(['health', 'list_windows', 'snapshot', 'screenshot', 'accessibility_tree', 'ocr', 'click', 'double_click', 'scroll', 'drag', 'type_text', 'keypress', 'activate_window']);
const script = fileURLToPath(new URL('../vendor/windows-engine/mcp/server.mjs', import.meta.url));

export class TargetFocusNotReadyError extends Error {
  constructor(message, preparation) {
    super(message);
    this.name = 'TargetFocusNotReadyError';
    this.code = 'DESKTOP_TARGET_FOCUS_NOT_READY';
    this.preparation = preparation;
  }
}

// Only a completed activation/preparation response can prove that no input was
// dispatched. Never classify timeouts, cancellation or input errors by wording.
export function preparationError(message, handle) {
  if (message.startsWith('DESKTOP_TARGET_FOCUS_NOT_READY:')) {
    const marker = ' Preparation: ', at = message.indexOf(marker);
    if (at !== -1) {
      try {
        const preparation = JSON.parse(message.slice(at + marker.length));
        if (preparation.window === handle && preparation.ready === false &&
            Array.isArray(preparation.blockers) && preparation.blockers.length === 0) {
          return new TargetFocusNotReadyError(message, preparation);
        }
      } catch { /* Malformed/inconsistent responses retain fatal handling. */ }
    }
  }
  return new Error(message);
}

// A deliberately small stdio MCP client. No npm install, shell interpolation,
// or model-supplied executable paths are involved in launching the worker.
export class WindowsEngine {
  constructor({ env = {}, executable = process.execPath, args, runtimeDirectory, timeoutMs = 45000 } = {}) {
    this.env = env; this.executable = executable; this.args = args; this.timeoutMs = timeoutMs;
    this.runtimeDirectory = runtimeDirectory;
    this.pending = new Map(); this.sequence = 0; this.closed = false;
  }
  async start(signal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('桌面引擎已关闭。');
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.initialize(signal).finally(() => { this.starting = null; });
    return this.starting;
  }
  async initialize(signal) {
    const args = this.args ?? [this.runtimeDirectory ? await prepareWindowsRuntime(this.runtimeDirectory) : script];
    signal?.throwIfAborted();
    const child = this.child = spawn(this.executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WCU_TOOL_MODE: 'full', WCU_ENABLED_TOOLS: JSON.stringify(ENGINE_ACTIONS), ...this.env },
    });
    let buffer = '', diagnostics = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-3000); });
    child.stdout.on('data', data => {
      buffer += data;
      if (buffer.length > 48 * 1024 * 1024) { this.fail(child, new Error('桌面引擎响应过大。')); child.kill(); return; }
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { this.fail(child, new Error('桌面引擎协议无效。')); child.kill(); return; }
        const waiter = this.pending.get(message.id);
        if (!waiter || waiter.child !== child) continue;
        message.error ? waiter.finish(new Error(message.error.message)) : waiter.finish(null, message.result);
      }
    });
    child.stdin.on('error', error => this.fail(child, error));
    child.once('error', error => this.fail(child, error));
    child.once('exit', () => this.fail(child, new Error('桌面引擎已退出。' + diagnostics)));
    try {
      const info = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-desktop-control', version: '0.2.6' } }, signal, 10000);
      if (!info?.capabilities?.tools) throw new Error('桌面引擎未声明 tools 能力。');
      this.notify('notifications/initialized', {});
    } catch (error) { child.stdin.end(); child.kill(); this.fail(child, error); throw error; }
  }
  fail(child, error) {
    if (this.child === child) this.child = null;
    for (const waiter of [...this.pending.values()]) if (waiter.child === child) waiter.finish(error);
  }
  notify(method, params) {
    if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n', () => {});
  }
  request(method, params, signal, timeoutMs = this.timeoutMs) {
    signal?.throwIfAborted();
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error('桌面引擎尚未就绪。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const cancel = error => {
        this.notify('notifications/cancelled', { requestId: id, reason: error.message });
        finish(error);
        // Keep the worker (and its stop listener) alive long enough to cancel
        // the backend. The host won't dispatch another call until close().
      };
      const abort = () => cancel(signal.reason instanceof Error ? signal.reason : new Error('桌面操作已取消。'));
      const timer = setTimeout(() => cancel(new Error('桌面操作超时，结果未知。必须重新观察；禁止自动重放输入。')), timeoutMs);
      this.pending.set(id, { child, finish });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => { if (error) finish(error); });
      if (signal?.aborted) abort();
    });
  }
  async call(action, args = {}, { signal, timeoutMs } = {}) {
    if (!ENGINE_ACTIONS.includes(action)) throw new Error('未知桌面动作。');
    await this.start(signal);
    const result = await this.request('tools/call', { name: 'windows_computer_use_' + action, arguments: args }, signal, timeoutMs);
    if (result?.isError) {
      const message = result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '桌面引擎执行失败。';
      throw action === 'activate_window' ? preparationError(message, args.nativeWindowHandle) : new Error(message);
    }
    return result;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) return;
    await new Promise(resolve => {
      if (child.exitCode !== null) { resolve(); return; }
      let timer;
      const finish = () => { clearTimeout(timer); resolve(); };
      child.once('exit', finish);
      timer = setTimeout(() => { child.kill(); finish(); }, 2500);
      child.stdin.end();
    });
    this.fail(child, new Error('桌面引擎已关闭。'));
  }
}

export function resultData(result) {
  const text = result.content?.find(block => block.type === 'text')?.text;
  if (!text) throw new Error('桌面引擎未返回观察信息。');
  try { return JSON.parse(text); } catch { throw new Error(text); }
}
