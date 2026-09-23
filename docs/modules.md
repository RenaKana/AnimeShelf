# AnimeShelf 源码模块

源码运行、依赖管理和 Windows 构建见[开发与构建](DEVELOPMENT.md)；日常操作见[使用指南](USER-GUIDE.md)。本文说明模块扩展与实现约定。

AnimeShelf 保留一个固定媒体库核心，其他功能由 `modules/<id>/` 提供。开发和生产使用 `scripts/modules.mjs` 发现模块并生成 `.generated` 注册表；请勿手工编辑生成文件。

## 使用和裁剪

在「设置 → 模块管理」保存开关，然后点击「重启服务」。确认后服务会停止接收工作，等待当前请求和模块任务结束，再重新初始化数据库连接与模块；网页和桌面模式均可使用。页面会等待新的服务实例就绪，再自动刷新导航和设置。设置分别显示本次实际状态、下次启动配置、依赖及失败原因。

重启前请保存其他设置。服务重启期间会短暂不可用；超时或请求失败时，页面会显示恢复提示，不会重复自动提交重启请求。首次更新到包含此入口的版本时，旧后端需要手动重启一次。此操作重新初始化当前进程内的服务与已安装模块；修改或删除源码仍须通过开发服务自动重建，或重新构建并启动应用。

关闭模块只停止功能，不清理其数据、密钥、历史设置或 SQLite 表。删除模块源码后须重新构建。若同时删除了某个必需依赖，请一并删除依赖它的模块。安装器、在线安装及运行时卸载不属于当前机制。

| 模块 ID | 必需依赖 | 可选集成 |
| --- | --- | --- |
| metadata | 无 | 通过核心能力接口刷新库存缓存和补全收藏海报 |
| media-catalog | 无 | 库存匹配缓存 |
| season | metadata | media-catalog；缺席时使用基本目录匹配 |
| wallpapers | 无 | 无 |
| external-api | 无 | metadata、media-catalog、season |
| download | 无 | 电脑端下载资源列表；无下载客户端集成 |

核心包含媒体库浏览、扫描、标签、真实文件操作、播放、数据库、备份和基础主题。模块失败不影响核心；必需依赖失败会阻止依赖者启动。已停用的模块入口不会加载，接口返回 404，旧页面显示功能不可用。

## 下载资源列表（电脑端）

`download` 默认启用，通过相同的保存开关、重启服务流程生效。侧栏「下载」与 `/download` 提供最新动画/合集、提交关键词与来源筛选、逐站结果状态、加载更多、独立重试；离开页面保留当前会话的关键词和来源选择。各站发布单独列出，同站 ID 去重，跨站保留。仅显示公开列表字段，点击标题打开原站详情；网页使用新标签页，Electron 使用受约束的 HTTPS 系统浏览器打开处理。四个站点及解析规则均内置，不提供手填地址设置。

- `GET /api/download/sources` 返回四个固定来源的 `id/name/url/note`。旧 `GET/PUT /api/settings/download-sources` 返回 404，通用设置接口拒绝下载地址字段。
- `GET /api/download/resources?source=bangumi&keyword=example` 保留列表契约。可选 `cursor` 绑定内置地址、关键词与来源，`refresh=1` 忽略短时缓存但不绕过限流；接口不接受调用方指定网址或配置版本。
- 内置 Bangumi.moe、ACG.RIP、动漫花园和 Nyaa；请求路径和查询参数由对应解析器生成，详情及翻页链接只能回到同一内置站点。
- 进入下载页会加载已提交的查询，首次默认四源、空关键词最新列表；心愿单跳转直接按带入的名称搜索。来源勾选变更后通过搜索生效。旧保存地址不执行，不支持的旧会话来源会被过滤。
- 全局最多 3 个请求槽、每站 1 个；最多等待 24 个排队请求，排队期限 30 秒，取得槽位后每站请求期限 18 秒。成功页缓存 30 秒，最多 120 页。429 遵守 `Retry-After` 秒数或 HTTP 日期，缺失时冷却 60 秒。停止模块取消请求并释放队列、缓存、冷却信息；没有新增业务数据库表。检测到无法安全支持的代理会明确拒绝，不转为静默直连。
- 请求目标、重定向、域名解析和实际连接均需通过目标校验，阻断本机、内网及保留地址；无法安全处理代理路径或 DNS 重绑定时明确失败。外部文本仅以文本渲染，详情链接再次校验。

验证页、解析失败和受限响应不得伪装成成功空列表。下载解析测试使用合成样本，不依赖真实站点；模块测试类型检查：`node node_modules/typescript/bin/tsc --noEmit -p modules/download/tsconfig.test.json`。本地验证不替代真实站点可用性与许可确认。

## 新增模块

1. 将 `docs/module-template/` 复制为 `modules/sample/`。使用其他目录名时同步修改 manifest 的 `id`，以及页面和接口路径。
2. 在 `manifest.json` 声明 `id`、`name`、`version`、`defaultEnabled`、`requires`、`optional`、HTTP `routes` 和前端 `pages`。HTTP 路径使用最终挂载的完整路径。
3. 在 `client.tsx` 导出 `ClientModule`。可贡献页面、导航、动态侧栏分区、设置分区、Provider、背景、目录面板、目录视图、媒体库工具栏及前端服务。
4. 在 `server.ts` 导出接收 `ModuleContext` 的工厂，返回 `ServerModule`。不需修改核心入口、侧栏或设置页。
5. 重新启动开发服务或重新构建。开发监听也会重新发现新增、删除的入口和 manifest。

