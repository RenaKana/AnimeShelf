# AnimeShelf desktop candidate — third-party inventory

Generated for the desktop candidate on 2026-09-21. The maintainer has selected the [MIT License](../LICENSE) for the project code, Copyright (c) 2026 Rena. This inventory records third-party sources and obligations; their licenses and service terms remain separate from the project license.

## Inventory authority

The exact dependency inventory is generated from the root importer in `pnpm-lock.yaml`, not from semver ranges alone. Direct production/development roles come from `package.json`. The reproducible output is:

- `licenses/dependency-license-manifest.json` — every lock package, installed status, role, version, license field, license-file evidence, and runtime evidence.
- `licenses/dependency-license-texts.txt` — package license text copied from the installed package where the file is present and reasonably sized.
- `THIRD-PARTY-NOTICES.txt` — grouped notice list and unverified lock entries.

Regenerate from the candidate root with:

```powershell
node scripts/generate-notices.mjs
```

The candidate intentionally has no npm lockfile. Do not combine this inventory with the removed mobile lock or with the source checkout's old `package-lock.json`.

## Current desktop dependency obligations

- `bangumi-data@0.3.223` is `CC-BY-4.0`. Its installed README requests attribution naming `bangumi-data`; keep that attribution when the package data is redistributed.
- `node-sqlite3-wasm@0.8.60` is MIT and supplies the desktop SQLite WASM runtime. The package README identifies the underlying SQLite source as public domain; retain the package MIT notice and the exact runtime evidence.
- `electron@43.4.1` and `electron-builder@26.15.3` are MIT at package level. A clean Electron runtime must also provide its exact `LICENSES.chromium.html` notice bundle for Chromium and bundled third-party components.
- `puppeteer-core@25.9.0` is Apache-2.0. Other installed packages include BSD, ISC, BlueOak, Python-2.0, CC-BY, WTFPL and dual-license expressions; the generated manifest keeps each package separate.
- No GPL prohibition is inferred. The project's MIT license does not relicense third-party components. Unverified lock entries are not treated as license-free.

License evidence includes conventional license/notice files, `LICENSE-MIT` variants and the license sections embedded in package READMEs. `boolbase@1.0.0` declares ISC but its npm archive omits the text. `licenses/boolbase-1.0.0-LICENSE.txt` preserves the upstream ISC notice from commit `be0bcd8a4e917a0a5895e95b523fbbed05a64871` (2015-10-14). That commit's package version is 1.0.0 and its `index.js` is byte-identical to the installed locked package; both source and notice hashes are recorded and checked by the generator. `spawn-command@0.0.2` has no manifest license field, but its included LICENSE is MIT text and is retained without rewriting the manifest observation.

The manifest distinguishes production dependencies from development dependencies. Build-only tools such as Vite, Vitest, TypeScript, Electron Builder and Puppeteer Core should not be described as runtime dependencies, but their licenses still matter if they are redistributed in source, caches, or a tooling bundle.

## Runtime and package files

The release owner must re-run the generator after preparing the clean Electron runtime. Relevant relative paths are recorded under `runtime` in the manifest:

- `node_modules/electron/LICENSE`
- `node_modules/electron/dist/LICENSES.chromium.html`
- `node_modules/electron/dist/electron.exe` and the Windows DLL/Pak runtime beside it
- `node_modules/node-sqlite3-wasm/LICENSE`
- `node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm`

The application build deliberately keeps `node-sqlite3-wasm` external and unpacked; see `scripts/build-server.mjs:1-3` and `package.json:66-73`. A portable executable is not proof that the corresponding notices were included, so the prepared runtime remains an acceptance gate.

## 数据源使用条件（2026-09-21 复核）

本节区分官方条件、代码事实与尚待确认的适用性，不是法律放行结论。条款核对阶段只读官方文档、规则及候选源码，仅更新文档；随后获得授权的 TMDB／AniList 冷却修复在下文单独标明。两阶段均未使用真实账号、密钥或用户数据库，未查询资源列表、下载媒体或向站方发信；后续修复未改下载适配器或已有用户数据。

