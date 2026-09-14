# HelloDog 0.5.2 正式发布记录

用户于 2026-09-12（GMT+8）授权正式上线；套餐价格与支付继续暂缓。

## 公开入口

- 官网：https://hellodog.net
- 后台：https://admin.hellodog.net/admin
- 下载：https://hellodog.net/download
- API：https://api.hellodog.net
- `www.hellodog.net` 保留路径跳转至官网；后台根路径跳转至 `/admin`。

唯一主管理员为用户指定的现有账号，密码未被重置。公开登录页不预填管理员邮箱。用户列表、字符添加、翻译记录、Tokens 与美元成本使用客户端同一云端数据库。套餐与支付未开放。

## 安装包与源码

- 版本：0.5.2，Windows x64，未做代码签名。
- 安装包：`windows/v0.5.2/HelloDog-Setup-v0.5.2.exe`
- 字节数：402350697
- SHA-256：`ee6ad2b2ad4b2838e768645e9ad44dc7671307dc7c4cf2a7031940a7c9a265ef`
- 对应源码：`sources/v0.5.2/HelloDog-0.5.2-corresponding-source.zip`
- 源码字节数：51984278
- 源码 SHA-256：`7341295ad4654652f0b9710af342e09c1885936590dda9ad705cb1c10682a1eb`

源码包含实际修改后的 Signal Desktop v8.27.0、HelloDog 集成与构建说明；不含账号目录、凭据、聊天记录或内部运维笔记。Signal 和 signal-cli 的原许可及版权信息保留。构建来自当前工作区，未把旧 Git 提交编号冒充本次构建的源代码版本。

## 验证

- 全量回归 225 项通过；用量接口补充语言方向后，相关 25 项再次通过。
- Windows 安装包的主程序、预加载程序、原生窗口助手、Signal 核心及对应源码比对通过。
- 打包后的 0.5.2 正常启动，使用单独验收目录，页面无脚本错误。
- 本地和公开网站的首页、下载、登录跳转、后台与 390px 窄屏检查通过。
- 官网、独立后台、www 跳转与 HTTPS 通过；未登录管理接口返回 401，后台来源预检 204，非允许来源 403。
- 从公开下载地址完整读取安装包及源码，实际 SHA-256 和文件长度均与本地一致；两者均支持 HTTP Range 续传。
- 真实数据库复查仍只有一个管理员。新 Token 用量表在本轮上线核查时仍为 0 行，没有伪造真实翻译消费。

证据目录：`verification/launch`。正式下载元数据与固定安装包入口均已切换至 0.5.2；真实数据库版本记录启用，未强制更新，发布操作已进入管理员审计（`e1eaf6c2-42b8-4d56-a584-b631552e7a0f`）。

临时上传 Worker `hellodog-release-upload-20260912` 已删除，本地临时上传凭据与资产上传令牌已清除。仅关闭本次启动的本地验收服务，原管理后台备用入口保留。

下载验收发现默认浏览器缓存会把固定下载链接保留 4 小时，已增加只匹配 `download.hellodog.net/metadata/` 与 `/windows/latest/` 的缓存规则，避免继续获得旧版本。公开响应确认 `Cache-Control: no-cache`；带版本号的文件继续使用一年不可变缓存。规则集 `332617531e584962ad34ae6fa10c23e6`，规则 `34c4d814a7d9421eb8db8dbe7b1b0cf3`。只清除了版本元数据和固定下载链接的旧 CDN 缓存。

## 尚未完成的实机验收

Signal 通话、真实联系人媒体双向送达及所有网络/休眠/输入法组合没有全部独立验收。富文本及编辑消息暂不自动翻译。管理员本人登录、修改密码和首条真实 Token 回执未代用户操作。以上不以构建和自动化测试代替，官网已说明相关客户端限制。

## 回退

官网当前 Worker 版本：`c3bfabaa-9e4f-4e56-bda0-227bed9e2ba6`；部署：`fbf3bf7d-ccb1-4156-aa8b-0226667661f4`。

API 当前 Worker 版本：`d0ce3f71-f64d-42c9-bf6b-4f1d9d6ad4c6`；部署：`2f09eea0-6b5f-4fb8-8d7f-1d4baa83438a`。

本次之前的官网版本 `7aaf9ca6-31aa-4edc-b130-2ad461c23665`，API 版本 `6c125bce-a276-44c0-bb92-98d02b07076f`。原生产安装包 v0.5.1 和其版本路径继续保留；旧下载元数据备份为 `verification/launch/previous-version.json`。发生回退时恢复相应 Worker 版本和下载指针，不删除用户账本、翻译任务或聊天数据。
