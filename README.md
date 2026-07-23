# 隐印 · ID Toolkit

隐印是一个完全在浏览器本地运行的证件图片工具。它支持直接添加用途水印，也可以按需执行自动找角、手动校准和梯形矫正。

图片像素不会上传到服务器。Cloudflare Worker 仅负责分发页面、JavaScript 与 WebAssembly 静态资源。

线上地址：[id.136136136.xyz](https://id.136136136.xyz/)

## 功能

- 默认直接进入水印流程，智能裁剪完全可选
- 自动寻找证件四角，并提供鼠标、触控和键盘手动校准
- 透视矫正后继续使用同一套水印与导出设置
- 最多同时处理 6 张图片，每张图片可独立选择是否矫正
- PNG/JPG 导出，以及 1 MB、500 KB、100 KB 目标体积压缩
- 无服务器图片接口、无统计脚本、无第三方字体或 CDN

自动找角、角点编辑与透视变换基于 MIT 许可的
[scanic](https://github.com/marquaye/scanic)。经典检测引擎与 WebAssembly 都随站点一同打包，不从第三方 CDN 加载。

## 本地开发

```bash
npm install
npm run dev
```

## 验证

```bash
npm run check
npm run test:e2e
```

## 部署

```bash
npm run deploy
```

生产环境使用 Cloudflare Workers Static Assets，并通过 `wrangler.jsonc` 绑定自定义域名。

## 许可证

[MIT](LICENSE)
