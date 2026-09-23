# AnimeShelf 开发与构建

[返回项目介绍](../README.md) · [使用指南](USER-GUIDE.md)

本文面向从源码运行、开发或自行构建 Windows 程序的读者。日常媒体库操作请参阅使用指南。

## 环境与技术栈

- Windows，保留系统自带的 PowerShell；启动器、进程识别和数据库占用检查会使用它。
- Node.js 22，pnpm 11.7.0（版本见 `package.json` 的 `packageManager`）。
- 前端使用 React、TypeScript、Vite 和 Tailwind CSS；后端使用 Express 与 SQLite WASM；桌面窗口使用 Electron。

依赖的准确版本以 `pnpm-lock.yaml` 为准。使用 pnpm 安装并保留锁文件，不混用 npm 锁文件。

## 从源码运行

下载仓库源码并解压，或克隆仓库。在项目根目录执行：

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

启动器同时启动界面和本机后端，在终端输出可访问的地址。默认界面地址是 `http://127.0.0.1:5173`，后端端口为 `3002`；端口被占用时可能改用其他空闲端口，以实际输出为准。保持终端运行，在浏览器打开界面；结束使用时按 `Ctrl+C` 停止服务。

源码运行默认使用项目下的 `data/`。可在启动前设置 `ANIMESHELF_DATA_DIR` 指向其他目录。首次尝试不同版本时使用独立目录，不要拿唯一一份媒体库数据做开发或恢复测试。数据库兼容与迁移前备份要求见[使用指南](USER-GUIDE.md)。

例如，在同一个 PowerShell 终端中指定新的数据目录后启动：

```powershell
$env:ANIMESHELF_DATA_DIR = 'D:\AnimeShelfData'
pnpm dev
```

便携程序也读取这个环境变量；需在同一终端中设置后启动 EXE。请使用自己选择的可写位置，不要让不同版本同时使用同一数据目录。

`--ignore-scripts` 不安装 Electron runtime；浏览器方式运行不需要该 runtime。需要 Electron 桌面窗口或便携程序时，再按下面的构建步骤安装。

## 代码与扩展入口

- `src/`：界面及共享前端组件。
- `server/`、`shared/`：本机服务、数据处理和共享类型。
- `modules/`：可选功能；开发约定与模板见[模块开发](modules.md)。
- `electron/`、`scripts/`：桌面窗口、启动、构建和检查入口。
- [下载来源接口](download-sources-api.md)：资源列表适配器与请求规则。
- [本机 API](external-api.md)：提供给用户脚本和工具的授权接口，与第三方作品资料服务的密钥无关。

模块注册表由 `scripts/modules.mjs` 生成。新增或修改模块后重新生成，不要手改 `.generated` 文件；前端和后端构建也会执行生成。

## 检查改动

按改动范围选择检查。纯文档变更核对链接、命令和功能描述即可，不需要构建程序或运行应用测试。

```powershell
pnpm modules:generate
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec tsc --noEmit -p tsconfig.server.json
pnpm exec tsc --noEmit -p tsconfig.test.json
```

使用 `pnpm exec vitest run <相关测试路径>` 运行受影响测试。例如，下载来源变更可运行：

```powershell
pnpm exec vitest run modules/download server/services/__tests__/download-source-settings.test.ts
```

`pnpm test` 运行全部 Vitest 测试。模块组合检查使用 `pnpm verify:modules core`、`pnpm verify:modules extension` 或 `pnpm verify:modules full`；不传参数会检查三组。该脚本在隔离临时副本中检查类型、构建和 HTTP 启动，详细说明见[模块开发](modules.md)。

涉及文件操作、数据库或备份的测试应使用隔离数据。自动化检查不能替代真实 Everything 服务、播放器、第三方服务或 Windows 原生窗口的验证；记录实际检查范围，不将构建成功视为全部功能通过。

## 构建 Windows 便携程序

安装依赖后，在项目根目录执行：

```powershell
node node_modules/electron/install.js
pnpm build:electron
```

第一条命令下载与依赖版本对应的 Electron runtime。第二条命令构建前端和后端、生成第三方依赖声明，并生成未签名的 Windows 便携程序。

可交付 EXE 为 `release/AnimeShelf-portable.exe`；该目录还包含许可证、第三方声明和相关说明。程序运行无需 Node.js 或 pnpm，仍会使用 Windows 自带的 PowerShell。便携模式的数据默认位于 EXE 旁的 `data/`；Electron 会话缓存和本机服务登记仍会写入 Windows 用户目录。

## 分发前检查

- 使用当前源码重新构建，核对版本及实际输出，避免误发旧的 EXE。
- 在干净的 Windows 环境使用隔离数据检查启动、退出和主要操作；代码签名及系统提示须如实说明。
- 核对 `LICENSE`、`THIRD-PARTY-NOTICES.txt`、依赖许可文本及 Electron 的 `LICENSES.chromium.html`；必要时重新运行 `node scripts/generate-notices.mjs`。
- 不分发整个工作目录，尤其不要包含 `data/`、真实媒体库、海报缓存、备份、密钥、日志或服务控制记录。
- 阅读[第三方使用条件](THIRD-PARTY.md)与[素材来源](ASSET-PROVENANCE.md)。项目的 MIT 许可证不替代数据、图片、站点服务或商标的授权；未确认事项仍需单独处理。
- 仅在实际上传可下载产物后更新首页获取说明。源码 ZIP、开发环境构建成功和正式程序发布是不同的交付状态。

本文件提供操作方法，不代表某个提交已执行以上全部检查，也不代表仓库已经提供 Windows 下载包。实际获取方式以[项目首页](../README.md)和 [Releases](https://github.com/RenaKana/AnimeShelf/releases) 为准。