随后按维护者确认，下载恢复为四个内置站点：`https://bangumi.moe/`、`https://acg.rip/`、`https://share.dmhy.org/`、`https://nyaa.si/`。进入下载页会查询默认或当前会话已选来源；手填站点设置及接口撤下，旧地址仅留存且不执行。此变化是功能范围决定，不是站方授权、实时可用性或完整合规通过的证据；以下机器访问规则、许可和请求间隔未决项继续保留。`api.bgm.tv` 的 Bangumi 与 Bangumi.moe 是不同服务。

### 结论摘要

| 来源 | 当前能确认的范围 | 仍需处理 |
| --- | --- | --- |
| AniList | 已读到官方使用条款和限流说明；匿名元数据、海报及追番调用仍存在。候选新增跨 API 入口的共享冷却及响应头处理。 | 本产品的互补用途、长期缓存适用性仍待确认；内置官方 API 接入本身不是禁止理由。未将本机冷却等同于主动配额调度或完整条款验收。 |
| Bangumi API | 已找到官方版权声明、开发者协议及 User-Agent 指引；请求已标明 Rena、AnimeShelf 和实际应用版本。 | 确认缓存数据向授权本机外部客户端传递、备份恢复及停止使用时的处理边界；公开主页确定后补入应用标识。 |
| TMDB | FAQ 的署名及非商业／商业条件已明确；设置页已有标识及非背书声明。候选已修正 API 收到 429 后立即进入代理尝试的问题，并共享冷却状态。 | 确认最终盈利方式、完整 API 协议与缓存范围；已有署名不等于所有服务条件均通过。项目默认 Key 是可选接入方案，本轮未添加凭据或更改用户自填方式。 |
| bangumi-data 0.3.223 | 随包数据集为 CC BY 4.0；已有来源、许可链接及格式转换／筛选说明。 | 保留声明；此许可不覆盖 Bangumi API、海报或其他站点内容。 |
| Bangumi.moe | robots 对通用爬虫禁止全部路径；历史官方前端可作为接口形态参考。 | 未找到覆盖本应用自动请求的明确例外或完整数据使用许可，不能放行为可随意调用。 |
| ACG.RIP | robots 返回成功，但有效规则为空。 | 自动访问、商业用途、缓存及结果再展示许可仍未核实；没有禁止规则不等于已经取得授权。 |
| 动漫花园 / DMHY | robots 对关键词查询有明确禁止项。 | 候选关键词请求与机器访问声明不一致，需取得明确许可或另行决定允许的接入范围；本轮未移除功能。 |
| Nyaa | 有官方 RSS 使用说明；候选已在实际 HTTP 发送处实现同进程至少 5 秒间隔，覆盖刷新、翻页、RSS 和允许的重定向。 | 商业、缓存及再展示授权仍不完整；间隔测试不等于真实站点可用性或用途许可。 |

### 实际发送、保存与转交范围

| 代码路径 | 已核实行为 |
| --- | --- |
| `modules/metadata/server/metadata.ts:415`、`:434`、`:1079` | AniList 接收搜索词或作品 ID、GraphQL 查询及固定应用标识；这些调用不附 AniList 账号令牌。 |
| `modules/metadata/server/metadata.ts:458`、`:1156`、`:1213` | Bangumi 接收关键词、作品类型／排序或条目 ID；仅在用户配置时附该服务的 Bearer token。 |
| `modules/metadata/server/metadata.ts:866`、`:924` | TMDB 接收搜索词／条目 ID、电影或剧集类型、语言等参数及用户自己的 TMDB key；图片另从图片主机获取。 |
| `modules/season/server/airing.ts:152`、`:229`；`modules/season/server.ts:13` | 追番会查询 AniList／Bangumi；AniList 单次最多各 50 个 AniList、MAL ID。除手动操作外，保留启动及周期刷新，故不能描述为全应用仅在点搜索时联网。 |
| `modules/metadata/server/routes.ts:17`；`modules/metadata/server/metadata.ts:507`、`:1063`、`:1114`、`:1134`、`:1296` | 搜索中间结果内存缓存 10 分钟，远程图片内存缓存 5 分钟；最终绑定的元数据写入 SQLite，海报写磁盘，不能将上述内存 TTL 当作磁盘数据到期删除机制。 |
| `server/services/backup.ts:38`、`:73`、`:98` | 本地 SQLite 快照可包含已保存的供应商元数据；海报增量备份默认开启。没有向这三个供应商上传数据库。自动 DB 快照保留最近 10 份，不等于清除所有海报副本。 |
| `modules/external-api/server/data.ts:28`、`:322`；`modules/season/server/external-api.ts:9` | 经授权的本机外部客户端可读取已保存的供应商元数据；收藏响应可有图片路径字符串，不是图片字节。该接口不是供应商 API。 |
| `modules/download/server/adapters.ts`；`modules/download/server/service.ts`；`modules/download/server/request-pacing.ts`；`modules/download/server/transport.ts` | 下载来源接收关键词、分类／页码及固定应用标识；结果是内存缓存，默认 30 秒。全局最多 3 个来源并发、同来源串行，处理 429 冷却；Nyaa 实际 HTTP 尝试另有同进程至少 5 秒间隔。没有自动抓取或解析 robots。 |

