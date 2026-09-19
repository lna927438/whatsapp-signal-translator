# HelloDog Google Voice 扩展 · 本地 beta.2

支持已识别的 Google Voice 英文界面、已有短信会话中的纯文本：可见历史自动翻译，发送前预览，用户明确确认后提交一次。收到和已经发出的消息都可翻译为 HelloDog 的本地语言。

**本地功能验证不等于真实收发验收。** 官方页面的输入框、按钮和双向纯文本消息结构已获授权只读核对；真实短信发送、送达、通话和实际余额扣费尚未验收。不能宣称 Google Voice 全部功能与翻译均已完成。

本扩展不是 Google 官方产品。Google Voice、Google Chrome 及其相关商标属于 Google LLC；Microsoft Edge 属于 Microsoft Corporation。

## 使用范围

- 配对后查看短信输入框上方的状态。只有识别出已有会话、唯一输入框及原站按钮，才允许准备发送预览。配对成功本身不代表当前页面受保护。
- 可见历史自动翻译遵循 HelloDog 接收翻译、历史模式、显示译文和本地语言设置。每次处理一条可见消息；手动点击“翻译”可翻译已识别内容。翻译失败可明确重试，不自动无限重发。
- 点击原站发送按钮或按普通 Enter，保留草稿并准备预览；点击“确认发送”时再次核对主机的账户、额度、已结算译文、目标语言、当前会话和草稿。中文残留、授权失败或上下文变化时不回退发送中文原文。
- Shift+Enter 保留换行；IME 确认、Ctrl/Alt/Meta+Enter 不触发翻译发送。仅同步放行精确的原站按钮，不使用全局放行时间窗。
- 派发前由 HelloDog 持久化一次尝试。点击成功只代表“已提交一次”，不代表送达；同样原文或译文重发前须查看官方记录并确认此前已发送或未发送。不同新草稿可继续，不要求每条发送后立即核对。
- **新建收件人、图片/附件草稿及其他未识别编辑器暂不支持翻译发送。** 已知发送入口、添加图片、编辑器内粘贴或拖入文件会拦截并说明原因。未知新页面入口可能不在拦截范围，不能声称覆盖未来所有网页变化。
- 右键“使用 HelloDog 翻译选中文字”提供只读预览，不填写、不发送。
- 扩展停用、卸载或未安装时无法拦截官方网页；其他浏览器资料也不受本资料扩展保护。

## 安装和配对

1. HelloDog 选中对应 Voice 窗口并打开“扩展安装”，使用该记录的专用 Chrome/Edge 资料。不同窗口资料须各自安装和配对。
2. 打开的扩展管理页启用“开发者模式”，选择“加载已解压的扩展程序”，选择包含本文件和 manifest.json 的目录。安装在日常个人浏览器不会覆盖所有 HelloDog 窗口。
3. 确认 ID 为 **kigfaejcipjibnmnpinplphfldjahknn**，固定扩展到工具栏。粘贴 HelloDog 短期连接码并连接，不向他人发送连接码或令牌。
4. 刷新原有 Voice 页面。关闭管理扩展的普通浏览器窗口，再回 HelloDog 重新接入 Voice。
5. 更新解压目录后，在扩展管理页“重新加载”并刷新 Voice 页面。本地侧载没有商店上架或自动更新。

Chrome 正式版已不支持用 --load-extension 自动加载本扩展。本实现不使用企业策略强装、修改个人资料偏好或绕过组织安装限制。

## 防止重复请求和发送

**历史消息：** 已核实 DOM 未提供稳定消息 ID。扩展按会话、收发方向、完整可访问时间文字和正文生成翻译内容编号。相同内容和时间共用译文；虚拟列表重绘本页复用，刷新后沿用编号交给 HelloDog 缓存和计费幂等机制处理。这不是官方消息 ID，不用于认定送达；无法区分的同时间同文实体共用一次翻译，不猜测序号反复扣费。

