# Realtime Translator Website

官网 v1，和 Windows 客户端共用 Supabase 在线账号、Cloudflare API 与 R2 安装包分发。

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
- `/download` Windows 下载中心

## 部署建议

Cloudflare Pages / Workers Static Assets 均可。生产环境建议将 R2 绑定自定义下载域名后，把 `VITE_DOWNLOAD_BASE_URL` 从 `r2.dev` 切换到正式域名。
