# 开发与发布

运行时无外部 npm 依赖，开发需要 Node.js 22+、Windows x64 和 Windows PowerShell 5.1。宿主集成测试需要本机 DSH 0.2.1-rc.2 与 dsh-plugin-hub 1.0.0；不分发宿主文件。

## 测试输出与本机记录

`test/` 只存放可复用测试脚本和 fixtures。生成物默认位于源码目录旁的 `<源码目录名>-local-records/artifacts/`；可设置 `DSH_TEST_ARTIFACTS` 指向其他源码目录外的位置。截图、日志、浏览器 profile、提取的宿主运行时、模型测试任务和验收记录均不得提交或装入 ZIP。

本机验收记录不属于源码。发布前只检查当前源码目录，不要将旁边的整个工作目录加入仓库。`.gitignore` 是补充保护，ZIP 的固定文件清单才是打包边界。

## 回归命令

```powershell
node --test test/*.test.mjs
# 以下两项会创建自己的测试窗口或预览层，需要允许短暂占用桌面：
node test/native-smoke.mjs
node test/overlay-render.mjs
node test/overlay-live.mjs
node test/overlay-engine.mjs
```

`overlay-render` 为离屏绘制，`overlay-live` 仅显示本插件预览层，不发送输入；`native-smoke` 会向自己的专用窗口发送真实输入。物理停止热键应另行人工验收，程序内测试入口不能替代。

```powershell
$dshInstall = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
$dshData = Join-Path $env:USERPROFILE '.dsh'
$env:DSH_TEST_ASAR = Join-Path $dshInstall 'resources\app.asar'
node test/prepare-runtime.mjs
$env:DSH_TEST_RUNTIME = Join-Path (Split-Path (Get-Location) -Parent) ((Split-Path (Get-Location) -Leaf) + '-local-records\artifacts\runtime\dsh')
node test/host-smoke.mjs
$env:DSH_TEST_HUB_ROOT = Join-Path $dshData 'custom-plugins\dsh-plugin-hub\desktop'
node test/ui-image.mjs
node test/ui-smoke.mjs
node test/ui-boot.mjs
# 安装器只写隔离 profile，仍要求先退出 DSH：
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/portable-smoke.ps1 -DshPath $dshInstall -HubRoot $env:DSH_TEST_HUB_ROOT
```

宿主和前端测试不调用收费模型。真实模型验收需要明确授权、指定供应商及模型，并在新会话确认实际路由；测试任务和结果只保存在源码外。

## 打包

```powershell
npm run package
# 只读校验 ZIP 与当前源码、内部逐文件校验和、外部 SHA-256：
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/verify-release.ps1
# 从 ZIP 解压并使用真实 CLI 验证隔离安装/卸载，不写真实 DSH profile：
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/release-install.ps1 -ZipPath ../dsh-desktop-control-0.1.5-win-x64.zip -DshPath $dshInstall -HubRoot $env:DSH_TEST_HUB_ROOT
```

默认 ZIP 和校验文件输出到源码父目录；临时打包目录位于源码外的本机记录目录，成功后删除。已存在同名 ZIP 时拒绝覆盖。便携 ZIP 不含开发测试脚本，不代表源码仓库不应保留测试。

更新上游时固定提交并核对 `vendor/windows-engine/UPSTREAM.json`。保持 vendor 原字节，视觉适配放在自有代码和临时运行副本；结构不匹配应拒绝运行。至少重跑授权、坐标、取消、互斥、图片、宿主和原生窗口回归，再修改版本。
