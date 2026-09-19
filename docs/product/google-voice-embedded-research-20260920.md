# Google Voice 完整内嵌方案核查

核查日期：2026-09-20。目标是在 HelloDog 内使用 Google Voice 官方页面、多账号和翻译，不再依靠外部浏览器窗口拼接。用户已在修复后的真正内嵌验证窗口完成登录，并确认能看到短信会话列表。实现已接回 HelloDog 主进程、账号标签与内置翻译入口；当前为本地候选版，尚未发布。真实短信发送、通话、通知和实际账单仍需业务验收。

## 为什么会弹出外窗并留下空白

此前 beta.2 版本先启动 Chrome/Edge 独立窗口，再由辅助程序把浏览器放进跟随 HelloDog 移动的顶层窗口。它并非客户端真正的网页子视图，所以仍依赖窗口接管、前台状态和缩放同步。

旧代码还确认了两处缺陷：`workspace.ts` 的 `extensionSetup()` 进入 `withExternal()`，会主动拆出浏览器并打开扩展设置；关闭设置后没有重新接入，也没有同步客户端状态。辅助程序断开时，主进程虽然把 `ready` 改为 false，页面却仍可能保持 ready，仅短暂提示错误。ready 页面不显示恢复说明，就形成持续空白。新默认路径已移除这些外窗接管与扩展配对步骤。

这些路径已通过本地诊断确认，但截图没有前序操作，不能断言是哪一条触发。截图中的 Workspace 介绍页也不能单独证明账号无法登录。详见[当前缺陷记录](../../verification/google-voice-embedded-research-20260920/current-defects.md)。

## 开源与内核方案比较

