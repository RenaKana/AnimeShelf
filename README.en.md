# AnimeShelf

[简体中文](README.md)

AnimeShelf is a local anime and film library manager for Windows. It turns your media folders into a browsable collection: view titles in a table or poster wall, add names, descriptions and cover art, then organize them with media types, tags, collections and watchlists.

Media files stay in the folders you choose. Importing a library records their locations and title information; it does not create another copy of your media files.

![AnimeShelf Settings in the dark theme](docs/images/settings-appearance.png)

*The actual Settings screen in the current public version, before adding a media library.*

## Features

- **Browse your collection**: View local titles in a table or poster wall, search by name, and use sorting and filters.
- **Organize title information**: Match names, descriptions and covers through AniList, Bangumi or TMDB, or edit display information yourself.
- **Categories and collections**: Distinguish anime from live-action titles, organize tags and season/folder groups, and turn related folders into collections.
- **Following and wishlists**: View airing information, save titles of interest and search for releases by title.
- **Release search**: Browse Bangumi.moe, ACG.RIP, DMHY and Nyaa, search keywords, select sources and open the original detail pages. The sidebar item named “下载” (Download) is a search interface; **it does not automatically download media files**.
- **Appearance and backups**: Customize themes, display preferences and wallpapers, and back up library records and settings.

## Current version and availability

The repository provides source code for the Windows desktop app, with a project version of **1.0.0**. As of **2026-09-23**, it has **no published Release, downloadable Windows EXE or installer**.

