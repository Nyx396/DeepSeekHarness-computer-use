# DSH Desktop Control · 桌面操作

Windows 桌面操作插件测试版，包名 `dsh-desktop-control`，版本 `0.1.5`。面向 DSH Desktop `0.2.1-rc.2`、Windows x64、系统 Windows PowerShell 5.1。使用已有 `dsh-plugin-hub 1.0.0` 的扩展口袋和插件配置页。

## 使用

安装后重新启动 DSH。在扩展口袋中选择“桌面操作”打开插件配置，再进入“桌面操作”；也可从“设置 → 插件配置 → 桌面操作”进入。页面可查看状态、暂停工具和调整截图宽度。

聊天示例：

> 授权本任务使用 computer use。找到我指定的测试窗口，先观察界面，再在输入框中输入“你好，桌面操作”，检查输入结果。

**调用前提：用户明确授权当前任务，并至少满足以下一项：显著提高完成/验收质量、明显减轻工作或优化流程、不使用就无法完成。** 能用专用 API、文件或命令行工具充分完成的任务优先使用这些工具，不因技能存在而自动加载、列窗口或截图。授权在同一任务的连续步骤和轮次内有效；目标或范围变化时重新询问，撤销后停止。减少无目的重复截图和自检，保留必要的输入前观察和结果验证。

明确授权指用户提出使用 computer use、桌面控制、接管鼠标键盘，或同意模型此前的申请。只描述“在窗口中输入并点击按钮”这一目标时应先询问，不能自行推断已获授权。

首次使用还须在 **DSH 原生批准卡片**确认任务、具体收益和完整窗口标题范围。`desktop_begin_task` 仅申请批准，不启动桌面引擎；批准后返回绑定会话的随机 authorizationId。其他 9 个桌面工具均由后端校验该令牌，缺失、伪造、过期或跨会话时直接拒绝。窗口枚举按批准标题过滤，观察/输入绑定 HWND 和 PID；新窗口范围需重新批准。无法获得批准通道、用户拒绝或取消均不执行，模型不能用“已获用户同意”的自述绕过。

任务结束调用 `desktop_end_task` 撤销令牌并释放引擎；同一未结束任务可跨轮次继续，无需逐步批准。暂停、重启或空闲 30 分钟会撤销授权。只想枚举窗口时可批准空窗口列表，这不允许观察窗口内容或输入。任务含义和是否满足收益条件仍由模型及用户判断；后端不理解语义，用户应在批准卡片中核对范围，完成后结束任务。批准只保存在内存，不持久化为长期许可。

插件给当前模型注册 11 个工具：任务批准与结束工具 `desktop_begin_task`、`desktop_end_task`，以及 `desktop_health`、`desktop_windows`、`desktop_activate`、`desktop_observe`、`desktop_click`、`desktop_type_text`、`desktop_keypress`、`desktop_scroll`、`desktop_drag`。观察支持截图、UI Automation 和系统 OCR。截图作为 DSH 原生图片附件交给当前会话模型，模型须声明图片输入能力。

插件同时注册独立可加载的 **computer use** 技能，技术名为 `computer-use`。模型可以调用 `skill({"name":"computer-use"})`，用户也可在技能菜单中调用。技能目录随插件安装、注册和卸载，不修改用户的全局技能目录；它仍使用上述工具执行操作，并非第二套桌面引擎。

截图结果含 `imagePreviews[].markdown`，模型应原样用于最终回复，不再猜测附件库内部路径。预览 PNG 位于 `<DSH_HOME>/cache/dsh-desktop-control/previews`，按内容去重。清理该缓存会使旧回复中的文件预览失效；DSH 原生工具附件仍由宿主保留。预览生成失败会明确返回错误，不掩盖为“全程无报错”。

不需要本地大模型、独立视觉模型、Python、uv 或另一个 API Key。截图和界面文字会经现有 DSH 模型路由发往当前供应商，本地只负责观察与执行。

目前会短暂占用真实鼠标、键盘与焦点。**Esc 或 Ctrl+Alt+F12 停止当前操作系列**。配置页的“暂停所有桌面工具”会取消正在进行的调用。停止后当前轮次不能自动重试；新的用户请求可以开始新系列。

每次输入必须携带最新 observationId，单次使用、120 秒有效、绑定当前会话/轮次/窗口。窗口位置或进程变化会拒绝输入。同一时刻由一个会话持有桌面，轮次结束释放，空闲超过 30 秒释放。坐标使用窗口内 0–1000 比例，适应多屏负坐标及图片重编码；每次输入后仍须重新观察验证。

## 安装

