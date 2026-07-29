# 在线工具箱 · Online Toolkit

这是一个部署在 Cloudflare Workers 上的在线工具集合。目前包含：

- **证件图片**：智能裁剪、透视矫正、用途水印与图片压缩；图片像素全部留在浏览器本地。
- **云剪贴板**：用短房间名跨设备传送文字和文件；可按内容敏感程度选择便捷模式或端到端加密的隐私模式。
- **图片隐私清理**：本地读取图片元数据、生成干净副本，并在允许下载前重新检查副本。
- **二维码隐私工具**：本地识别图片或摄像头中的二维码、提示网址风险，也可在本地生成二维码。

详细的架构决策、验收与回退方案见 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)。

## 生产入口

| 地址 | 用途 |
| --- | --- |
| `https://tools.136136136.xyz/` | 工具集合首页 |
| `https://tools.136136136.xyz/id-photo/` | 证件图片工具 |
| `https://tools.136136136.xyz/clipboard/` | 云剪贴板完整入口与房主控制页 |
| `https://tools.136136136.xyz/image-privacy/` | 图片隐私检查、清理与复检 |
| `https://tools.136136136.xyz/qr/` | 二维码识别、风险检查与生成 |
| `https://c.136136136.xyz/` | 云剪贴板短域名入口 |
| `https://c.136136136.xyz/<房间名>` | 可记忆的房间分享链接 |
| `https://id.136136136.xyz/` | 旧证件图片域名，临时 `307` 到新入口 |

工具页面使用干净路径而不是 `.html` 后缀。以后新增工具时继续在主域名下增加一级路径；`c` 子域名只服务剪贴板短链接。

## 架构

```text
浏览器
  └─ 同一个 Cloudflare Worker
      ├─ Static Assets：工具首页、证件图片、图片隐私、二维码、剪贴板前端
      ├─ API 路由：/api/share/...
      ├─ Durable Object：每个房间的状态、权限、版本与到期 alarm
      └─ 私有 R2：隐私模式的密文字节或便捷模式的原始文件字节
```

剪贴板不使用 KV 或 D1。每个房间映射到独立的 SQLite Durable Object，以获得强一致更新、revision 冲突检测和精确到期 alarm；R2 bucket 保持私有，只能经 Worker 访问。前端目前每 2.5 秒同步一次。

## 本地隐私工具

图片隐私清理目前只接受 JPG、PNG、WebP。浏览器先用 ExifReader 读取位置、身份、设备、时间和内容字段，再通过 Canvas 重新编码为新文件，最后重新读取导出结果。只有复检不再发现这些隐私字段时，页面才会显示“复检通过”并允许下载。HEIC、RAW、PDF 和动图暂不支持，以免给出不可靠的“已清理”结论。

二维码工具不会自动打开识别结果。图片识别和摄像头帧都留在浏览器；相机只在用户点击后申请权限，识别完成或离开页面即停止。网址检查会提示危险协议、HTTP、账号信息、IP、Punycode、常见短网址、敏感参数和常见跟踪参数，但这些提示不能替代对目标网站本身的判断。

## 两种剪贴板模式

| | 便捷模式 | 隐私模式 |
| --- | --- | --- |
| 适合 | 普通、短时、追求少一步操作的内容 | 密码、证件、工作资料等敏感内容 |
| 分享方式 | 短链接 | 短链接，并通过另一可信渠道告知密码 |
| 服务端保存 | 可读取的文字、文件与元数据 | AES-256-GCM 密文；服务端不知道密码和内容密钥 |
| 协作开关 | 打开后，拿到链接的人都可编辑 | 打开后，拿到链接和密码的人可编辑 |
| 未打开协作 | 访客只读，房主可编辑 | 访客解密后只读，房主可编辑 |
| 房间销毁 | 只有房主可以执行 | 只有房主可以执行 |

隐私模式使用随机盐和 PBKDF2-HMAC-SHA256（600,000 次迭代）从密码派生独立的 AES 密钥与协作令牌。密码、内容密钥和房主令牌都不会发送到 Worker；Worker 只保存 KDF 参数、加密校验值和令牌哈希。

旧版随机房间 ID 与 `#key=...` 分享链接继续兼容，已有链接不会因短房间改造失效。

## 房间名、有效期与销毁