新模块应该自包含。前端实现放 `client/`，后端实现放 `server/`，领域测试放模块自己的 `__tests__/` 或相邻 `.test.ts(x)`。现有 47 份领域测试已随模块迁入；宿主、真实文件操作及跨模块集成测试仍在 `server/services/__tests__/`。纯数据类型可以放 `shared/`。设置组件应为其根分区提供与声明一致的 `id`，使设置导航可以定位。不要把可选业务搬回核心来规避依赖检查。

## 后端约定

工厂取得 `db`、`settings`、`signal`，以及以下生命周期和能力接口：

- `provide(name, service)` / `capability(name)`：声明和查询单个具名服务；名称冲突会拒绝启动。
- `contribute(slot, value)` / `contributions(slot)`：向扩展位置贡献多个实现。
- `track(promise)`：登记后台工作，使关闭流程等待其成功、失败或取消。
- `onQuiesce(callback)`：停止定时器、监听端口等新工作的来源，在等待已有任务前运行。
- `onDispose(callback)`：释放已有任务仍可能使用的资源，在任务结束后运行。
- `isActive(id)`：查询本次启动的实际状态。

`ServerModule` 可以返回 `routes`、`migrations`、`start`、`quiesce`、`stop`、`afterRestore`。关闭顺序为取消信号、`quiesce`、等待任务、`stop`/资源释放。请求和启动过程应传播 `signal`，后台 Promise 必须登记，定时器必须登记清理。文件事务中的必要维护直接调用核心接口并传播异常，不使用不等待结果的事件通知。异步 Express 路由由应用记录；自己启动的后台工作仍须调用 `track`。

模块工厂和 `start` 必须在 `signal` 取消后尽快结束。宿主默认最多等待单个模块启动 15 秒；超时模块会被隔离，尚未结束的工厂不会阻塞关机，但它结束前数据库会继续保留，且同一进程不会启动第二个应用实例。

必需模块的导出接口可以静态引用；可选集成通过能力或贡献接口取得。构建会拒绝核心对模块实现的引用，也会拒绝对未声明为必需依赖的模块进行静态引用。所有现有进程数据库访问都在应用初始化后使用；一个进程只运行一个应用实例，重复装配会明确报错。

模块 HTTP 声明会与实际路由校验，并检查其他模块和核心路由的冲突；页面声明也需与前端贡献一致。`/api/modules` 和 `POST /api/service/restart` 属于核心，禁止模块覆盖或通过外部 API 令牌访问。重启接口只允许本机所有者请求，先返回 `202`，再由宿主执行重启；`/api/health` 的 `instanceId` 标识本次服务实例。

## 数据与恢复

历史 SQLite schema 保留为核心兼容基线。新迁移以 `{ id, up(db) }` 登记，ID 在模块内唯一并保持不变。宿主按声明顺序在事务内执行尚未运行的迁移，并写入 `module_migrations`。迁移失败会回滚本批迁移并隔离模块。不要在模块停用时执行回滚迁移、删表或删配置。

核心 `catalog-integrity` 负责维护已有目录、手工分类、作品和分组的归属。合集关闭时，扫描和文件变更仍调用维护逻辑，并写入待整理的媒体库。合集启动时，即使分类规则版本未变，也会重建待整理的库；只有完整库重建成功才清除标记。

备份包含全部已有表，包含停用模块的数据。恢复使用源和目标 schema 的列交集，旧备份缺失的当前字段采用默认值；备份缺少的当前数据表恢复为空。当前 `module_migrations` 记录不会被旧备份覆盖。恢复后同步下次启动配置，但不改变当前活动图；活动模块执行恢复钩子。海报补抓继续在后台进行并接受关闭取消。

关闭或删除模块源码不等于清理历史设置、凭据、任务或旧表；普通设置读取会脱敏秘密字段。外部 API 执行 `read` / `edit` / `files` 权限和所有者管理边界。

外部 API 的监听、令牌、权限和审计由 `external-api` 模块提供；心愿单和合集端点由各自模块向 `externalApi.routes` 贡献。贡献使用核心契约 `ExternalApiRouteContribution`，通过注入的 `auth.withRole`、输入验证和错误处理注册路由，不能绕过权限检查。对应模块未启动时，不挂载它的贡献。

恢复到全新数据库时只导入当前版本已有的表，不能据此推断任意历史数据库都兼容。`server/db/desktop-edition.ts` 会在 schema 初始化前，以及备份预检与恢复时，拒绝含 `mobile_*` 表或触发器的数据库；不迁移或删除源文件。开发时保留原数据，并使用独立目录测试兼容性，不通过删表绕过保护。

## 验证命令

```powershell
node scripts/modules.mjs
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.server.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
node node_modules/vitest/vitest.mjs run
node scripts/verify-modules.mjs
```

最后一个命令创建隔离临时副本，真正删除可选源码，验证 `core`、`extension`、`full` 三种组合的前后端类型检查、构建和 HTTP 启动。`extension` 只添加模板模块，用于验证扩展流程。可追加组合名称只运行选定组合。它不使用用户数据库，不覆盖工作区构建产物，报告保留在输出的临时目录中。真实外部服务、Everything 扫描源、播放器及 Electron 窗口行为须结合运行环境验证。

上述命令是开发验证入口，不代表当前提交已运行完整矩阵。按实际改动选择必要的组合。
