# AnimeShelf desktop preview

A local anime/film library manager using React, Vite, Express, SQLite WASM and Electron.
This candidate contains Windows desktop source only. The AI workbench, AI services, recognition modules, phone client, desktop pairing and phone sync are excluded.

Display and wallpaper controls are grouped under Appearance. Video wallpapers retain their last frame while the window is unfocused and resume automatically on return. Use a separate data directory: databases and backups containing phone sync structures are rejected without migrating or deleting their data.

This repository provides Windows desktop preview source. No new Windows executable is distributed with this source release. The project code is licensed under the [MIT License](LICENSE), Copyright (c) 2026 Rena. Third-party dependencies, assets and data remain subject to their own licenses and terms; the project license does not replace them.

The retained modules are metadata, media-catalog, season, download, wallpapers and external-api, alongside core library management, backup.

Four download sources are built in: Bangumi.moe, ACG.RIP, DMHY and Nyaa. No address setup is required. Entering the download page loads the selected sources (latest releases for an empty keyword); search, refresh, pagination and wishlist links retain their original behavior. There is no custom-site settings interface. Legacy saved addresses are preserved but never used or exported through ordinary settings. Arbitrary websites, custom headers, login, cookies and verification bypasses are not supported. Proxies still fail closed for download queries; built-in support is not a confirmation of site availability or permission.

Use Node.js 22 and the pnpm version specified in package.json:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

For a new unsigned Windows portable build:

```powershell
node node_modules/electron/install.js
pnpm build:electron
```

The portable app includes its runtime and needs no development tools. Its local data defaults to `data/` beside the EXE; `ANIMESHELF_DATA_DIR` overrides this. Never distribute user data, caches, backups or an entire development directory.

Browser sessions/caches still use Electron's Windows user profile directory, and the local service registry defaults to `%LOCALAPPDATA%/AnimeShelf/run/`. Portable means no installation, not zero user-profile writes. The application uses the Windows-provided PowerShell for process identity, database ownership checks and service-registry permissions; keep the standard Windows tools available on PATH.

See [privacy](docs/PRIVACY.md), [third-party obligations](docs/THIRD-PARTY.md), [asset provenance](docs/ASSET-PROVENANCE.md), [download API](docs/download-sources-api.md), and [external API](docs/external-api.md). Unresolved service terms and asset provenance remain documented; source publication does not clear those obligations. Signing and distributing Windows binaries are separate release steps.