搜索词可能来自整理后的本地作品／文件夹名称；“不发送媒体库绝对路径或文件内容”不能扩大为“不会发送任何本地命名信息”。本地备份不是把 AniList API 当作云备份服务，不能直接据此认定违反 API 存储禁令；但长期缓存、导出与同步是否获准，仍须对应服务条件确认。

### 条件与最小后续处理

**AniList。** 条款限制竞争性、非互补的动漫列表／追踪服务，覆盖媒体及用户数据，并禁止囤积数据或把 API 当存储／备份服务。非商业免费不豁免这些条件。商业月收入低于 150 美元免额外商业许可，高于 150 美元需联系官方；等于 150 的文字未明确。应向官方描述本地媒体库、追番、按需元数据及离线缓存，确认适用性，不自行判定允许或违规。[AL1]

官方限流页本次核对时提示临时 30 次／分钟，普通额度为 90 次／分钟，并说明限流响应头及突发限制。[AL2] 随后的实现更新增加 `server/services/provider-rate-limit.ts`：搜索、详情、查找海报 URL 和追番的 API 调用共用进程内冷却；读取 `Retry-After`（秒或 HTTP 日期）、`X-RateLimit-Reset`，以及成功响应中 `X-RateLimit-Remaining: 0` 的耗尽信号，也识别 HTTP 200 下 GraphQL 的 429 错误。冷却期内快速返回剩余等待时间，不联网、不自动重试当前调用；无有效等待信息时保守使用 60 秒，这是本地策略，不是声称官方配额固定为 60 秒。已发出的并行请求不会因此被全局取消，迟到成功也不会清除冷却。

该冷却不跨进程或设备共享，进程重启不保留；它不主动实现“每分钟固定 N 次”的配额调度，也不接管图片 CDN 或其他供应商请求。原有批量间隔、追番刷新计划和来源独立性保留。缺少某一种限流器架构本身不构成违规证据；本轮验证使用模拟响应，不声称实测官方配额或获得用途许可。

**Bangumi。** 官方版权页对用户提供的条目信息、角色信息声明适用所链接的 CC BY-SA 3.0，同时称已有版权作品按 fair use 原则处理并标注来源；这不等于向下游授予全部封面或图片的再分发许可。用户原创日志、吐槽、图片另需作者许可；站点 Logo、网页图形及角色形象也有单独的非商业使用条件，不能概括为“所有用户贡献都采用 CC BY-SA”。开发者协议另有必要数据范围、用户同意、不得私自向第三人提供平台数据及终止后删除平台数据等条件。[BG1][BG2] 需确认授权本机客户端读取和本地备份恢复是否属于允许范围，以及应怎样保留数据署名／相同方式共享要求；这不是要求整个 MIT 应用改用 CC 许可。

官方 API 指引建议 UA 标明开发者、应用名，分发时加版本，开源项目加主页。[BG3] `modules/metadata/server/metadata.ts` 的 Bangumi 专用请求配置现使用 `Rena/AnimeShelf/1.0.0`，版本直接读取 `package.json`；搜索、详情及正常的 legacy／网络错误代理回退使用相同身份。Rena 是维护者明确选定的公开署名，不宣称它是已核实的 GitHub 账号。公开项目地址尚未确定，暂不虚构主页；确定后在 `package.json` 添加 `homepage`，UA 会追加该地址。用户令牌仍只在配置后单独作为 Authorization 发送，不写入 UA。原注释中未经核实的固定配额数字已移除；本次未新增 Bangumi 跨调用冷却机制，现有单次 HTTP 429 不转代理或 legacy 重试的行为保留。