| 方案 | 检索到的证据与适用性 |
| --- | --- |
| **Electron WebContentsView** | 官方支持把网页作为主窗口的子视图；可沿用 HelloDog 内核和独立账号会话，是优先验证方向。[官方文档](https://www.electronjs.org/docs/latest/api/web-contents-view) |
| **Ferdium** | 主程序仍维护，稳定版 7.2.3 于 2026-09-07 发布；Voice 有登录跳外部浏览器问题，2026-06 仍有改 UA 后被拒的反馈，不能照搬为已解决方案。[发行](https://github.com/ferdium/ferdium-app/releases/tag/v7.2.3)、[登录问题](https://github.com/ferdium/ferdium-app/issues/2200) |
| **Jerrkawz / Google Voice Desktop** | 已更名为 jerrod-lankford 项目，最新发行 1.3.1 为 2022-08-05；依赖 Electron 14，远程页面开启 Node、关闭隔离，不宜直接复用。[版本与依赖](https://github.com/jerrod-lankford/google-voice-desktop-app/blob/master/package.json)、[代码](https://github.com/jerrod-lankford/google-voice-desktop-app/blob/master/src/main.js) |
| **WebView2 / CEF** | 能做内部网页容器，但换内核不等于解决 Google 登录；微软明确说明 Google OAuth 流不支持 WebView2。[微软说明](https://github.com/MicrosoftEdge/WebView2Feedback/issues/1647)、[Google 对 CEF 的说明](https://support.google.com/accounts/answer/7675428?hl=en&co=GENIE.Platform%3DDesktop) |
| **Nativefier / Rambox CE** | 开源版本分别已于 2023、2022 年停止维护或归档，不适合作为新版本基础。[Nativefier](https://github.com/nativefier/nativefier)、[Rambox CE](https://github.com/ramboxapp/community-edition) |
| **googlevoicetray** | 2026-09 仍有更新，但使用 Electron 30、iPhone UA 和移动设备模拟，目标是托盘小窗，不符合官方桌面原版体验。[代码](https://github.com/brysonwf/googlevoicetray/blob/master/main.js)、[依赖](https://github.com/brysonwf/googlevoicetray/blob/master/package.json) |

## 推荐实现与登录边界

WebContentsView 将页面直接挂到 HelloDog 主窗口，尺寸、标签切换和关闭由客户端管理，无需寻找 Chrome 窗口再搬入；因此是结构替换，不是隐藏外窗边框。每个账号保留独立会话，官方页面的必要弹窗也在客户端内承载，并保留原有会话和页面通信。

但 Google 官方明确可能阻止其他应用内嵌浏览器登录；Voice 官方兼容列表也没有承诺 Electron、CEF 或 WebView2。[登录说明](https://support.google.com/accounts/answer/7675428?hl=en&co=GENIE.Platform%3DDesktop)、[Voice 浏览器要求](https://support.google.com/voice/answer/9682580?hl=en)

所以先用安全默认配置、独立数据目录验证真实流程，不采用浏览器身份伪装、复制外部 Cookie 或关闭安全隔离。第三方 OAuth 授权也不等于获得 Voice 网页登录会话。原型保留沙箱、隔离和远程 Node 禁用，按来源管理麦克风、通知和下载权限。[Electron 安全指引](https://www.electronjs.org/docs/latest/tutorial/security)

## 登录修复与正式接线

初次实测在验证码后无法前进，诊断发现官方登录完成流程经过 `accounts.youtube.com/SetSID`，旧导航列表未允许这个地址。Google 官方列明该域名属于登录依赖；修复只允许 `/SetSID` 与 `/accounts/SetSID`，没有开放任意 YouTube 导航，也不记录其参数。随后用户实际完成登录并确认短信列表可见。[Google 网络依赖说明](https://support.google.com/chrome/a/answer/6334001?hl=en)

新路径使用独立账号会话、沙箱和上下文隔离。只有已登记的 Voice 主页面能请求翻译；Google 登录页不运行翻译代码，页面脚本拿不到通用客户端接口。账号切换、页面导航及关闭会撤销旧操作；网络错误、页面崩溃和意外关闭都会显示恢复入口。麦克风和通知由 HelloDog 设置面板按账号允许；下载显示保存对话框。

短信翻译与发送保护复用原有翻译、余额和发送账本；首尾空白导致付费译文无法通过发送核验的问题已修复。升级时从本机回执恢复能唯一确定的未发送草稿及原请求编号，不读取浏览器私有资料；已发送草稿不会复活，无关的已清理历史不影响新消息。内嵌模式直接加载共享代码，不需要配对码或手动安装扩展，打包文件不再包含退役的 Google Voice 外窗辅助程序。

## 两级验收

1. **容器验收**：内部显示、缩放、多账号隔离、弹窗通信、切换、关闭、异常恢复；确认没有意外外窗，失败时有明确说明。
2. **真实业务验收**：用户完成 Google 登录和验证后，核验会话重启恢复、短信收发、翻译拦截、字符扣费、麦克风、通话和通知。加载介绍页或通过模拟测试均不能代替这一层。

容器模拟验证使用 Electron 44.3，覆盖真实子视图、弹窗及 POST 保留在内部、登录完成跳转、账号隔离、外部地址拦截、弹层显隐和缩放跟随。共享翻译入口另有真实隔离环境测试，覆盖导航撤销、旧按钮失效、页面释放及历史返回恢复；模拟本身没有发送真实消息或产生费用。详见[容器验证结果](../../verification/google-voice-embedded-research-20260920/embedded-fixture.json)和[内置翻译入口验证](../../verification/google-voice-preload-20260920/preload-fixture.json)。

本轮整套回归 903 项通过，最后修改完成后 Google Voice 定向回归 148 项通过。真实 Electron 容器模拟 9 项、隔离翻译入口模拟 12 项通过；真实 Vue 界面在 1280×800 顶部标签与 960×640 侧边标签布局通过。主进程、界面和测试类型检查通过，源码与最终构建扫描未发现凭据。

下一步按以下顺序验收：

- 已完成验证窗口中的真实 Google 登录。接回完整 HelloDog 后，仍需在对应独立账号会话中检查登录与重启恢复；不复制外部浏览器或验证窗口的 Cookie。
- 打开已有接收短信，检查原文、译文、历史消息补译和对应字符记录。
- 检查发送前预览、中文拦截、翻译失败与余额不足时不发送；使用模拟接收端核验失败路径。真实短信仅在用户明确指定测试内容和收件人后发送，不向现有联系人擅发测试消息。
- 由用户验证麦克风、扬声器、通知授权及测试通话；检查切换账号或缩小客户端后是否仍能正常接听。
- 对照真实翻译记录、用户余额和后台流水，核对成功扣费、失败不扣费、重试不重复扣费。

目前发送保护只对已识别的纯文字会话启用，附件及新建收件人流程仍待验证；不把这些限制隐藏为“全部功能已完成”。能否满足全部官方功能，必须以第二级实际结果决定。
