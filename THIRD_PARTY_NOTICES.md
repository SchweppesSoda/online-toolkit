# 第三方代码与设计参考

本项目自己的代码采用 [MIT](LICENSE) 许可证。下列组件仍归各自作者所有，并按各自许可证使用。生产构建从本仓库锁定的 npm 版本打包，不从公共 CDN 加载。

## 直接使用的开源组件

| 功能 | 组件与固定版本 | 作者 / 维护者 | 上游源码 | 许可证 | 本地许可证副本 |
| --- | --- | --- | --- | --- | --- |
| 图片元数据读取与清理后复检 | `exifreader@4.41.3` | Mattias Wallander 及贡献者 | [mattiasw/ExifReader](https://github.com/mattiasw/ExifReader) | MPL-2.0 | [LICENSES/ExifReader-MPL-2.0.txt](LICENSES/ExifReader-MPL-2.0.txt) |
| 二维码图片与摄像头识别 | `qr-scanner@1.4.2` | Nimiq 及贡献者 | [nimiq/qr-scanner](https://github.com/nimiq/qr-scanner) | MIT | [LICENSES/qr-scanner-MIT.txt](LICENSES/qr-scanner-MIT.txt) |
| 二维码生成 | `qrcode@1.5.4` | Ryan Day、Vincenzo Greco、Linus Unnebäck 及贡献者 | [soldair/node-qrcode](https://github.com/soldair/node-qrcode) | MIT | [LICENSES/node-qrcode-MIT.txt](LICENSES/node-qrcode-MIT.txt) |

这些组件以未修改的 npm 依赖形式使用。页面交互、风险提示、图片重编码与清理后复检流程由本项目实现；这不改变上游组件的版权或许可证。

## 仅作设计参考

- [szTheory/exifcleaner](https://github.com/szTheory/exifcleaner)（MIT）：参考了“先查看、另存干净副本、再比较结果”的产品思路。没有复制其 Electron/ExifTool 实现代码。
- [TransparentLC/cloud-clipboard](https://github.com/TransparentLC/cloud-clipboard)：早期云剪贴板功能的产品与架构调研来源之一；本项目的 Worker、Durable Object、R2、短房间和浏览器加密实现为独立代码。
- [webnote.cc](https://webnote.cc/)：早期短房间名交互的产品参考，不是代码来源。

## 跟进上游更新

当前核对日期：2026-07-26。

1. 运行 `npm outdated exifreader qr-scanner qrcode` 查看是否有新版本。
2. 打开上游 Release / Changelog，检查 API、浏览器兼容性、安全修复和许可证是否变化。
3. 使用精确版本更新，例如 `npm install --save-exact exifreader@<版本>`，不要改为浮动版本。
4. 同步本文件中的版本与许可证副本，运行 `npm run check` 和 `npm run test:e2e`。
5. 对图片工具重新验证“导出后再读取”的结果；对二维码工具重新验证摄像头权限、图片识别和危险链接不会自动打开。

如果未来修改了这些组件的源码，而不是原样打包依赖，应在此处明确记录修改文件、补丁来源和许可证义务。