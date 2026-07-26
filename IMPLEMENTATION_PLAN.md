# 在线工具箱实施与上线计划

更新时间：2026-07-26

## 目标状态

在原有 Cloudflare Worker 上原地扩展，由一个 Worker 同时承载工具页面、剪贴板 API、Durable Object 与 R2 文件访问。

| 产品入口 | 地址 |
| --- | --- |
| 工具集合 | `https://tools.136136136.xyz/` |
| 证件图片 | `https://tools.136136136.xyz/id-photo/` |
| 云剪贴板 | `https://tools.136136136.xyz/clipboard/` |
| 短房间 | `https://c.136136136.xyz/<房间名>` |
| 剪贴板 API | `/api/share/...` |
| 旧证件图片入口 | `https://id.136136136.xyz/`，暂时 `307` 到 `/id-photo/` |

工具继续使用一级路径而非 `.html` 后缀；剪贴板另设短域名，让可记忆的房间名真正形成短链接。

## 架构决策

| 层 | 选择 | 原因 |
| --- | --- | --- |
| 页面与 API | 单个 Cloudflare Worker | 保留原 Worker，统一版本、域名和部署 |
| 静态页面 | Vite 多页面构建 + Workers Static Assets | 原证件图片代码保持独立入口 |
| 房间状态 | 每房间一个 SQLite Durable Object | 强一致、revision 冲突控制、精确 TTL alarm |
| 文件 | 私有 R2 bucket | 文件不暴露公共 bucket URL，可随房间批量删除 |
| 便捷模式 | TLS 传输、服务端临时保存原文 | 适合普通内容，交换步骤最少 |
| 隐私模式 | PBKDF2 派生 + 浏览器 AES-256-GCM | 密码与内容密钥不发送给服务端 |
| 权限 | 房主令牌、协作令牌分离 | 协作者可编辑，但只有房主能销毁房间 |
| 同步 | 2.5 秒轮询 | 先控制复杂度；未来可升级 WebSocket Hibernation |

## 已完成

### 工具集合第一版

- [x] 原证件图片工具迁移到 `/id-photo/`，保留全部本地处理能力。
- [x] 新增工具集合首页与 `/clipboard/` 动态页面。
- [x] 新增 Durable Object 房间状态、revision、配额与到期 alarm。
- [x] 新增私有 R2 上传、下载、删除和失败回滚。
- [x] 新增旧证件域名迁移和主工具域名路由。

### 剪贴板第二版

- [x] 新增 `c.136136136.xyz/<房间名>` 短链接，并保留旧随机 ID 链接兼容。
- [x] 房间名支持 3–16 个 Unicode 字母/数字及 `_`、`-`，并阻止保留路径冲突。
- [x] 新增便捷与隐私双模式；页面明确展示服务端可见性差异。
- [x] 隐私模式使用 PBKDF2-HMAC-SHA256 600,000 次迭代派生 AES 密钥和协作令牌。
- [x] 隐私模式默认生成可复制、可编辑的 约 100 bit 随机强度分组密码，并在当前标签页保留复制入口。
- [x] 新增 5、15、30 分钟及 1、3、6、12、24 小时选项，并支持 5–1440 分钟自定义。
- [x] 房主令牌与协作令牌分离，分享链接不包含房主权限。
- [x] 新增房主主动销毁；协作者不能销毁整个房间。
- [x] 到期时间固定，不因读取、编辑或上传续期。
- [x] 房间清理同时删除 Durable Object 状态与关联 R2 文件。
- [x] 补充单元、桌面与移动端端到端测试及旧链接回归测试。

## 数据生命周期

```text
创建房间
  ├─ 固定 expiresAt，并注册 Durable Object alarm
  ├─ 活动期间：文字保存在 DO，文件保存在私有 R2
  ├─ 房主主动销毁 ─────────────┐
  ├─ 到期 alarm ───────────────┼─ 删除所有 R2 对象、DO 状态与 alarm
  └─ 到期后的任意访问 ─────────┘

R2 2 天生命周期：兜底处理 alarm 或回滚异常留下的孤立文件
```

清理只影响服务端副本，无法撤回已被访问者下载或复制到其他设备的数据。R2 生命周期规则作用于专用 bucket 的所有完成对象。

## 部署前验证

```bash
npm install
npm run check
npm run test:e2e
npx wrangler deploy --dry-run
```

本地 Worker 集成测试还应覆盖：

- 便捷房间匿名协作写入、文件上传下载与房主销毁；
- 隐私房间的密文文件往返、协作者无法销毁、房主可销毁；
- 短域名根路径和自定义房间路径均返回剪贴板页面；
- 销毁后的房间 GET 返回 `404` 或 `410`。

## 生产部署步骤

1. 确认 `tools`、`id`、`c` 三个自定义域名位于当前 Cloudflare 账户，且未被其他 Worker 占用。
2. 确认私有 bucket `online-toolkit-share-files` 已存在且未开启 `r2.dev` 公网访问。
3. 添加并核对 R2 兜底规则：

   ```bash
   npx wrangler r2 bucket lifecycle add online-toolkit-share-files toolkit-expire-fallback --expire-days 2
   npx wrangler r2 bucket lifecycle list online-toolkit-share-files
   ```

4. 部署原 Worker：

   ```bash
   npm run deploy
   ```

5. 进行生产冒烟检查：

   - 三个域名及对应页面可访问；
   - 创建 5 分钟的便捷房间，验证短链接、匿名协作、原始文件字节和房主销毁；
   - 创建 5 分钟的隐私房间，验证错误密码、正确解锁、密文存储、协作者不能销毁；
   - 房间销毁后文字和文件接口不再可访问；
   - 旧随机 ID + fragment 密钥链接仍能打开；
   - `id.136136136.xyz/` 返回 `307` 并落到新证件图片入口。

## 上线后观察

- Worker 错误率、Durable Object 请求、alarm 失败、R2 A/B 类操作与存储增长。
- 日志不得记录正文、密码、完整令牌、完整文件名或 URL fragment。
- 若公开推广，先增加 Turnstile、Rate Limiting binding 与 WAF 规则。
- 稳定 7–14 天后，将旧证件域名的 `307` 改成永久 `308`；旧域名至少保留 30 天。

## 后续阶段

1. WebSocket Hibernation：替代轮询，实现实时同步和断线恢复。
2. Turnstile 与速率限制：保护建房间、保存和上传接口。
3. 非内容指标：房间数、字节数、错误码和清理结果。
4. 仅在确认大文件需求后，引入 R2 multipart 或受约束的短时上传 URL。
5. 如需运营支持，再设计不可枚举、可审计的管理员销毁通道；不提供公开房间列表。

## 回退原则

- 页面或 API 出现严重问题时，优先回退到部署前保留的 Worker version。
- 不删除已经应用的 Durable Object migration；回退版本至少保留到期清理能力，避免 R2 残留。
- 若仅短域名异常，可先移除 `c.136136136.xyz` Custom Domain，完整入口仍可通过主工具域名使用。
- 若仅工具主域名异常，可暂时保留旧证件域名恢复原工具服务。
- 不直接删除 R2 bucket；确认活动房间均过期且对象已清理后再处理资源。