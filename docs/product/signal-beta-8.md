# HelloDog 0.5.2-beta.8 本地修复记录

本轮针对 beta7 实机截图中的 Signal 输入失效、WhatsApp 发送回执浮层和连续发送草稿叠加。仅生成本地测试包，不部署服务或官网。

## 修复

- Signal：复现了 DOM 输入框已聚焦、Windows 键盘焦点仍在外层窗口的情况。点击内层 Signal 时转移原生键盘焦点，点击外层控件时归还焦点；事件正常交给官方输入框处理。窗口缩放后重新保持 Signal 子窗口的正确层级，避免被外层 Chromium 窗口挡住点击。后台账号不能抢焦点。
- WhatsApp：移除整个浮动发送队列，不再用第二组气泡遮挡原生消息。异常任务在“记录与恢复”中保留，可以从原对话继续同一任务；未知发送结果不自动重发。
- WhatsApp：停止直接替换编辑器 DOM。通过原生选区和编辑事务清空、填写、恢复草稿，确认选区属于原输入框和原联系人，再执行编辑；等待内部状态稳定后释放输入。保留下一条草稿，不把已发送原文反复塞回输入框。
- WhatsApp：历史翻译最多三个并发任务，优先最新可见消息；旧请求等待时仍能处理新消息。空缓存结果按未命中处理，避免反复刷新译文。
- WhatsApp：调整聊天列表的完整外层列，避免只缩放内部列表而留下错位分隔线；拖动区域保持在列表边缘。

## 验证范围

Windows 键盘用系统输入事件测试官方 Signal 的 React/Quill 输入框，并经过实际 HelloDog 父窗口、Signal 子进程和原生托管程序。覆盖外层控件与内层输入框切换、Enter、面板隐藏恢复和窗口缩放。测试发送仅进入内存列表，不关联真实账号。

上述基础键盘测试已通过。后来追加中文、表情及 Shift+Enter 的系统键盘测试时，电脑进入 Windows 锁屏；测试在检测到锁屏遮挡后停止，没有向锁屏或其他应用输入。追加的系统键盘项目尚未完成，不能以浏览器事件测试代替这一结论。

WhatsApp 使用 Meta 的 Lexical 0.50.0、实际 Electron 发送适配器和本地模拟回执验证连续发送，检查编辑器内部草稿与显示内容，而不只检查 DOM 文本。另有断网、原请求恢复、同文本不同消息、历史缓存和设置变更的自动回归测试。原生 Signal 的功能来自已集成的官方 v8.27.0 源码，不声称已经实测所有通话、网络和媒体组合。

真实联系人收件、云端翻译耗时及手机端回执仍需用户在本机测试。此轮没有代用户发消息或拨打电话，未自动重发旧版状态未知的任务。

## 源码参考

- Signal Desktop：<https://github.com/signalapp/Signal-Desktop>，AGPL-3.0-only；固定提交见 integrations/signal-desktop.lock.json。
- Windows 焦点：<https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setfocus>。
- WhatsApp 接入参考：<https://github.com/wppconnect-team/wa-js>；本轮查阅其消息标识和回执设计，没有引入未经实机验证的自动发送 SDK 替换当前登录会话。
- 离线编辑器验证：<https://github.com/facebook/lexical>。验证依赖不打包进用户程序。

对应修改源码随测试包提供；保留上游版权和许可证。测试包沿用独立测试数据目录 HelloDog-test-beta6，以保留此前扫码账号和草稿。
