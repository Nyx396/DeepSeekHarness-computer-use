# 第三方代码

## Windows 桌面引擎

`vendor/windows-engine/` 选取自 [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)，版本 0.5.0，固定提交 `a6d6c2e625e15ca322842b038b4e9165bee1d42f`。该项目又基于 cgissing 的 Windows Computer Use 实现。

保留原始 [LICENSE](vendor/windows-engine/LICENSE)、[THIRD_PARTY.md](vendor/windows-engine/THIRD_PARTY.md) 和包元数据。版权为 Yu-tao-Li 与 cgissing；许可证 MIT。上游文件没有功能修改，清单和 Git blob 标识见 `vendor/windows-engine/UPSTREAM.json`。

最小发布包仅分发上述引擎的运行文件及来源、许可证元数据，不分发开发源码中留存的 wiki 文档。UPSTREAM.json 保留完整的固定版本来源清单，包含未随最小包分发的文档条目；实际随包文件另列于 SHA256SUMS.txt。

本项目自行维护 DSH 工具注册、附件/当前模型接入、比例坐标、观察有效期、会话互斥、配置页、安装和本机集成测试。没有采用上游的 DSH 前端或适配器。

0.1.4 的极光边缘和蓝色箭头由 `lib/windows/visuals.cs` 实现。`lib/overlay.js` 仅在临时运行副本中适配上游覆盖层的 Frame 和 Pointer 绘制以及动画调度，保留上游停止监听、命令派发和输入代码；原始 vendor 文件与 Git blob 校验不变。临时副本携带上游包元数据和 MIT 许可证，销毁插件实例时一并清理。

0.1.5 在自有视觉层中加宽极光边缘并提高外沿不透明度，继续保留向内衰减；上游 vendor 文件未修改。

## 本地安装器

0.2.0 的任务令牌、持久停止闩锁和紧凑恢复卡片为本插件自有代码。使用 DSH 原生用户交互服务与工作台插槽，使用上游已有的 resumeToken 配置恢复同一停止系列；不修改 vendor 的停止监听或输入代码。

`tools/portable.ps1` 改编自现有 dsh-media-reader 的 MIT 安装器，保留 DSH Media Reader contributors 版权。修改包名与文件检查清单，沿用备份、离线 CLI 注册和回滚机制。

## 主机和系统组件

DSH、Windows PowerShell、.NET UI Automation、Windows OCR 均由用户的主机提供，没有随插件重新分发。运行时不下载软件、不安装 npm/Python 依赖。
