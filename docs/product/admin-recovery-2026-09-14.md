# 官网后台恢复记录

时间：2026-09-14（北京时间）。

## 原因

GitHub README 更新提交 65a059bc71c12071f2016c376407de388ed4a134 触发了 Cloudflare 内独立配置的 Git 构建流程。检查 GitHub Actions 的发布文件不足以发现这两条 Cloudflare 自动生产部署。

默认分支仍保留较早的代码：
- 网站自动部署在 00:52:14 将新版覆盖为旧网站。旧资源 index-qlrIsXsh.js 没有后台路由及 AdminView，/admin/overview 只显示公共页头和页脚。
- API 自动部署在 00:51:54 覆盖了当前 0.5.7 管理接口。/health 退回 hellodog-deepseek-v1 且没有当前功能标记。
- 旧的生产检查恰好仍要求旧 API 标记，因此错误版本也能通过旧检查。

这是部署流程漏查导致的回归。

## 已实施修复

1. 恢复网站已验证版本 b2177dec-280d-4a93-ac74-1f5e66d5b201，包含后台和本次官网搜索优化页面。
   恢复部署 4dbe06a2-1e21-43a6-a118-943c80e7005a，01:21:21。
2. 恢复 API 已验证版本 f83a8cab-3a22-4389-a46e-d7492d772cef，恢复当前管理、用量与通知功能。
   恢复部署 2086a37b-52bc-4833-bea3-9f9c4f35f515，01:22:52。
3. 网站和 API 的 main 分支 Git 触发器改为 wrangler versions upload，仅创建候选版本，不切换生产流量。
4. 网站构建限定 website/**，API 构建限定 server/worker/**，排除各自 Markdown 文档变更。仓库首页介绍和生产检查脚本更新不再触发这两条构建。
5. tests/verify-production.mjs 改为校验当前 API 版本与完整功能标记，并检查后台路由、私有页面响应头和后台页面资源是否存在。
6. 新检查脚本已同步 GitHub：09efca69a3843ad92fd6a0bec5da0f07509a7d58。此次提交使用 skip ci 避免构建早期桌面端；脚本已在本机针对正式域名执行通过。
7. 修复后重新检查，网站与 API 的生产版本均保持恢复后的版本，没有等待中的 Cloudflare 构建。

## 当前验证范围

- 正式后台域名根地址、总览、用户管理、客户端通知直达地址，以及官网域名的后台入口。
- 独立浏览器显示真实管理员登录表单，公共页头页脚不再误出现。刷新正常，桌面和手机显示正常，没有应用脚本错误。
- 未登录的后台会话、总览、用户和通知接口均返回 401，允许正式后台域名发起跨域请求。
- 两个 API 域名均返回当前版本和管理功能标记。服务商就绪检查 available，inferenceTested=false，没有执行付费翻译。
- 官网 4 个公开页面、站点地图、规范跳转和 0.5.7 下载/源码入口复核通过。
- 使用的是未登录浏览器，没有代用户登录或操作真实用户余额、通知或密码，也没有执行数据库迁移。本次不声明已逐项操作登录后的真实用户数据。

证据：verification/admin-recovery-2026-09-14/before-http.json、recovery.json、production-check.txt、admin-browser.json、admin-login-desktop.png、admin-login-mobile.png。

## 后续正式发布要求

当前 GitHub main 中的应用源码仍是早期快照。不要恢复该分支的自动生产部署。
先将经过核对的当前网站与 API 源码同步到发布分支，确认没有凭据或无关文件，再构建、验收并显式部署候选版本。
每次涉及仓库更新时同时检查 GitHub Actions 和 Cloudflare Builds 的触发范围。
发布完成后验证官网、独立后台域名和 API，并核对最终部署版本，不能仅以一次页面 200 或旧健康标记作为成功依据。
