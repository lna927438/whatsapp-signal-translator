# Realtime Translator Website

官网与管理后台已部署到 Cloudflare，和 Windows 客户端共用 Supabase 在线账号、Cloudflare API 与 R2 安装包分发。

- 官网：https://hellodog.net
- 管理后台：https://admin.hellodog.net/admin
- 下载：https://hellodog.net/download
- 用户管理、字符添加和实际用量统计已启用，套餐与支付暂未开放。

## 本地运行

```bash
cd website
npm install
cp .env.example .env
npm run dev
```

## 环境变量

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_DOWNLOAD_BASE_URL`

## 当前页面

- `/` 产品首页
- `/login` 登录 / 注册
- `/account` 云端用户中心
- `/download` Windows 正式版与 Mac Apple 芯片公开验收版下载中心
- `/guide` 安装、翻译、历史与字符用量指南
- `/updates` 已发布版本的更新记录
- `/admin` 管理后台（权限由管理 API 校验）

## 管理后台本地验收

在项目根目录运行 `scripts/start-admin-preview.ps1`，打开 `http://127.0.0.1:5184/admin`。
该入口使用持久化样例数据库，不连接生产账号。真实数据本机备用入口由 `scripts/start-admin-live.ps1` 启动，地址为 `http://127.0.0.1:5174/admin`。
数据统计与权限说明见 `../docs/product/admin-live-v1.md`。

## 部署建议

2026-09-14 修复了遗留 Git 自动构建覆盖新版网站和 API 的问题。目前 Cloudflare Git 构建只生成候选版本，正式发布使用已验证版本的显式部署；不要从 GitHub 的旧 main 分支直接自动上线。恢复记录与验收见 `../docs/product/admin-recovery-2026-09-14.md`。

当前使用 Workers Static Assets，Worker 名为 `realtime-translator-web`；下载文件位于 R2 的 `translator-releases` 桶，公开域名为 `download.hellodog.net`。

生产构建会读取项目根目录与 website 目录中的公开 VITE 配置，仅显式传入 Supabase URL、公布密钥和 API 地址。缺少登录配置时构建失败。服务端密钥不能放进 VITE 配置。

`worker.mjs` 提供后台域名跳转、www 规范跳转、页面缓存与安全响应头。生产版本没有样例身份登录，服务端继续校验唯一管理员。

## 品牌搜索与公开页面

公开页在生产构建时预渲染为独立 HTML；`src/seo.ts` 的 `publicPages` 同时生成站点地图。登录、用户中心和后台继续排除索引，未知地址返回 404。

新增公开页时同步前端路由、SSR 路由、Worker 的 `publicFiles` 和别名，并运行 `node --test tests/seo-routes.test.mjs`。先完成生产构建再启动本地 Worker，避免开发服务器在构建清空目录时保留过时资源清单。

上线证据、Search Console 的后续操作及 GitHub 介绍维护方式见 `../docs/product/seo-brand-2026-09-14.md`。