**发送草稿：** 受信任存储只持久化绑定、会话与正文组合的哈希、随机 UUID 和请求编号，不保存草稿正文。页面或后台重启后同草稿沿用 UUID；核对“未发送”保留编号，核对“已发送”后再写同文才分配新编号。重新配对、清除扩展数据或改变翻译设置可能产生新上下文，不承诺跨这些操作永不新增计费。

**发送结果：** 主机持久化 requestId 和 attempt，以原文和译文匹配待核对任务；旧 attempt 不得核销后续尝试。不确定结果绝不自动重放。核对未发送后也须重新手动预览、确认。

**手动选择：** 同文档、绑定及语言下复用业务编号和成功结果；刷新、改变绑定或语言后可能重新计费。

Native 桥接只接受一个在途请求，忙碌时新操作明确未提交；70 秒界面超时仍保留占用，直到迟到回执或断开。自动历史只对“忙碌且未提交”延后处理，不自动重发失败或未确认请求。

## 本机桥接

- Native host 为 net.hellodog.google_voice，精确允许 chrome-extension://kigfaejcipjibnmnpinplphfldjahknn/。
- 安装与注册表由 HelloDog 主进程负责。扩展不写注册表、不启动 HTTP 服务；官方 stdio host 通过当前 Windows 用户的私有管道连接 HelloDog。
- manifest 公开 key 只稳定扩展 ID。一次性连接码换取仅绑定用户和窗口的令牌；主机判断真实用户、语言、额度及计费，网页不能指定后端或用户。
- 令牌保存在设置 TRUSTED_CONTEXTS 的 chrome.storage.local，不返回内容脚本/网页、不写日志。这是本机浏览器存储，不等同独立加密保险箱。重新配对同记录使旧主机令牌失效；“断开连接”只清除本资料令牌。
- 校验自身扩展 ID、popup 精确 URL、Voice 官方源及主框架；会话哈希须对应 sender URL。绑定变化后拒绝旧请求结果。
- 只有 nativeMessaging、storage、contextMenus 和精确 Voice host 权限，不使用 cookies、debugger、webRequest、MAIN-world 注入、私有框架状态或 window.postMessage。

请求：{v:1,id:<transport UUID>,op,pairToken?,payload?}。响应：{v:1,id,ok:true,result} 或安全错误。业务 payload.id 与每次新建的 transport ID 分开。

| op | payload | result |
|---|---|---|
| pair | code | pairToken |
| status | 无 | 连接、语言、翻译显示设置 |
| translate | direction,id,conversationId,text,manual? | enabled,text,requestId,untranslated? |
| authorize | id,conversationId,text,translated,requestId | authorized:true,requestId,attempt |
| dispatch-status | conversationId,text | state:clear 或 state:uncertain,requestId,attempt |
| dispatch-resolve | conversationId,requestId,attempt,outcome,confirmed:true | resolved:true |

voice.outgoing-id 是扩展内部操作，不是 native op。已发历史消息的阅读翻译也通过 incoming 方向进入本地语言，但内容编号包含原消息的收发方向。

## 本地验证

从仓库根目录运行；改来源模块后先生成 content.js：

```text
integrations/tools/node-v24.17.0-win-x64/node.exe integrations/google-voice-extension/build-content.mjs
integrations/tools/node-v24.17.0-win-x64/node.exe --experimental-strip-types --test integrations/google-voice-extension/tests/extension.test.mjs
integrations/tools/node-v24.17.0-win-x64/node.exe integrations/google-voice-extension/tests/browser-fixture.mjs
integrations/tools/node-v24.17.0-win-x64/node.exe --experimental-strip-types integrations/google-voice-extension/tests/voice-dom-fixture.mjs
```

浏览器样例用独立临时资料、拦截网络返回合成 HTML，不连接 Google、不拨号、不发短信、不调用真实翻译。结果及边界见 VALIDATION.md。

## 官方资料

- [Chrome 开发安装](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- [Chrome 137 移除 --load-extension](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY)
- [Edge 开发侧载](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading)
- [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Google 登录限制](https://support.google.com/accounts/answer/7675428?hl=en&co=GENIE.Platform%3DDesktop)

不绕过 Google 登录/账号限制，不承诺 Google 官方支持窗口嵌入、扩展兼容或后台来电行为。
