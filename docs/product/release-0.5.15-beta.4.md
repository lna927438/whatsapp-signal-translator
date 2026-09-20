# HelloDog 0.5.15-beta.4 · Google Voice 地区登录修复

修复 Google Voice 两步验证后点击“下一步”停在原页的问题。补齐 Google 官方地区登录跳转，继续在客户端内部打开。

问题原因：beta.3 只覆盖 accounts.google.com 和 YouTube 的指定登录桥接地址，未覆盖 Google 按地区选择的 accounts.google.co.th 等官方登录地址。新版本根据 Google 官方目录固定保存 187 个精确 Accounts 主机名，不使用通配域名，也不在运行时下载信任规则。

官方来源：

- https://support.google.com/chrome/a/answer/6334001?hl=en 明确列出 accounts.google.[country] 用于 Google 登录。
- https://www.google.com/supported_domains，2026-09-20 获取；原始响应 SHA-256：ba827017007f54b698de62a5e3bb290327c12ddc0f9c88503511725c0baf3c49。

账号隔离和存储路径保持一致。地区登录页只获得页面跳转许可，不能使用 HelloDog 翻译、计费、麦克风、通知、剪贴板或下载功能。认证参数不写入状态提示。

验证：151 项 Google Voice 回归通过；9 项真实 Electron 合成容器检查通过，包括 .com → 泰国 → 英国 → YouTube → Voice 的完整跳转保持同一子视图和账号会话；12 项隔离预加载检查通过，通用和地区登录页均不触发翻译调用；主进程与测试类型检查通过。

本版是本地验收包，尚未发布到正式更新通道。自动化使用合成页面，不代表真实账号已完成登录。请从“文件 → 退出”关闭旧版后打开新版，回到 Google Voice 官方页面重新完成必要的验证。已保存登录资料不清除；无需向他人提供密码或验证码。真实短信、附件和通话仍按 beta.3 的验收范围逐项确认。
