# 验证记录 · 2026-09-20（UTC+8）· beta.8 附件修复

## 官方页面结构证据

已有会话、双向纯文本气泡、原站输入与发送按钮已经授权只读核对。早期去标识化记录：`verification/google-voice-embedded-20260918/official-dom-observation.json`。后续只读取了用户主动打开的已选收件人草稿和图片说明预览，没有保存真实正文、号码、邮箱、会话路由值或图片内容。

- 已有短信路由为 `itemId=t.…`，新短信为 `itemId=draft`。已选收件人在 `gv-message-party-picker mat-chip-grid mat-chip-row.chip-row` 中，确认的号码取自该 chip 唯一可访问文本；待输入号码或只有名称不放行。支持完整选定的 1–7 位收件人。
- 原文气泡为 `gv-annotation.content`，有明确 incoming/outgoing 容器和完整可访问时间。没有稳定官方消息 ID；本机生成的幂等身份不当作官方送达回执。译文位于原气泡内，原文在上、译文在下，并从后续原文提取中排除。
- **真实图片编辑器没有 img 元素。** 附件位于 `gv-message-entry gv-send-attachment-list > div.container[role=grid]`，行中的 `div.item[role=gridcell]` 含 `div.content` 背景图及 `span.close-icon-overlay[role=button]` 移除按钮。图片说明仍为 entry 内 `textarea.message-input`，发送仍为 `button.send-button`；不是另一个独立发送入口。
- 原站文件选择接受 JPEG、PNG、GIF、BMP。仅对获授权的合成测试图比较过 CSS data 背景与原文件：均为 3,450 bytes，SHA-256 相同。未保存或输出 data URL。不同图片是否被官方压缩仍需逐次核对，不能用这个样本推断所有图片都保持原字节。

## 本轮复验

| 验证 | 通过 | 结果 |
| --- | ---: | --- |
| Node 协议、发送保护及桥接单元 | 38/38 | `tests/extension.test.mjs` |
| 独立 Edge 通用保护、手动选文 | 10 项 | `tests/artifacts/browser-results.json` |
| 纯文本官方 DOM 形状＋实际 main 业务代码 | 18 项 | `tests/artifacts/voice-dom-results.json` |
| 旧 img 预览兼容、媒体账本、新收件人/群组 | 14 项 | `tests/artifacts/media-dom-results.json` |
| **真实 CSS 附件形状**及生产 adapter/runtime | **12 项** | `tests/artifacts/css-media-dom-results.json` |
| 原生气泡内译文、窄屏/深色、重绘防污染 | 7 项 | `tests/artifacts/bubble-results.json` |
| 真实 Electron sandbox/隔离 preload＋main 业务链 | 18 项 | `verification/google-voice-preload-20260920/preload-fixture.json` |

以上使用本地合成页面。涉及 main 的样例使用实际翻译桥和发送账本代码，提供方、钱包及存储由合成对象替代。Electron 记录由独立验收任务生成，最终 `passed: true`，覆盖纯图片、说明翻译、未知发送恢复、换图与坏图删空恢复；不把浏览器样例结果代替 preload 验证。`content.js` 已按本轮源文件重新生成。

CSS 附件回归覆盖：

1. 只有 CSS 背景、没有 img 时可以准备纯图片预览；仍需明确确认，不调用文字翻译，也不对空说明执行无意义 input 改写。
2. 图片已发出或移除最后一张后，即使原生 input.files 陈旧也不会重新恢复附件，原始字节引用会释放。
3. File change 先到、CSS 暂时还是旧图时拒绝准备旧图；style 单独更新后恢复识别。
4. 中文图片说明的 Enter 和原站发送按钮进入同一预览/确认流程。文字确有变化时仍等待原站输入更新，再逐项核对。
5. 追加选择只有新 File 时保留当前图片；重复同一文件的数量、局部移除和顺序纳入指纹。
6. 更换图片后旧确认失效；无匹配 File 的 CSS 字节或官方重编码预览明确拒绝，不猜测映射。
7. 不支持的文件在官方 change 处理前取消，并保留此前有效草稿。
8. 无法解码的图片与超时读取都会给出可恢复说明。点击原站移除全部附件后，文字编辑和翻译恢复；晚到的读取结果不能复活附件。
9. 相同文字跳过输入改写的分支仍检查完整会话、收件人、草稿修订和附件状态；变化后不点击发送。

成功界面合成截图：`tests/artifacts/css-media-image-preview.png`、`css-media-caption-preview.png`。等待失败示例：`css-media-stalled-error.png`。这些截图均不含真实联系人和短信。

## 计费和发送边界

- File 原始字节与官方 CSS 预览逐张绑定；跨桥只传 SHA-256 指纹、图片数量、类型和总字节数，不传图片内容或本地路径。
- 图片上限 10 张、合计 20 MiB，GIF 单张不超过 2 MiB。纯图片不调用文字翻译；说明文字沿用字符钱包、幂等请求与发送账本。
- 刷新后相同图片及文字的未确认记录仍先核对，不能自动重发；新短信首次发送导致路由切换后仍保留待核对保护。跨路由“确认未发送”按主机指引返回原收件人草稿，不能误清另一份账本记录。
- 未知页面结构、未验证图片及不完整收件人保持拒绝；额度不足保留中文原稿，绝不退回发送中文原文。
- 本轮顺便修复了媒体测试等待条件：浏览器轮询使用同步状态判定，避免把异步 predicate 的 Promise 当作就绪；这属于测试修正，与官方 CSS 预览识别这一产品根因分别记录。
- Electron 合成测试窗口使用 offscreen 绘帧，使 changed-text 的双 requestAnimationFrame 真实完成；未为测试放宽生产发送等待和快照保护。

## 实际验收边界

- 用户此前在 Chrome 中自行发送了合成测试图，并向主任务确认收到。那次结果只证明该 Chrome 操作，不证明 HelloDog 中的发送链路。
- 用户在 HelloDog beta.7 选择图片后能看到官方预览，但 HelloDog adapter 当时误报预览未完成；本轮修复的正是这个问题。
- **HelloDog beta.8 的真实图片派发与收件方送达仍待用户验收。** Agent 没有发送、重发、拨号、移除已发送消息或修改当前用户草稿；本轮真实 Chrome 只读查看结构。
- 视频、音频附件不在已验证的图片短信发送范围。通话按当前用户指示暂缓。已提交只表示执行过原站发送动作，不是送达回执；不因等待时间自动重发。
- 本地候选构建不等于正式上线、扩展商店上架或 Google 官方支持。实际账户余额、云端账单及生产部署由各自记录验收。
