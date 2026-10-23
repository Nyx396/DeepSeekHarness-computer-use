window.__ModuleLoader__.load({ id: 'dsh-desktop-control', factory(require) {
  const React = require('react'), h = React.createElement;
  const { Button } = require('@deepseek-ai/dsh-client-ui-primitives');
  const ROUTE = 'api/plugins/desktop-control';
  async function api(options = {}) {
    const response = await fetch(ROUTE, { credentials: 'include', ...options });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '桌面插件请求失败。');
    return result;
  }
  function RecoveryCard({ matched }) {
    const question = matched.questions[0];
    const [pending, setPending] = React.useState(false), [error, setError] = React.useState('');
    const settling = React.useRef(false);
    async function decide(restore) {
      if (settling.current) return;
      settling.current = true; setPending(true); setError('');
      try { await matched.answer({ answers: [{ id: 'resume-desktop', selected: [restore ? '恢复任务' : '保持停止'] }] }); }
      catch { settling.current = false; setPending(false); setError('确认未送达，桌面控制仍保持停止。'); }
    }
    return h('section', { className: 'ddc-recovery', 'aria-label': '恢复桌面控制' },
      h('div', { className: 'ddc-recovery-header' }, h('strong', null, '恢复桌面控制'), h('span', null, '等待你的确认')),
      h('p', { className: 'ddc-recovery-task' }, question.question),
      h('p', { className: 'ddc-recovery-note' }, 'Esc 已停止操作。恢复后将刷新权限，并重新观察目标窗口。'),
      h('details', { className: 'ddc-recovery-details' }, h('summary', null, '查看任务与窗口范围'), h('div', null, question.detail)),
      error ? h('p', { className: 'ddc-recovery-error', role: 'alert' }, error) : null,
      h('div', { className: 'ddc-recovery-actions' },
        h(Button, { type: 'button', variant: 'outline', className: 'ddc-recovery-action', disabled: pending, onClick: () => decide(false) }, '保持停止'),
        h(Button, { type: 'button', variant: 'primary', className: 'ddc-recovery-action ddc-recovery-restore', disabled: pending, onClick: () => decide(true) }, pending ? '正在提交…' : '恢复任务')));
  }
  function SettingsPanel() {
    const [data, setData] = React.useState(null), [error, setError] = React.useState(''), [pending, setPending] = React.useState(false);
    const alive = React.useRef(false);
    React.useEffect(() => {
      alive.current = true; const cancel = new AbortController();
      api({ signal: cancel.signal }).then(value => { if (alive.current) setData(value); }, cause => { if (!cancel.signal.aborted) setError(cause.message); });
      const timer = setInterval(() => { api({ signal: cancel.signal }).then(value => { if (alive.current) setData(value); }, () => {}); }, 2500);
      return () => { alive.current = false; cancel.abort(); clearInterval(timer); };
    }, []);
    async function save(changes) {
      setPending(true); setError('');
      try {
        const result = await api({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data.settings, ...changes }) });
        if (alive.current) setData(result);
      } catch (cause) { if (alive.current) setError(cause.message); }
      finally { if (alive.current) setPending(false); }
    }
    return h('section', { className: 'ddc-settings' },
      h('p', null, '用当前会话的云端看图模型观察并操作 Windows 窗口，无需本地大模型，也无需单独填写 API Key。'),
      h('p', { className: 'ddc-note' }, '会短暂占用鼠标、键盘和焦点。观察前自动还原并置前目标，必要时最小化实际遮挡目标的普通窗口，不关闭程序。目标窗口的截图、界面文字会随工具结果交给当前模型供应商。'),
      h('div', { className: 'ddc-status', role: 'status' }, !data ? '正在读取状态…' : !data.settings.enabled ? '已暂停 · 桌面工具不会执行' : data.stopped ? '已停止 · 等待人工恢复确认，不会自动解除' : data.busy ? '桌面操作系列进行中' : '已就绪 · 等待聊天任务'),
      h('p', null, h('strong', null, '随时按 Esc 或 Ctrl + Alt + F12 停止当前操作。')),
      data ? h('button', { type: 'button', disabled: pending, onClick: () => save({ enabled: !data.settings.enabled }) }, pending ? '正在应用…' : data.settings.enabled ? '暂停所有桌面工具' : '启用桌面工具') : null,
      h('label', { className: 'ddc-field' }, '截图最大宽度', h('select', { value: data?.settings.screenshotWidth || 1280, disabled: !data || pending, onChange: event => save({ screenshotWidth: Number(event.target.value) }) }, [960, 1280, 1600, 1920].map(value => h('option', { key: value, value }, value + ' 像素' + (value === 1280 ? ' · 默认' : ''))))),
      h('p', { className: 'ddc-note' }, '普通权限须明确授权当前任务，并在首次原生卡片中批准任务范围；同一任务跨窗口沿用令牌。完全访问模式免首次审批，仍须有具体收益或任务必要性，优先使用足够的 API、文件或命令行工具。Esc 后所有模式均撤销旧令牌；用户要求继续时，通过原生“恢复桌面控制”确认刷新权限，无需等待或重启。取消则保持停止；同一任务内无需逐步确认。目标须能在当前交互桌面还原和置前。'),
      data?.lastError ? h('p', { className: 'ddc-error', role: 'status' }, data.lastError) : null,
      error ? h('p', { className: 'ddc-error', role: 'alert' }, error) : null,
      h('p', { className: 'ddc-note' }, '桌面操作 0.2.5 · 技能 computer-use · Windows 引擎基于 dsh-computer-use-win 0.5.0（MIT）。'));
  }
  function apply(ctx) {
    ctx.effect(() => {
      const style = document.createElement('style'); style.dataset.plugin = 'dsh-desktop-control';
      style.textContent = '.ddc-settings{max-width:640px;font:14px/1.65 inherit;color:var(--dsw-alias-label-primary,#25252a)}.ddc-settings p{margin:0 0 16px}.ddc-note{font-size:13px;color:var(--dsw-alias-label-secondary,#6a6a72)}.ddc-status{border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:10px;padding:14px;margin:16px 0}.ddc-settings button,.ddc-settings select{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#ccc);padding:9px 12px;border-radius:8px}.ddc-settings button{cursor:pointer}.ddc-settings button:disabled{opacity:.5;cursor:default}.ddc-field{display:grid;gap:8px;margin:22px 0}.ddc-field select{max-width:280px}.ddc-error{padding:12px;border:1px solid #bb5b5b;border-radius:8px;overflow-wrap:anywhere}.ddc-settings :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#6559c7);outline-offset:3px}';
      style.textContent += '.ddc-recovery{box-sizing:border-box;width:calc(100% - 24px);max-width:640px;margin:8px auto 12px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2,#dedee3);border-radius:14px;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-label-primary,#25252a);font:14px/1.55 system-ui}.ddc-recovery-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.ddc-recovery-header strong{font-size:14px;font-weight:600}.ddc-recovery-header span,.ddc-recovery-note,.ddc-recovery-details{font-size:12px;color:var(--dsw-alias-label-secondary,#72727b)}.ddc-recovery-task{margin:8px 0 4px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.ddc-recovery-note{margin:0}.ddc-recovery-details{margin-top:8px}.ddc-recovery-details summary{cursor:pointer;user-select:none}.ddc-recovery-details>div{max-height:140px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px}.ddc-recovery-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}.ddc-recovery-action{font:inherit;line-height:20px;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#dedee3);background:transparent;color:inherit;cursor:pointer}.ddc-recovery-restore{background:var(--dsw-alias-label-primary,#25252a);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}.ddc-recovery-action:disabled{opacity:.55;cursor:default}.ddc-recovery-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#6559c7);outline-offset:3px}.ddc-recovery-error{font-size:12px;color:var(--dsw-alias-state-danger-primary,#b14545);margin:6px 0 0}';
      document.head.appendChild(style); return () => style.remove();
    });
    ctx.slots.inject('conversation.composer', () => ctx.slots.register({
      name: 'conversation.composer', priority: -50,
      select: ({ pendingInteraction }) => {
        const questions = pendingInteraction?.questions;
        return questions?.length === 1 && questions[0].id === 'resume-desktop' && questions[0].intent?.kind === 'desktop-control-resume' && typeof pendingInteraction.answer === 'function' ? pendingInteraction : null;
      },
    }, RecoveryCard));
    // The Hub service can exist before its settings child slot is declared.
    // Follow the slot lifetime so concurrent boot and parent remounts are safe.
    ctx.slots.inject('plugin-hub.settings', () => ctx.pluginHub.registerSettings({ id: 'desktop-control', label: '桌面操作', description: '桌面工具开关、截图尺寸与停止方式', keywords: ['computer', '桌面', '鼠标', '键盘', '截图'], order: 40 }, SettingsPanel));
    ctx.effect(() => ctx.pluginHub.registerAction({ id: 'desktop-control:settings', label: '桌面操作', description: '查看状态、暂停桌面工具', order: 40, async run(context) { context.closeMenu(); ctx.pluginHub.openSettings('desktop-control'); } }));
  }
  return { inject: ['pluginHub', 'slots'], apply, SettingsPanel, RecoveryCard };
} });