**TMDB。** FAQ 允许带署名的非商业使用，商业用途需安排许可；要求 About/Credits 中的批准 Logo、指定非背书声明，并保持 TMDB 标识的显著程度低于应用主标识。[TM1] `src/components/settings/DataCredits.tsx:3` 已有相应内容；标识来源见素材台账，但不据此确认商业许可或所有图像权利。完整 API 协议及当前 Logo 页面本次访问受限，缓存／转交范围仍需确认。MIT 允许下游商用，不等于下游自动取得 TMDB 商业许可。

TMDB 已取消旧的 40 次／10 秒限制，现文档仅给出约 40 次／秒、可变的保护上限并要求尊重 429。[TM2] 随后的实现更新已让 TMDB 搜索、详情、查找海报 URL 共用上述冷却：直连／代理返回 429 都产生不携带请求 URL、上游正文或 Key 的安全错误；不会因限流切换代理或改写为普通网络失败。正常连接错误的原有回退保留。候选仍只读取用户的 `tmdb_key`，未内置项目默认 Key；是否采用默认应用凭据不影响本轮限流修复的成立，也不代表其分发约定已确认。

**bangumi-data。** 锁定版本的 README、随包声明及设置页已提供来源名、CC BY 4.0 和应用转换说明。保留许可链接与修改说明；仅确认这个随包数据集的授权范围，不为其他服务或图片背书。[BD1]

### 四类下载来源：机器访问规则与授权缺项

robots 是机器访问声明，不是版权许可或完整访问授权；`Crawl-delay` 也不是 RFC 9309 的标准 Allow/Disallow 字段。[REP] 本节将站点主动公布的间隔作为需要对齐的操作规则，不将违反 robots 直接等同违法。

| 原站与证据 | 与候选请求的关系 | 最小处理建议 |
| --- | --- | --- |
| Bangumi.moe robots：`User-agent: *`、`Disallow: /`。[DL1] | 当前自动请求 `/api/torrent/latest`、`/api/torrent/page/{n}` 及 POST `/api/v2/torrent/search`；未找到适用于本应用的明确例外。 | 先取得自动 API 请求许可及当前接口说明；无例外时不把这些原站请求判为可放行。官方前端历史接口与候选不完全相同，不等于已验证当前 API 兼容性。 |
| ACG.RIP robots：仅注释，无生效的禁止规则；所查 terms/about 为 404。[DL2] | HTML `/1`、`/5` 及 `term` 搜索。 | 明确自动访问、频率、商业、短缓存及结果再展示条件；robots 空白不是数据许可。 |
| DMHY robots：有 `/topics/list$`、`/topics/view/` 等允许项，也明确禁止 `/topics/list?`、`/*?*keyword=` 等。[DL3] | 候选关键词请求 `/topics/list?keyword=...` 与禁止项不一致。不能把首页允许访问推广为搜索和全部分页均允许。 | 取得明确例外或另行决定获准的请求形态；不通过换 UA、绕验证或更换镜像规避声明。 |
| Nyaa robots：通用间隔 5 秒、禁止 `/download`；官方帮助介绍 RSS 的程序消费用途。[DL4] | 候选不请求 `/download`；实际 HTTP 发送队列已确保同进程至少 5 秒间隔，涵盖刷新／翻页／RSS／允许的重定向。等待可取消并受原请求超时约束；失败的已发送尝试仍占间隔，取消的未发送请求不占间隔。结果缓存和更长的 429 冷却继续生效。 | 请求间隔待办已处理；仍需确认 HTML 自动访问、商业、缓存及再展示许可。间隔不跨进程／设备或进程重启保留，RSS 说明不授予媒体文件权利。 |

四站均未取得足以确认商业用途、缓存和结果再展示全部条件的官方证据。Bangumi.moe 的官方前端仓库 MIT、Nyaa 的站点软件 GPL-3.0 只是其软件许可，不能当作站内数据或媒体授权；本次只将仓库当作接口／说明来源，没有引入新依赖。合成解析测试继续只是代码证据，不是真实站点许可或可用性验收。

### 官方来源与本轮取得的证据

以下均为 2026-09-21 的有界核对；页面可能变化。未取得正文的页面明确列为未核实，不把 HTTP 200 的 SPA 外壳当作条款正文。

