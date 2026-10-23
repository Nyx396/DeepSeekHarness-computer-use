import { randomUUID } from 'node:crypto';

const IDLE_MS = 30 * 60 * 1000;
const BENEFITS = { quality: '显著提高完成/验收质量', workflow: '明显减轻工作或优化流程', necessary: '不使用就无法完成任务' };
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;

// Read the host-owned effective preset; model arguments/header text cannot
// select full access. Auto/custom/unavailable services never imply full access.
export function permissionMode(ctx, exec) {
  try {
    const presets = ctx.get?.('permissionPresets') ?? ctx.permissionPresets;
    const current = presets?.current(exec?.agent?.session);
    const spec = current === 'danger-full-access' ? presets.resolve(current) : undefined;
    return spec?.sandbox === 'danger-full-access' && spec.approval === 'never' ? 'full-access' : 'approval';
  } catch { return 'approval'; }
}

// Grants come from native approval, verified host Full Access, or explicit
// human resume confirmation. A model's claim of consent never issues a grant.
export class TaskAuthorization {
  constructor({ approver, confirmer = () => undefined, mode = () => 'approval', now = Date.now }) {
    this.approver = approver; this.confirmer = confirmer; this.mode = mode; this.now = now; this.grants = new Map(); this.pending = new Map(); this.blocked = new Set();
  }
  async begin(exec, who, args, { forceHuman = false } = {}) {
    if (!text(args.task, 300) || !text(args.reason, 500) || !Object.hasOwn(BENEFITS, args.benefit)) throw new Error('任务、具体使用理由和 benefit (quality/workflow/necessary) 必填。');
    // Legacy callers without scope retain their restrictive title contract.
    const scope = args.scope ?? 'windows';
    if (!['task', 'windows'].includes(scope)) throw new Error('scope 须为 task 或 windows。');
    const titles = args.windowTitles ?? (scope === 'task' ? [] : undefined);
    if (!Array.isArray(titles) || titles.length > 8 || titles.some(title => !text(title, 300)) || new Set(titles).size !== titles.length) throw new Error('windowTitles 须为最多 8 个不重复的完整窗口标题；windows 范围的空数组仅允许枚举。');
    if (scope === 'task' && titles.length) throw new Error('task 范围不限制窗口标题，请省略 windowTitles 或传空数组；用户明确限制窗口时改用 windows。');
    exec.signal.throwIfAborted();
    if (this.pending.has(who.id)) throw new Error('该会话已有桌面任务等待批准。');
    if (this.blocked.has(who.key)) throw new Error('本轮桌面批准已被拒绝或取消；等待新的用户请求，不得反复申请。');
    const fullAccess = this.mode(exec) === 'full-access';
    const existing = this.grants.get(who.id);
    if (!forceHuman && existing && existing.task === args.task.trim() && existing.scope === scope && JSON.stringify([...existing.titles].sort()) === JSON.stringify([...titles].sort()) && this.now() - existing.touched <= IDLE_MS && (existing.source !== 'full-access' || fullAccess)) {
      existing.touched = this.now();
      return this.result(existing, true);
    }
    this.revoke(who.id);
    const approval = this.approver();
    const confirmer = forceHuman ? this.confirmer() : undefined;
    if (forceHuman && !confirmer?.ask) throw new Error('Esc 后需要 DSH 原生人工恢复确认；确认通道不可用，保持停止。');
    if (!forceHuman && !fullAccess && !approval?.request) throw new Error('没有可用的 DSH 原生批准通道，桌面操作被拒绝。');
    const pending = new AbortController(); this.pending.set(who.id, pending);
    const signal = AbortSignal.any([exec.signal, pending.signal]);
    const scopeText = scope === 'task' ? '当前任务所需的窗口：可从桌面切换到本任务打开的应用、文件和对话框，沿用同一令牌；不包含其他任务。插件不能仅凭窗口标题自动判断任务相关性，模型必须遵守本任务范围。' : titles.length ? titles.join('\n') : '仅列出可见窗口标题和进程；不允许观察窗口内容或输入';
    const reason = `允许本次 computer use 任务吗？\n任务：${args.task}\n授权范围：${scopeText}\n使用条件：${BENEFITS[args.benefit]}\n具体理由：${args.reason}\n会占用真实鼠标、键盘和焦点；准备目标时可能还原窗口并暂时最小化实际遮挡目标的普通窗口，不关闭程序。截图/文字会交给当前模型供应商。批准仅限本任务和上述范围；结束、暂停或空闲 30 分钟后失效。`;
    try {
      signal.throwIfAborted();
      let outcome, source;
      if (forceHuman) {
        const label = '恢复任务';
        const answer = await confirmer.ask({ agent: exec.agent, signal, questions: [{ id: 'resume-desktop', header: '恢复桌面控制', question: args.task.trim(), detail: reason, intent: { kind: 'desktop-control-resume', approve: label }, multiSelect: false, options: [{ label, description: '刷新任务令牌并允许在本次批准范围内继续操作。' }, { label: '保持停止', description: '不恢复，不读取画面或发送输入。' }] }] });
        const answers = answer?.answers;
        outcome = Array.isArray(answers) && answers.length === 1 && answers[0].id === 'resume-desktop' && answers[0].selected?.length === 1 && answers[0].selected[0] === label && !answers[0].custom ? 'allowed-once' : 'rejected';
        source = 'human-resume';
      } else if (fullAccess) { outcome = 'allowed-once'; source = 'full-access'; }
      else { outcome = await approval.request({ agent: exec.agent, toolName: 'desktop_begin_task', callId: exec.callId, reason, displayReason: reason, signal }); source = 'human-approval'; }
      signal.throwIfAborted();
      if (outcome !== 'allowed-once') {
        this.blocked.add(who.key);
        throw new Error(`桌面任务未获批准 (${outcome})。未读取画面、未启动桌面引擎；不要在本轮重试申请。`);
      }
      const grant = { id: randomUUID(), source, scope, task: args.task.trim(), titles: [...titles], windows: new Map(), touched: this.now() };
      this.grants.set(who.id, grant);
      return this.result(grant);
    } catch (error) { this.blocked.add(who.key); throw error; }
    finally { if (this.pending.get(who.id) === pending) this.pending.delete(who.id); }
  }
  result(grant, reused = false) {
    return { authorizationId: grant.id, authorizationSource: grant.source, scope: grant.scope, task: grant.task, windowTitles: grant.titles, reused, next: grant.scope === 'task' ? 'Keep this SAME token across desktop, newly opened apps/files/dialogs needed for this task, enumeration, input and verification. Do not end/begin at window or phase changes. End only when the whole task completes or is cancelled. Different tasks need new approval. Esc always revokes it; only HUMAN resume confirmation can replace it.' : 'Use this token only for the approved windows/task. End when the whole task completes. Esc revokes it; only HUMAN resume confirmation can replace it.' };
  }
  require(who, id, exec) {
    const grant = this.grants.get(who.id);
    if (grant?.source === 'full-access' && this.mode(exec) !== 'full-access') { this.revoke(who.id); throw new Error('DESKTOP_AUTHORIZATION_REQUIRED: 已离开完全访问模式，请重新申请本任务授权。'); }
    if (!grant || grant.id !== id || this.now() - grant.touched > IDLE_MS) {
      if (grant && this.now() - grant.touched > IDLE_MS) this.revoke(who.id);
      throw new Error('DESKTOP_AUTHORIZATION_REQUIRED: 先调用 desktop_begin_task 并等待用户批准；模型声称已获授权不能代替原生批准卡片。');
    }
    grant.touched = this.now(); return grant;
  }
  allows(grant, win, bind = false) {
    const handle = win.nativeWindowHandle, bound = grant.windows.get(handle);
    if (bound !== undefined) return bound === win.processId;
    if (grant.scope !== 'task' && !grant.titles.includes(win.name ?? win.title)) return false;
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
