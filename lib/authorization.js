import { randomUUID } from 'node:crypto';

const IDLE_MS = 30 * 60 * 1000;
const BENEFITS = { quality: '显著提高完成/验收质量', workflow: '明显减轻工作或优化流程', necessary: '不使用就无法完成任务' };
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;

// Grants are issued only by DSH's human approval service, never by a model's
// claim of consent. They are memory-only, session-bound and target-bound.
export class TaskAuthorization {
  constructor({ approver, now = Date.now }) {
    this.approver = approver; this.now = now; this.grants = new Map(); this.pending = new Map(); this.blocked = new Set();
  }
  async begin(exec, who, args) {
    if (!text(args.task, 300) || !text(args.reason, 500) || !Object.hasOwn(BENEFITS, args.benefit)) throw new Error('任务、具体使用理由和 benefit (quality/workflow/necessary) 必填。');
    if (!Array.isArray(args.windowTitles) || args.windowTitles.length > 8 || args.windowTitles.some(title => !text(title, 300)) || new Set(args.windowTitles).size !== args.windowTitles.length) throw new Error('windowTitles 须为最多 8 个不重复的完整窗口标题；空数组仅允许枚举窗口，不允许观察或输入。');
    if (this.pending.has(who.id)) throw new Error('该会话已有桌面任务等待批准。');
    if (this.blocked.has(who.key)) throw new Error('本轮桌面批准已被拒绝或取消；等待新的用户请求，不得反复申请。');
    this.revoke(who.id);
    const approval = this.approver();
    if (!approval?.request) throw new Error('没有可用的 DSH 原生批准通道，桌面操作被拒绝。');
    const pending = new AbortController(); this.pending.set(who.id, pending);
    const signal = AbortSignal.any([exec.signal, pending.signal]);
    const scope = args.windowTitles.length ? args.windowTitles.join('\n') : '仅列出可见窗口标题和进程；不允许观察窗口内容或输入';
    const reason = `允许本次 computer use 任务吗？\n任务：${args.task}\n窗口范围：${scope}\n使用条件：${BENEFITS[args.benefit]}\n具体理由：${args.reason}\n会占用真实鼠标、键盘和焦点，截图/文字会交给当前模型供应商。批准仅限本任务和上述窗口；结束、暂停或空闲 30 分钟后失效。`;
    try {
      signal.throwIfAborted();
      const outcome = await approval.request({ agent: exec.agent, toolName: 'desktop_begin_task', callId: exec.callId, reason, displayReason: reason, signal });
      signal.throwIfAborted();
      if (outcome !== 'allowed-once') {
        this.blocked.add(who.key);
        throw new Error(`桌面任务未获批准 (${outcome})。未读取画面、未启动桌面引擎；不要在本轮重试申请。`);
      }
      const grant = { id: randomUUID(), task: args.task.trim(), titles: [...args.windowTitles], windows: new Map(), touched: this.now() };
      this.grants.set(who.id, grant);
      return { authorizationId: grant.id, task: grant.task, windowTitles: grant.titles, next: 'Use this authorizationId for desktop tools in this task. Call desktop_end_task when complete. New task/scope requires a new approval.' };
    } finally { if (this.pending.get(who.id) === pending) this.pending.delete(who.id); }
  }
  require(who, id) {
    const grant = this.grants.get(who.id);
    if (!grant || grant.id !== id || this.now() - grant.touched > IDLE_MS) {
      if (grant && this.now() - grant.touched > IDLE_MS) this.revoke(who.id);
      throw new Error('DESKTOP_AUTHORIZATION_REQUIRED: 先调用 desktop_begin_task 并等待用户批准；模型声称已获授权不能代替原生批准卡片。');
    }
    grant.touched = this.now(); return grant;
  }
  allows(grant, win, bind = false) {
    const handle = win.nativeWindowHandle, bound = grant.windows.get(handle);
    if (bound !== undefined) return bound === win.processId;
    if (!grant.titles.includes(win.name ?? win.title)) return false;
    if (bind) grant.windows.set(handle, win.processId);
    return true;
  }
  window(who, win) {
    const grant = this.grants.get(who.id);
    if (!grant || !this.allows(grant, win, true)) throw new Error('目标窗口超出已批准范围或进程已变化。需要新的 desktop_begin_task 批准，不得沿用旧授权。');
  }
  revoke(id) { this.grants.delete(id); this.pending.get(id)?.abort(new Error('桌面任务授权已撤销。')); }
  clear() { for (const id of new Set([...this.grants.keys(), ...this.pending.keys()])) this.revoke(id); this.blocked.clear(); }
}
