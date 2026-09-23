# AnimeShelf External Data API

AnimeShelf can expose a separate, bearer-authenticated data API for local integrations. The owner enables the listener in Settings; the default base URL is:

```text
http://127.0.0.1:3003/api/v1
```

This API lets your own scripts or tools access the local AnimeShelf library. It is optional and does not require buying a Key from AnimeShelf. Tokens are created locally and are separate from any AniList, Bangumi or TMDB account credentials used for title information. For ordinary library operations, see the [user guide](USER-GUIDE.md).

The desktop application (or development server) must be running. The external listener is always loopback-only and starts disabled. Enable **启用专用外部接口** in **设置 → 外部 API**, set a port, choose **保存设置**, then create a token under **访问令牌**. Prefer the **只读** role for tools that only need to read data. The token's full value appears once; store it securely. Names, roles, expiry and revocation can be managed there. Tokens are persisted only as SHA-256 hashes; revoked tokens cannot be restored.

The external listener does not expose the owner settings API, download-source configuration or queries, internal website routers, static files, arbitrary SQL, arbitrary paths, scans, backups, metadata refresh, or library configuration.

This is an authorization boundary for this dedicated listener, **not a sandbox for local programs**. A process that can already reach the older owner API or read the database file can bypass it. Keep the owner API private. Remote access requires a separately configured HTTPS reverse proxy pointing only to this dedicated port; never publish the owner's port. AnimeShelf does not open firewall rules, configure a proxy, or automatically expose a LAN/public listener.

## Authentication and permissions

Send the token in the HTTP `Authorization` header:

```http
Authorization: Bearer <token>
```

Tokens have one of these roles:

- `read`: local database reads only.
- `edit`: all reads plus the metadata, favorites, tags, and catalog mutations below.
- `files`: all editor operations plus physical folder rename, move, and deletion.
- `disabled`: no access.

Role checks use the authenticated token record, not client-supplied role headers or query parameters. Unknown paths and methods are not forwarded to internal AnimeShelf routes.

Errors use a stable JSON envelope:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE"
}
```

Common status codes are `400` for invalid input, `401` for missing/invalid/disabled/expired/revoked tokens, `403` for insufficient permission or prohibited browser origins, `404` for missing resources or routes, `409` for stale paths and data conflicts, `413` for oversized JSON, `429` for rate limiting, and `503` for an unavailable/disabled service. Unexpected internal failures return `500` without stack traces.

Requests accept at most 128 KiB of JSON. Each token is limited to 120 requests per minute; failed authentication is limited separately without blocking valid callers. Browser cross-origin access is not enabled. Use an ordinary HTTP client and header-based authentication; query-string credentials are not supported.

Mutations record token ID, method, route pattern, HTTP status and time, retaining the latest 5,000 records in `external_api_audit`. No raw URL, body or secret is stored. Status `499` means the client disconnected; it does **not** guarantee an already-started operation was cancelled. Read access only updates authentication bookkeeping (`last_used_at`), never business data.

Example (token remains in the caller's environment, not this document):

```powershell
$headers = @{ Authorization = "Bearer $env:ANIMESHELF_API_TOKEN" }
Invoke-RestMethod 'http://127.0.0.1:3003/api/v1/libraries?page=1&pageSize=50' -Headers $headers
```

## Pagination

All list endpoints accept `page` and `pageSize`. Both are positive integers. The defaults are `page=1` and `pageSize=50`; `pageSize` cannot exceed `200`.

List responses have this shape:

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "total": 0
  }
}
```

Unknown query parameters and unknown JSON fields are rejected instead of ignored.

## Read endpoints

All endpoints in this section require `read`, `edit`, or `files`.

### Token identity

`GET /me`

Returns this token's public metadata: `id`, `name`, `prefix`, `role`, `created_at`, `expires_at`, and `last_used_at`. It never returns a token secret.

### Libraries

`GET /libraries`

Returns `id`, `name`, `root_path`, `type`, and `created_at`. The response deliberately excludes `everything_url` and all settings or credentials.

### Folders

`GET /folders`

Optional filters:

- `libraryId`: positive library ID.
- `parentId`: positive parent-folder ID.
- `isSeries`: `true`, `false`, `1`, or `0`.
- `q`: case-insensitive literal substring search across folder name and path, up to 200 characters.

Folder rows contain explicit folder metadata only: IDs, hierarchy, name/path, series and poster flags, metadata source/ID, rating, genres, synopsis, year, episode count, display-metadata reference, pin/rename flags, and timestamps.

`GET /folders/:id`

Returns the folder row plus effective tags, direct child folders, direct files, the legacy catalog projection, catalog summary/candidates, and the canonical catalog under `media_catalog_v2`. This is a local database read: it does not refresh providers, rebuild catalogs, scan disks, or modify business data.

### Files

`GET /files/:id`

Returns explicit file metadata, its folder/library names, and effective tags. There is no arbitrary path-based file endpoint and the API does not return file contents.

### Tags

`GET /tags`

Optional filters are `q` and `kind=custom|system`. Each row includes `id`, `name`, `color`, `kind`, and `link_count`.

