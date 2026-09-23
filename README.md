# AnimeShelf 桌面预览版

本地动漫／影视媒体库管理器，使用现有 React、Vite、Express、SQLite WASM 和 Electron 技术栈。本候选仅面向 Windows 桌面源码与便携版，不包含 AI 工作台、AI 服务、找番、手机应用及桌面侧手机配对／同步功能。

外观分组包含显示与壁纸设置；视频壁纸失焦后暂停并保留最后一帧，返回后自动继续。请使用独立数据目录；本版会拒绝带手机同步结构的数据库及备份，保留原文件供完整版使用。

本仓库提供 Windows 桌面预览版源码，本次未发布新的 Windows 可执行文件。项目代码采用 [MIT 许可证](LICENSE)，版权署名为 Copyright (c) 2026 Rena。第三方依赖、素材与数据仍遵循各自的许可和使用条件，不因项目采用 MIT 而改变。

## 保留功能

- 媒体库、文件夹／文件详情、普通元数据匹配与人工分类。
- 合集、追番／心愿单、下载资源列表、排序／分页与合集筛选。
- 壁纸、备份和可选的本机外部 API。
- 内置 Bangumi.moe、ACG.RIP、动漫花园和 Nyaa 四个下载来源，无需填写站点地址。进入下载页即加载已选来源，关键词为空时显示最新发布；不提供登录、Cookie 或验证绕过功能。

## Windows 便携版

将新构建的便携 EXE 放入可写目录后运行。无需安装 Node.js、pnpm 或开发工具。
首次启动创建同目录的 `data/`；不要将已有 `data/`、海报、备份或设置随程序分发。
`ANIMESHELF_DATA_DIR` 可显式指定数据目录。退出后再移动程序／数据；升级前保留备份。

浏览器会话／缓存仍使用 Electron 的 Windows 用户配置目录；服务登记文件默认保存在 `%LOCALAPPDATA%/AnimeShelf/run/`。因此这里的“便携版”指免安装启动，并非绝不写入用户配置目录。系统须提供 Windows 自带的 PowerShell（数据库占用检测、进程识别和本机服务登记权限使用），不需要额外安装开发工具。

程序未签名，不能将 Windows 安全提示与已签名发布混同。Everything HTTP Server 是扫描可选配置的外部依赖，不随程序提供；没有它时不应据此认定已有库、详情和其他保留功能不可用。

## 从源码开发

权威依赖版本由 `pnpm-lock.yaml` 锁定。不要生成／混用 npm 锁文件，也不要顺手升级依赖。

使用 Node.js 22 与 `package.json` 指定的 pnpm：
```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

默认开发界面为本机 5173，API 为 3002；若被占用，以启动器显示的实际地址为准。

## 验证与构建

```powershell
pnpm modules:generate
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec tsc --noEmit -p tsconfig.server.json
pnpm exec vitest run modules/download server/services/__tests__/download-source-settings.test.ts
node node_modules/electron/install.js
pnpm build:electron
```

Electron 安装脚本下载并按包内校验值核对锁定 runtime，不改变锁文件。构建重新生成模块注册表、前端、后端和第三方清单，再创建未签名 Windows 便携包。输出位于 `release/`；不得将工作目录整体压缩分发。新候选不复用旧 EXE，不构建 APK。

模块由 `modules/*/manifest.json` 自动发现。公开候选只含六个桌面模块；旧数据库中的额外模块开关不能恢复未包含的功能。旧任务／设置／凭据不作删除，但其执行入口已排除，敏感字段继续脱敏。

## 文档与权利说明

- [项目许可证（MIT）](LICENSE)
- [操作说明](docs/USER-GUIDE.md)
- [下载来源接口](docs/download-sources-api.md)
- [外部 API](docs/external-api.md)
- [隐私与数据流](docs/PRIVACY.md)
- [第三方依赖与服务条款](docs/THIRD-PARTY.md)
- [素材来源台账](docs/ASSET-PROVENANCE.md)
- [模块开发](docs/modules.md)
- [第三方声明](THIRD-PARTY-NOTICES.txt)

数据源包含 bangumi-data（CC BY 4.0）、Bangumi、AniList 和 TMDB。应用署名不代表数据提供方背书，也不授予海报或影视作品的再分发权。保留的 API、下载站使用条件及图标来源仍有未决项，详见第三方及素材台账。源码公开不表示这些事项已经解决；内置适配器或其他社区项目的实现不替代网站许可。
