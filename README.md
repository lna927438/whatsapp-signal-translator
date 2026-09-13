# HelloDog 翻译器

**用于 WhatsApp 与 Signal 的 Windows 聊天翻译软件。** 在同一个工作台切换聊天账号，查看收到的消息译文，并将回复翻译成对方的语言。

HelloDog is a Windows desktop translator for everyday WhatsApp and Signal conversations, with incoming and outgoing text translation, separate account sessions, translation history controls, and character usage tracking.

[HelloDog 官网](https://hellodog.net/) · [Windows 官方下载](https://hellodog.net/download) · [使用指南](https://hellodog.net/guide) · [更新记录](https://hellodog.net/updates)

## 当前正式版：0.5.7

2026 年 9 月 13 日发布。后续可下载版本、安装文件大小和 SHA-256 校验码以[官网下载页](https://hellodog.net/download)为准。

### 日常聊天

- WhatsApp 和 Signal 分别关联手机账号，在 HelloDog 中切换使用。
- 接收翻译与发送翻译分别控制，支持设置自己和对方使用的语言。
- 群聊翻译单独开启；历史消息可选择新消息自动、可见消息自动或点击翻译。
- 处理带表情的文字、回复正文及图片说明等文字内容；纯表情无需付费翻译。
- 保留已有译文，提供失败提示、单条重试和发送状态核对。
- 多账号资料分别保存，支持账号备注、顶部或侧边账号导航。
- WhatsApp 图片右键复制、另存为，以及链接复制等操作。

### 0.5.7 的主要更新

- 右下角版本提醒、管理员消息弹窗与消息中心；提醒不取得输入焦点，关闭后仍可查看有效通知。
- 管理员可向所有用户或指定 HelloDog 登录邮箱发送通知，设置有效期，并查看实际弹出和确认回执。
- 修复 WhatsApp 已归档页面遮挡聊天内容和聊天区域多余竖线的问题。

此前版本对历史消息、引用回复和带表情文字的漏翻译、图片右键操作、译文显示以及 Windows 图标做了改进。详细说明见[版本更新记录](https://hellodog.net/updates)。

## 开始使用

1. 从 [HelloDog 官方下载页](https://hellodog.net/download)下载安装程序。当前提供 Windows x64 桌面版。
2. 使用 HelloDog 账号登录；首次注册需要验证邮箱。
3. 添加 WhatsApp 或 Signal，按照提示用手机完成设备关联。
4. 设置双方语言，并按需要开启接收翻译、发送翻译和群组翻译。
5. 先与自己或同意测试的联系人核对一条短消息，再开始使用。

HelloDog 登录账号用于管理字符和用量，WhatsApp、Signal 仍需分别关联各自的聊天账号。独立账号代理设置目前仅支持 WhatsApp。

升级前先退出正在运行的 HelloDog，再运行官网下载的安装程序。正式版沿用已有数据目录，保留账号资料与本地草稿；独立测试窗口的数据不会自动合并到正式版。

## 字符用量、缓存与隐私

- 字符按成功翻译的原文计算，首尾空白不计，不按译文或附带上下文长度计费。
- 同一翻译请求成功后只结算一次。恢复已有译文缓存不会为同一个已完成请求再次扣减字符。
- 已确认失败且未结算的请求不扣减字符。结果待确认时，先核对原请求。
- 修改原文、目标语言或主动重新翻译，可能产生新的请求。历史消息首次翻译也会产生正常用量。
- 可在客户端或[官网用户中心](https://hellodog.net/account)查看余额与用量。套餐与在线支付暂未开放，字符额度目前由管理员添加。
- 启用云端翻译时，原文及必要上下文会发送至 HelloDog 云端和翻译服务商处理。请按需开启。

## 使用范围与常见问题

翻译完成、平台发送成功和对方已读是不同状态，请以平台回执判断发送进度。网络异常、账号关联状态以及 WhatsApp 或 Signal 的平台更新都可能影响使用。

翻译结果可能出现误解，需要结合上下文判断。图片文字识别、语音转写与普通文字消息翻译属于不同能力，不能将文字翻译说明视为全部媒体或通话功能的承诺。

遇到输入无法发送、部分历史消息没有译文、版本提醒或字符用量问题时，请先查看[使用指南](https://hellodog.net/guide#troubleshooting)。反馈时提供客户端版本、Windows 版本、平台、发生时间和复现步骤；截图请遮住私人消息、二维码和凭据。

## 当前版本源码与本仓库的关系

**本 README 介绍的是官网下载的 0.5.7 正式版。本仓库默认分支目前保留的是较早的 0.5.1 代码快照，不能直接视为 0.5.7 的对应源码。**

研究或构建 0.5.7 时，请使用正式版对应源码包，并查看包内构建说明及组件许可证：

- [HelloDog 0.5.7 对应源码 ZIP](https://download.hellodog.net/sources/v0.5.7/HelloDog-0.5.7-corresponding-source.zip)
- [当前可下载版本及对应源码入口](https://hellodog.net/download)

默认分支中早期的 signal-cli、翻译服务配置和开发流程可能与正式版不同。请勿将旧分支的说明直接用于当前安装包，也不要把服务端凭据写入客户端或提交到公开仓库。

## 开源组件与独立性

Signal 组件基于 Signal Desktop 修改，使用 AGPL-3.0 许可证，对应源码和许可证随上述源码包提供。其他组件的使用条件以各自许可证为准。

HelloDog 是独立产品，并非 WhatsApp、Meta 或 Signal 的官方产品或关联服务。
