window.__ModuleLoader__.load({ id: 'dsh-desktop-control', factory(require) {
  const React = require('react'), h = React.createElement;
  const ROUTE = 'api/plugins/desktop-control';
  async function api(options = {}) {
    const response = await fetch(ROUTE, { credentials: 'include', ...options });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '桌面插件请求失败。');
    return result;
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
      h('p', { className: 'ddc-note' }, '会短暂占用鼠标、键盘和焦点。目标窗口的截图、界面文字会随工具结果交给当前模型供应商。'),
      h('div', { className: 'ddc-status', role: 'status' }, !data ? '正在读取状态…' : !data.settings.enabled ? '已暂停 · 桌面工具不会执行' : data.stopped ? '当前操作已停止 · 新一轮用户请求可以继续' : data.busy ? '桌面操作系列进行中' : '已就绪 · 等待聊天任务'),
      h('p', null, h('strong', null, '随时按 Esc 或 Ctrl + Alt + F12 停止当前操作。')),
      data ? h('button', { type: 'button', disabled: pending, onClick: () => save({ enabled: !data.settings.enabled }) }, pending ? '正在应用…' : data.settings.enabled ? '暂停所有桌面工具' : '启用桌面工具') : null,
      h('label', { className: 'ddc-field' }, '截图最大宽度', h('select', { value: data?.settings.screenshotWidth || 1280, disabled: !data || pending, onChange: event => save({ screenshotWidth: Number(event.target.value) }) }, [960, 1280, 1600, 1920].map(value => h('option', { key: value, value }, value + ' 像素' + (value === 1280 ? ' · 默认' : ''))))),
      h('p', { className: 'ddc-note' }, '使用时请明确说“授权本任务使用 computer use，在指定窗口完成……”，并在首次使用的 DSH 原生卡片中批准任务和窗口范围。仅在显著提高完成/验收质量、明显减轻工作或任务必需时调用，优先使用足够的 API、文件或命令行工具。同一任务内无需逐步重复批准；新任务或范围变化需重新批准。初版只操作可见且未最小化的窗口。'),
      data?.lastError ? h('p', { className: 'ddc-error', role: 'status' }, data.lastError) : null,
      error ? h('p', { className: 'ddc-error', role: 'alert' }, error) : null,
      h('p', { className: 'ddc-note' }, '桌面操作 0.1.5 · 技能 computer-use · Windows 引擎基于 dsh-computer-use-win 0.5.0（MIT）。'));
  }
  function apply(ctx) {
    ctx.effect(() => {
      const style = document.createElement('style'); style.dataset.plugin = 'dsh-desktop-control';
      style.textContent = '.ddc-settings{max-width:640px;font:14px/1.65 inherit;color:var(--dsw-alias-label-primary,#25252a)}.ddc-settings p{margin:0 0 16px}.ddc-note{font-size:13px;color:var(--dsw-alias-label-secondary,#6a6a72)}.ddc-status{border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:10px;padding:14px;margin:16px 0}.ddc-settings button,.ddc-settings select{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#ccc);padding:9px 12px;border-radius:8px}.ddc-settings button{cursor:pointer}.ddc-settings button:disabled{opacity:.5;cursor:default}.ddc-field{display:grid;gap:8px;margin:22px 0}.ddc-field select{max-width:280px}.ddc-error{padding:12px;border:1px solid #bb5b5b;border-radius:8px;overflow-wrap:anywhere}.ddc-settings :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#6559c7);outline-offset:3px}';
      document.head.appendChild(style); return () => style.remove();
    });
    // The Hub service can exist before its settings child slot is declared.
    // Follow the slot lifetime so concurrent boot and parent remounts are safe.
    ctx.slots.inject('plugin-hub.settings', () => ctx.pluginHub.registerSettings({ id: 'desktop-control', label: '桌面操作', description: '桌面工具开关、截图尺寸与停止方式', keywords: ['computer', '桌面', '鼠标', '键盘', '截图'], order: 40 }, SettingsPanel));
    ctx.effect(() => ctx.pluginHub.registerAction({ id: 'desktop-control:settings', label: '桌面操作', description: '查看状态、暂停桌面工具', order: 40, async run(context) { context.closeMenu(); ctx.pluginHub.openSettings('desktop-control'); } }));
  }
  return { inject: ['pluginHub', 'slots'], apply, SettingsPanel };
} });
