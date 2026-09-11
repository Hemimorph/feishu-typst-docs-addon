# 飞书 Typst 预览小组件

一个企业自建的飞书云文档正文小组件：在模态窗口中编辑 Typst，并在正文中展示实时排版结果。Typst WASM 与基础字体在运行时从可配置的 npm CDN 镜像加载；用户字体支持组件内嵌、远程 HTTPS URL 和 Nix store outPath，图片还可以尝试读取当前飞书文档中的图片块。

## 开发环境

- Node.js 18（飞书当前文档建议不高于 18.20.8）
- `@lark-opdev/cli` 3.3.0 或更高版本
- 一个已开启“云文档小组件”能力的企业自建应用

```bash
npm install
npm run typecheck
npm test
npm run build
```

构建时可通过环境变量指定 npm CDN 镜像基址：

```bash
TYPST_RESOURCE_MIRROR=https://cdn.example.com/npm npm run build
TYPST_RESOURCE_MIRROR=https://cdn.example.com/npm npm run upload
```

标准 NPM Registry 只提供完整 `.tgz`，不能像文件 CDN 一样读取包内路径。此时同时指定镜像模式，插件会下载、缓存并在浏览器中解包：

```bash
TYPST_RESOURCE_MIRROR=https://artifacts.example.com/repository/typst \
TYPST_RESOURCE_MIRROR_MODE=npm-registry \
npm run build
```

这两个值会固化进分发包，不会写入组件 Record，也不会开放给文档编辑者修改。镜像必须使用 HTTPS，并允许飞书小组件来源进行跨域 GET。默认模式是 `npm-cdn`，要求能以 `<镜像基址>/<包>@<版本>/<文件>` 读取包内单个文件；`npm-registry` 模式则使用标准 npm tarball 路径。基址可以带固定路径前缀。

## 飞书配置

1. 在 `app.json` 中把 `cli_replace_me` 和 `blk_replace_me` 替换为开发者后台中的 App ID 与 Block Type ID。
2. 在开发者后台申请云文档小组件所需的“创建及编辑新版文档”和“查看新版文档”权限。
3. 在“安全设置 → 服务器域名白名单”中加入 Typst 资源镜像域名。默认基址是 `https://cdn.jsdelivr.net/npm`；如在构建时指定自定义镜像，则加入自定义域名。
4. 如果要使用 Nix outPath 字体，在白名单中加入 `cache.nixos.org`。该域名固定使用 NixOS 官方 binary cache，不提供运行时镜像配置。
5. 如果要使用其他域名的远程字体或图片，也要加入对应域名；所有资源服务器都必须允许小组件来源进行跨域 GET。
6. 执行 `npm start`，按照开发者工具输出在测试文档中插入小组件。
7. 验证完成后执行 `npm run upload`。

## 使用方法

- 点击正文 Typst 块右上角的“编辑”。
- 点击“下载 PDF”会使用当前保存的源码、字体和图片资源生成 PDF，并以飞书文档标题命名。
- 源码编辑后会自动刷新右侧预览，点击“保存”把源码和资源清单写入小组件 Record。
- 字体区域每行填写一个 HTTPS 字体资源，或形如 `/nix/store/<32 位哈希>-<名称>` 的 outPath，再点“应用到预览”。URL 支持单个 TTF、OTF、TTC、WOFF 以及 ZIP、tar.gz/tgz 字体包；outPath 会在浏览器中从 `cache.nixos.org` 获取 narinfo 和 NAR，校验下载与解压后的 SHA-256，再递归扫描字体；如果字体是指向其他 store path 的符号链接，也会按需下载、校验并解析链接目标。也可以上传字体并嵌入组件。Typst 源码应使用字体文件内部的 family name。
- 默认远程字体包含 `Noto Serif SC`、`Libertinus Serif`、`New Computer Modern`、`New Computer Modern Math` 和 `DejaVu Sans Mono`；字体包版本固定，不会跟随镜像的 latest 标签漂移。
- 远程图片需要填写 URL 和它在 Typst 中使用的相对路径。
- 点击“扫描当前文档图片”可以把已有飞书图片块加入资源清单。
- 图片加入后点击“插入代码”，或手工使用 `#image("assets/文件名.png")`。
- 每个图片资源必须使用唯一的 `assets/` 相对路径；路径可以分目录，但不能包含空段、`.` 或 `..`。
- 多页预览会为每张纸添加间距和阴影。`#set page(height: auto)` 表示连续长页；需要分页时请使用 `paper: "a4"`、固定高度或 `#pagebreak()`。
- 正文块使用 `resizeType: "none"` 和 `Bridge.updateHeight` 跟随完整预览高度。旧版创建的可拖拽高度块会在有编辑权限的用户打开时自动迁移，避免飞书把评论栏插到第一页之后。

## 数据与限制

- 源码、资源 URL、Nix outPath、飞书图片块引用及用户选择嵌入的字体/图片保存在当前小组件的 Record 中。NAR 本身不会写入 Record；构建时镜像基址、远程 WASM 和基础字体也不占用 Record 配额。
- 预览或导出 PDF 首次初始化时会从构建时指定的 npm 镜像读取固定版本的 Typst WASM 和基础字体，不再依赖 GitHub 文件代理。下载成功的运行时资源会写入版本化的 Cache Storage；后续重新打开组件优先复用本地缓存。
- Cache Storage 仅是可丢弃的运行时缓存，不写入组件 Record。浏览器禁用存储、隐私模式、空间不足、缓存被清理或内容校验失败时，组件会自动回退到网络；损坏缓存会被删除并从镜像重试一次。
- 飞书图片块被删除或访问权限丢失后，对应 Typst 资源会加载失败，需要重新关联。
- 远程资源的稳定性由资源服务器、飞书 CSP 白名单和 CORS 配置决定。
- Nix outPath 必须已存在于 NixOS 官方 binary cache；运行时不会调用 Hydra、执行 Nix eval 或按属性名解析包。当前支持官方缓存常用的 Zstandard NAR，以及未压缩和 gzip NAR；旧的 bzip2/xz 条目会显示不支持的压缩格式。
- 当前版本是单文件 Typst 工程，不包含 Universe 包管理和多文件源码编辑器。
- 不要把 `app.json` 的正文 `resizeType` 改回 `vertical`；该模式需要 `Bridge.updateResize`，不能依赖 `Bridge.updateHeight` 自动包住多页内容。