### Favorites

`GET /favorites`

Optional filters are `q`, `mediaType=anime|live`, and `airStatus=airing|finished|upcoming`. Stored `links` JSON is returned as an array. This endpoint does not run the internal favorite refresh/enrichment workflow.

`GET /favorites/:itemId`

Returns one stored favorite snapshot or `404`.

## Editor endpoints

All endpoints in this section require `edit` or `files`.

### Safe folder metadata

`PATCH /folders/:id`

Accepted fields are `name`, `source`, `anilist_id`, `rating`, `genres`, `synopsis`, `year`, and `episodes`. `name` changes the display name and marks it as manually renamed; it does not rename the disk directory. Path, library, hierarchy, poster files, scan state, settings, and Everything configuration cannot be changed here.

Example:

```json
{
  "rating": 8.5,
  "genres": ["Drama", "Mystery"],
  "synopsis": "Locally maintained description",
  "year": 2026,
  "episodes": 12
}
```

Changes that affect catalog identity are rebuilt through the existing validated catalog service.

### Favorites without enrichment

`POST /favorites`

Creates a stored favorite and returns `201`. Required fields are `item_id` and `title`. Optional fields are `title_zh`, `air_day`, `air_time`, `begin`, `bangumi_id`, `links`, `image`, `synopsis`, `synopsis_original`, `aired_episodes`, `total_episodes`, `air_status`, `media_type`, and `lib_match_override`.

`PATCH /favorites/:itemId`

Updates the same optional fields except `item_id`.

`DELETE /favorites/:itemId`

Removes one stored favorite.

These endpoints never fetch provider metadata or download/cache remote images. An `image` value is stored as metadata only. Link URLs must use HTTP or HTTPS.

### Tags and links

`POST /tags` with `{ "name": "Tag", "color": "#8b5cf6" }`

`PATCH /tags/:id` with `name` and/or `color`

`DELETE /tags/:id`

System tag names cannot be changed and system tags cannot be deleted.

`POST /tags/:id/links` with `{ "target_type": "folder|file", "target_id": 123 }`

`DELETE /tags/:id/links` with the same body

Targets and tag IDs are validated before links are created.

### Manual catalog and work groups

These routes call AnimeShelf's existing catalog validation and transaction services and return `media_catalog`, `media_catalog_summary`, `media_catalog_v2`, and `media_catalog_candidates`.

- `PUT /folders/:id/media-catalog` accepts `kind`, `seasonNumbers`, `partNumber`, `customLabel`, `clearManual`, and `excluded`.
- `PUT /folders/:id/media-catalog-title` accepts `{ "title": "..." }`.
- `PUT /folders/:id/media-work-groups/:groupId/title` accepts `{ "title": "..." }`.
- `POST /folders/:id/media-work-groups/:targetGroupId/merge` accepts `{ "sourceGroupId": 123 }`.
- `POST /folders/:id/media-work-groups/:groupId/attach` accepts `{ "mediaItemId": 123 }`.
- `POST /folders/:id/media-work-groups/:groupId/detach` accepts `{ "mediaItemId": 123, "title": "optional" }`.
- `POST /folders/:id/media-work-groups/:groupId/split` accepts `{ "mediaItemIds": [123], "title": "New group" }`.

## File-management endpoints

These endpoints require `files`. They operate only on database-selected folders through the existing protected folder-operation services. Each request must include the folder's current `expectedPath`; stale values fail with `409 STALE_FOLDER_PATH` before a disk mutation.

`PUT /folders/:id/rename`

```json
{
  "name": "New folder name",
  "expectedPath": "D:\\Anime\\Old folder name"
}
```

`PUT /folders/:id/move`

```json
{
  "targetLibraryId": 2,
  "expectedPath": "D:\\Anime\\Show"
}
```

The destination is the configured root of the selected existing library. Library roots cannot be created or changed through this API. Moves currently require the same filesystem volume; cross-drive/`EXDEV` moves return `409 CROSS_DEVICE_MOVE_UNSUPPORTED` without copying or deleting data. Concurrent physical operations return `409 FILE_OPERATION_IN_PROGRESS` and can be retried after the active operation finishes.

`DELETE /folders/:id`

```json
{
  "expectedPath": "D:\\Anime\\Show",
  "confirm": true
}
```

Deletion is rejected unless `confirm` is exactly `true`. Library roots, paths outside the selected library, symbolic links/junctions, collisions, and stale paths are protected by the shared folder-operation service. Successful rename, move, and delete operations invalidate the library-hit cache just like the internal owner routes.

Deletion is permanent, not a recycle-bin action. A temporary sibling directory is retained until the database/catalog transaction commits. Database failure restores the original directory. If final disk cleanup fails after commit, the response includes `cleanupPending: true` and `cleanupPath`; the catalog entry has been removed, but some disk contents remain at that path and require manual inspection. Do not assume the remaining contents are a complete backup.

Internal `.animeshelf-delete-*` and `.animeshelf-rename-*` directories (including descendants) are excluded from scans, so a retained staging directory is not re-imported as media.
