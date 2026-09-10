# Realtime Translator - Supabase 邮箱验证码与账号找回配置

本项目的官网与 Windows 客户端共享同一个 Supabase Auth 账号体系。

## 目标流程

### 注册

用户名 + 邮箱 + 密码 -> Supabase 创建用户 -> 邮箱收到验证码 -> 输入验证码 -> 邮箱确认成功 -> 账号可登录。

### 忘记密码

绑定邮箱 -> 邮箱收到账号安全验证码 -> 输入验证码 -> 设置新密码 -> 官网与 Windows 客户端同时生效。

### 忘记账号

绑定邮箱 -> 邮箱收到账号安全验证码 -> 输入验证码 -> 通过已验证会话读取自己的 profiles.username -> 显示用户名 -> 退出临时恢复会话。

## 1. 开启 Confirm email

Supabase Dashboard -> Authentication -> Sign In / Providers -> User Signups -> Confirm email

保持 `Confirm email` 为开启状态。否则 signUp 会直接返回 session，不会强制邮箱验证码。

## 2. 修改 Confirm signup 邮件模板

Supabase Dashboard -> Authentication -> Email Templates -> Confirm signup

建议主题：

`Realtime Translator 注册邮箱验证码`

示例 HTML：

```html
<h2>验证您的 Realtime Translator 邮箱</h2>
<p>您的注册验证码：</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">{{ .Token }}</p>
<p>请在 Realtime Translator 注册页面输入此验证码完成邮箱绑定。</p>
<p>如果不是您本人操作，请忽略此邮件。</p>
```

关键点：必须包含 `{{ .Token }}`，客户端会通过 `verifyOtp({ email, token, type: 'email' })` 验证。

## 3. 修改 Reset password 邮件模板

Supabase Dashboard -> Authentication -> Email Templates -> Reset password

建议不要只写“重置密码”，因为本项目同时用这个安全验证码做“忘记账号”和“忘记密码”的邮箱所有权验证。

建议主题：

`Realtime Translator 账号安全验证码`

示例 HTML：

```html
<h2>Realtime Translator 账号安全验证</h2>
<p>您的账号安全验证码：</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">{{ .Token }}</p>
<p>此验证码可用于找回账号或重置密码，请勿转发给任何人。</p>
<p>如果不是您本人操作，请忽略此邮件。</p>
```

客户端会通过 `verifyOtp({ email, token, type: 'recovery' })` 验证。

## 4. Site URL / Redirect URLs

虽然当前 OTP 输入流程不依赖用户点击邮件链接，仍建议设置正确站点地址：

- Site URL: `https://realtime-translator-web.lna927438.workers.dev`
- Additional Redirect URL: `https://realtime-translator-web.lna927438.workers.dev/**`

绑定正式域名后，再添加正式域名并逐步替换 workers.dev。

## 5. 执行数据库迁移

在 Supabase SQL Editor 执行：

`supabase/migrations/0003_auth_email_binding.sql`

作用：

- auth.users.email 变更时自动同步 profiles.email。
- 普通 authenticated 用户不能直接修改 profiles.email / plan_code / status。
- 普通用户只允许修改 username / display_name / avatar_url。

这保证“绑定邮箱”以 Supabase Auth 为唯一权威来源。

## 6. SMTP

Supabase 默认邮件服务适合开发测试。准备正式开放注册前，建议在 Authentication 邮件设置中配置自有 SMTP，例如 Resend、Postmark、Amazon SES 等。

上线前至少验证：

1. 新用户注册可以收到验证码。
2. 验证错误验证码会失败。
3. 验证正确验证码后可以登录。
4. 忘记密码邮件可收到 recovery 验证码。
5. recovery 验证后可以修改密码。
6. 修改后的密码能同时登录官网和 Windows 客户端。
7. 忘记账号流程只有在邮箱验证成功后才显示 username。
8. 未验证邮箱不能正常登录。
9. 多次请求验证码时遵守 Supabase 的邮件发送与 OTP 限流。