- **Get the source**: Choose **Code → Download ZIP** on the [repository page](https://github.com/RenaKana/AnimeShelf), or clone it with Git.
- **Run the app**: Follow the [source setup instructions](docs/DEVELOPMENT.md), then open the local address printed by the launcher in a browser.
- **Build the desktop app yourself**: The development guide explains how to build a portable Windows EXE. The source ZIP is not a ready-to-run application.

Future application downloads will be listed on the [Releases page](https://github.com/RenaKana/AnimeShelf/releases).

## First use

The current interface uses Chinese labels; they are included below to help you find each control.

1. **Start the app** using the source setup instructions and open the displayed address. If you have built a portable EXE, run it directly.
2. **Add a library** from “全部媒体” (All media) using “添加媒体库” (Add library). Enter a name, an existing folder's absolute path, and choose “动画” (Anime) or “影视” (Live action).
3. **Scan files**: Set the Everything HTTP Server address under “设置 → 常规 → Everything” (Settings → General → Everything), then open the library and choose “扫描媒体库” (Scan library). Initial import and subsequent file-index updates require this service; adding a folder is not the same as scanning it.
4. **Browse and match information**: Switch between “表格” (Table) and “海报” (Posters). Open a title and choose “匹配元数据” (Match metadata) in “海报与元数据” (Poster and metadata), then check the candidate title before applying it.
5. **Organize your collection**: Adjust types and tags, organize groups in “季度与目录” (Seasons and folders), and use “设为合集” (Set as collection) for folders you want to browse together. “追番” (Following) and “心愿单” (Wishlist) help track titles of interest.
6. **Make a backup** under “设置 → 备份与恢复” (Settings → Backup and restore). Choose a backup location and make a manual backup; repeat before important file operations or upgrades.

See the [user guide](docs/USER-GUIDE.md) for detailed steps and limitations. The linked user and development guides are currently in Chinese.

**File safety:** Changing a display name is different from renaming a folder on disk. Renaming disk folders, moving them or deleting them affects real files. **Deletion does not use the recycle bin.** Check paths before proceeding and back up important media separately.

## Title information sources and optional setup

Configure sources under “设置 → 元数据” (Settings → Metadata). The credentials below belong to their respective third-party platforms. **They are not services purchased from AnimeShelf and are not local API tokens.**

| Source | Purpose | Credentials |
| --- | --- | --- |
| AniList | Anime information, cover art and airing-related data | The current integration needs no user Key or login token. |
| Bangumi | Title information, cover art and airing data | “Bangumi Access Token” is optional for the public-data queries currently supported. |
| TMDB | Movie and television information and cover art | Your own “TMDB API Key” is required to use TMDB matching; leave it blank if you do not use TMDB. |

Obtain credentials from the corresponding platform and follow its terms. Masking a field in the interface does not mean the data is encrypted on disk; protect your local data and backups. Availability, request limits and data completeness depend on each provider, and matches should be checked before use.

### Everything and other external tools

Everything HTTP Server is **required to scan and import local files**. Install and enable it separately, and make sure it indexes your media folders. The default address is `http://localhost:1223`; change it to match your configuration. AnimeShelf does not bundle Everything or provide a separate direct filesystem-scanning fallback.

Everything does not have to stay running to browse existing library records or organize saved titles. Metadata lookup and release search need internet access. Wallpapers use your own assets; Wallpaper Engine is required only when choosing that wallpaper mode, not to start the app.

## Local API and tool integration (advanced)

The local API lets **your own scripts or other tools** read the library or, with permission, edit records. It is disabled by default and is not required for ordinary use.

Enable it and create a token under “设置 → 外部 API” (Settings → External API) only if needed. The service listens only on `127.0.0.1`. Prefer read-only access, and grant editing or file-operation permissions only to trusted tools. The full token is shown once: store it securely, keep it out of URLs, screenshots and public repositories, and do not expose the application's owner/admin port to the internet.

You create these tokens locally; they are unrelated to AniList, Bangumi or TMDB accounts and credentials. See the [local API documentation](docs/external-api.md).

## Data and backups

- **Location**: Source runs use the project's `data/` directory by default. A self-built portable app uses `data/` beside the EXE. See the user guide for a custom location. Browser caches are stored separately in the Windows user profile.
- **Coverage**: Database backups contain library records, settings and possibly credentials. Posters have a separate backup option. **Backups do not include the original videos or other media files**; back those up separately.
- **Controls**: Use “设置 → 备份与恢复” (Settings → Backup and restore). Automatic database backups default to `backups/auto/` inside the data directory and retain the latest 10 copies. Manual backups default to the Windows Desktop, with a configurable destination.
- **Upgrades and moves**: Exit the app, save a separate copy of the complete data directory and back up your media before updating. Check the restore preview and paths first: restoring replaces current library records rather than merging them.
- **Compatibility**: This version rejects older databases and backups containing phone-sync structures. If you see an incompatibility message, keep the original file and use a new, separate data directory. Do not remove database tables or overwrite your only copy to force an import.

Backups may contain keys, tokens, private paths and collection records. Never upload a database, backup or complete data directory in a public issue. See the [user guide](docs/USER-GUIDE.md) and [privacy information](docs/PRIVACY.md).

## Frequently asked questions

**Why are there no titles after I add a folder?**

Adding a library only saves its folder configuration. Check that Everything HTTP Server is reachable and has indexed that folder, then choose “扫描媒体库” (Scan library). Resolve connection or path errors first; do not delete the database to start over.

**Do I have to configure every metadata provider?**

No. The current AniList integration needs no user credentials, the Bangumi token is optional, and only TMDB requires your own Key when you use it. These settings are not an AnimeShelf payment gateway.

**Does the Download page download videos?**

No. It provides search, result lists and links to the original detail pages. A source may be unavailable or limit requests; built-in search does not guarantee availability or grant rights to its media content.

**Can I use the app offline?**

You can browse saved local library records. Online matching, remote posters, airing-data refreshes and release searches need access to the corresponding services.

## Development and licensing

Source setup, the technology stack, testing and builds are covered in [Development and building](docs/DEVELOPMENT.md). Extension references include [modules](docs/modules.md), the [download source API](docs/download-sources-api.md) and the [local API](docs/external-api.md).

Project code is licensed under the [MIT License](LICENSE), Copyright (c) 2026 Rena. Title information comes from AniList, Bangumi, TMDB and [bangumi-data](https://github.com/bangumi-data/bangumi-data) (CC BY 4.0). This product uses the TMDB API but is not endorsed or certified by TMDB.

Third-party dependencies, data, posters and assets have their own licenses and terms; the project license does not replace them. Attribution and unresolved usage conditions are documented in [third-party information](docs/THIRD-PARTY.md), [dependency notices](THIRD-PARTY-NOTICES.txt) and [asset provenance](docs/ASSET-PROVENANCE.md).