ZIP 解压后，先运行“检查环境.cmd”，再运行“安装.cmd”；卸载使用“卸载.cmd”。必须完整解压，保留 `plugin/` 和 `tools/`。需要先安装 `dsh-plugin-hub 1.0.0`。ZIP 不包含本机验证记录、测试任务、截图、日志或 DSH 运行时副本。

先完全退出 DSH（包括托盘）。安装器不主动结束用户进程。源码目录也可直接运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\portable.ps1 -Mode Check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\portable.ps1 -Mode Install
# 卸载：
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\portable.ps1 -Mode Uninstall
```

可选参数：`-DshPath <安装目录>`、`-DshHome <DSH 数据目录>`、`-Profile desktop`。

安装器将文件夹复制到 `<DSH_HOME>/custom-plugins/dsh-desktop-control/<profile>`，通过 DSH 自带 CLI 以 `link:` 注册。使用前会检查宿主/插件中心版本；离线执行且忽略安装脚本；备份 profile 元数据和旧插件，失败自动回滚。备份位于 `<DSH_HOME>/backups/dsh-desktop-control/`。不会依赖 F 盘源目录在运行时继续存在。

设置存于 `<DSH_HOME>/dsh-desktop-control.json`。引擎在首次工具调用时启动，空闲时不截图或操作鼠标；配置页暂停会关闭引擎。临时文件位于独立临时子目录；卸载插件上下文时关闭进程并清理。异常退出可能留有临时截图，后续版本再补启动清理。安装器只检查、复制运行文件，忽略开发测试目录。

## 开发和维护

运行时没有外部 npm 依赖；源码直接可用。

```powershell
node --test test/*.test.mjs
node test/native-smoke.mjs
# 宿主、界面与安装器测试所需环境见 CONTRIBUTING.md。
```

`native-smoke` 只创建并操作自己的独立测试窗口，测试结束关闭自身。运行时会短暂占用鼠标和焦点。`host-smoke` 使用本机 DSH 的真实 Cordis/Tools/附件组件，不调用收费模型。开发步骤见 `CONTRIBUTING.md`（源码目录提供）。

目录：`lib/` 为自行维护的 DSH 接入与控制；`vendor/windows-engine/` 为固定版本的 MIT 引擎；`skills/` 为模型操作流程参考；`tools/` 为安装与打包工具；`delivery/` 为 ZIP 入口；`test/` 为可复用回归测试。生成物默认写到源码旁的 `<源码目录名>-local-records/artifacts/`，可用 `DSH_TEST_ARTIFACTS` 指定其他源码目录外的位置。

运行 `npm run package` 在源码旁生成 `dsh-desktop-control-0.1.5-win-x64.zip` 和 SHA-256 校验文件。打包采用固定文件清单；ZIP 内仅含运行插件、安装器、使用说明、许可证及逐文件校验清单。回归测试源代码保留在源码目录，测试输出与本机任务记录不参与打包。请仅向仓库提交源码目录，不把旁边的 `*-local-records` 文件夹或整个插件集合目录一并提交。

`lib/windows/visuals.cs` 是自有视觉层。启动已批准的桌面引擎时，`lib/overlay.js` 在本实例临时目录生成运行副本，只替换覆盖层绘制与动画调度；上游停止钩子和输入代码保留，vendor 原始文件不修改。上游结构不匹配时拒绝套用，不静默退回错误适配。调试视觉可运行 `npm run test:visual`，它只离屏渲染 PNG，不操作桌面；`node test/overlay-live.mjs` 仅短暂显示并自动关闭本插件的预览层，不发送输入、不调用模型。

上游来源、许可证和版本锁见 [THIRD_PARTY.md](THIRD_PARTY.md)。更新时按 `UPSTREAM.json` 固定新提交，检查原始文件差异，重跑坐标、取消、互斥、宿主与原生窗口测试后再更改版本。不要直接追随 main 自动更新。

## 初版边界

只处理可见、未最小化的窗口；不提供虚拟鼠标或并行后台桌面。目标截图失败或只能得到可能被其他窗口遮挡的屏幕裁剪时，会拒绝转发该画面，要求还原、激活窗口后重新观察。权限高于 DSH 的窗口、UAC、安全桌面、锁屏和特殊自绘应用可能无法操作。原生树可能不完整，OCR 只有已安装的识别语言。剪贴板输入支持中文并尝试恢复原内容；操作期间不要同时修改剪贴板。

原生批准与后端任务令牌用于限制模型自行推断授权。任务批准后的执行仍依赖模型对画面与目标的理解。旧式非 DPI 感知应用的 PrintWindow 图像可能存在缩放差异，不能仅凭首次坐标派发宣称成功。

这是桌面级能力，不受文件工作区边界限制；安装和停用由用户控制。模型的外部动作审批仍由 DSH/用户策略负责。初版不含应用白名单、任务回放、跨进程桌面锁或无人值守保证。