- 房间名支持 3–16 个 Unicode 字母或数字，也可使用 `_`、`-`；创建前会标准化并转为小写。
- 页面会推荐一个 8 位随机短名，也可以自己填写容易记忆的名字。已被占用的名字会返回冲突提示。
- 打开一个不存在的有效短房间名时，页面会询问是否用该名称创建；确认后默认创建无需密码、1 小时后销毁的便捷房间。
- 隐私模式会默认生成一个 约 100 bit 随机强度、去除易混字符的分组密码；可以重新生成、复制，也可以直接改成自己的密码。
- 短房间名可被猜测或枚举，**不能当作密码**；敏感内容应使用隐私模式和强密码。
- 有效期可选 5、15、30 分钟，1、3、6、12、24 小时，也可自定义 5–1440 分钟。
- 到期时间从创建时固定计算。读取、编辑或上传不会自动续期。
- 房主页面保存独立的房主令牌，可随时点击“销毁房间”。协作者即使能编辑，也不能销毁整个房间。
- 房主令牌保存在当前标签页 `sessionStorage` 中，普通分享链接不包含该令牌。房主可以复制专用管理链接，在可信终端恢复房主权限并销毁房间。
- 管理链接的 URL fragment 包含房主令牌；持有者拥有销毁权限，必须与普通房间链接分开保管。若原标签页和管理链接都丢失，只能等待房间自动到期。

## 文件是否会自动销毁

会。服务端采用三层清理：

1. Durable Object 到期 alarm 删除房间状态及它记录的所有 R2 文件；
2. 任何到期后的访问也会触发同样的清理；
3. R2 bucket 配置 2 天生命周期，兜底删除 alarm 或上传回滚失败留下的孤立对象。

到期或主动销毁后，接口立即不再提供房间和文件。R2 生命周期是兜底机制，物理删除可能晚于房间不可访问的时间。已经下载到其他设备的副本无法远程撤回，因此这仍是临时中转服务，不是数字版权管理或永久网盘。

## 默认限制

- 文本请求体最多 64 KiB（界面限制 20,000 个字符）
- 单个原始文件约 25 MiB
- 每个房间最多 10 个文件，合计约 100 MiB
- 房间有效期 5 分钟至 24 小时，默认 1 小时
- 只读访问不会延长到期时间

服务端限制位于 `wrangler.jsonc` 的 `vars`，前端上限也应同步修改。

## 本地开发与验证

```bash
npm install
npm run dev
```

连同本地 Durable Object 与 R2 模拟一起运行：

```bash
npm run dev:worker
```

完整检查：

```bash
npm run check
npm run test:e2e
npx wrangler deploy --dry-run
```

## 首次部署

先登录 Cloudflare，并在目标账户创建私有 R2 bucket：

```bash
npx wrangler login
npx wrangler r2 bucket create online-toolkit-share-files
```

为孤立文件添加 2 天生命周期兜底：

```bash
npx wrangler r2 bucket lifecycle add online-toolkit-share-files toolkit-expire-fallback --expire-days 2
```

随后部署同一个 Worker：

```bash
npm run deploy
```

`wrangler.jsonc` 会创建 `ShareRoom` 的 SQLite Durable Object migration，并将 `id-toolkit` Worker 绑定到 `tools.136136136.xyz`、`id.136136136.xyz` 和 `c.136136136.xyz` 三个自定义域名。部署前需确保这些域名位于当前 Cloudflare 账户且没有被其他 Worker 占用。

GitHub 仓库已改名为 `SchweppesSoda/online-toolkit`。`id-toolkit` 现在只保留为 Cloudflare 现网 Worker 的内部名称：直接修改 `wrangler.jsonc` 的 `name` 会创建或切换到另一个 Worker，并可能拆散现有 Durable Object 与路由。若将来需要连内部名称一起迁移，应单独安排停机与数据迁移，不与普通前端改版混在一起。

## 后续加固

当前版本已实现自定义房间名、独立房主权限、哈希令牌、可选端到端加密、房间配额、版本冲突检测、主动销毁、alarm 到期清理和 R2 生命周期兜底。公开推广前仍建议加入：

- Turnstile 创建/上传校验
- Worker Rate Limiting binding 与 WAF 规则
- Durable Object WebSocket Hibernation 实时推送
- 不含正文、密码、完整令牌或完整文件名的运行指标

## 第三方代码与上游跟进

图片元数据读取使用 [ExifReader](https://github.com/mattiasw/ExifReader)；二维码识别使用 [qr-scanner](https://github.com/nimiq/qr-scanner)；二维码生成使用 [node-qrcode](https://github.com/soldair/node-qrcode)。依赖均固定到精确版本，生产页面不从公共 CDN 加载。

作者、固定版本、许可证副本、设计参考与更新步骤见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。页面源码的导入位置也保留了对应的上游地址和许可证说明。

## 许可证

本项目自己的代码采用 [MIT](LICENSE)；第三方组件按各自许可证使用。