- [AL1] AniList Terms of Use：<https://docs.anilist.co/guide/terms-of-use>。普通匿名 HTTPS GET 为 200，读到条款全文；搜索读取工具的 403 不应描述成官方条款完全不可获得。
- [AL2] AniList Rate Limiting：<https://docs.anilist.co/guide/rate-limiting>。匿名 HTTPS 200；本次读取时仍有临时限额提示，不保证未来或所有部署环境的实际额度。
- [BG1] Bangumi《版权声明及开发者协议》：<https://bangumi.tv/about/copyright>。已读取正文；页面标注 2022-10-04 修改。
- [BG2] 上述版权页链接的 CC BY-SA 3.0：<https://creativecommons.org/licenses/by-sa/3.0/>。其范围不能扩展至声明排除的素材。
- [BG3] Bangumi 官方 API 仓库与 UA 指引：<https://github.com/bangumi/api>；<https://github.com/bangumi/api/blob/master/docs-raw/user%20agent.md>。读取成功；API schema 或仓库软件许可不是全站数据许可。
- [TM1] TMDB FAQ：<https://developer.themoviedb.org/docs/faq>。读取成功。<https://www.themoviedb.org/terms-of-use> 本次工具受 robots 限制；<https://www.themoviedb.org/about/logos-attribution> 本次返回 403。旧素材出处记录保留，不宣称完整协议／当前 Logo 政策本次全部复核通过。
- [TM2] TMDB Rate Limiting：<https://developer.themoviedb.org/docs/rate-limiting>。普通 HTTPS 200，已读取正文。
- [BD1] `node_modules/bangumi-data/README.md` 及锁定包许可；官方许可：<https://creativecommons.org/licenses/by/4.0/>。包版本为 0.3.223。
- [DL1] <https://bangumi.moe/robots.txt>：匿名 HTTPS 200；`/terms`、`/terms-of-service`、`/about` 返回相同 SPA 外壳，未取得条款正文。官方历史前端参考：<https://github.com/BangumiMoe/rin-re>（`SearchPaginator.js`、`TorrentPaginator.js`、`TorrentStore.js`）。
- [DL2] <https://acg.rip/robots.txt>：匿名 HTTPS 200；`/terms`、`/about` 为 404；限定搜索未找到可确认的官方 API／条款仓库。
- [DL3] <https://share.dmhy.org/robots.txt>、<https://dmhy.org/robots.txt>：匿名 HTTPS 200、相同内容；所查 `/terms`、`/about` 为 404。robots 中的搜索／AI 信号及 indexer 注释不是商业或转载许可。
- [DL4] <https://nyaa.si/robots.txt>、<https://nyaa.si/rules>、<https://nyaa.si/help>：匿名 HTTPS 200；`/terms`、`/about` 为 404。官方软件参考：<https://github.com/nyaadevs/nyaa>（`help.html`、`main.py`）；站点发布规则不等于对所有第三方再利用的授权。
- [REP] RFC 9309：<https://www.rfc-editor.org/rfc/rfc9309.html>，区分爬虫规则与访问授权，并定义规则匹配及扩展字段边界。

### 需要维护者／站方回答的问题

1. 确认首轮实际分发是否收费、含广告或其他营收；项目采用 MIT 本身不能回答供应商对商业用途的分类。
2. 向 AniList 说明本地媒体管理、追番／心愿单、按需元数据、磁盘海报及本机外部 API 读取，询问是否属于允许的互补用途和缓存范围。
3. 向 Bangumi 确认个人备份和授权本机客户端是否属于允许的数据转交，署名／相同方式共享与停止使用后的删除义务怎样执行。
4. 向四站确认允许的自动入口、关键词／分页、最低间隔、30 秒短缓存及结果展示范围，并对 robots 不允许的请求取得明确答复。

本轮只列问题，没有代维护者作出商业承诺或联系站方。站方答复前保留未决状态；记录缺项不等于已认定侵权，也不单凭不确定性擅自移除保留模块。

## Scope exclusions

This candidate ledger does not cover poster caches, real-site fixtures, mobile/Android packages, user media or credentials. Their exclusion is not a grant of permission to publish them. The project-level license is recorded separately in the root [LICENSE](../LICENSE).
