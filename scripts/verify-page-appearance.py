"""Verify shared page-header material and global text contrast with isolated fixtures.

Run against an existing Vite server. Every /api request is fulfilled in memory,
and every non-local request is blocked, so this script never touches the real DB
or a remote service.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright


sys.stdout.reconfigure(encoding="utf-8")

CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"
WIDTHS = ((1440, 980), (1024, 900), (768, 900), (390, 844), (320, 740))
ROUTES = (
    ("all", "/all"),
    ("season", "/season"),
    ("favorites", "/favorites"),
    ("folder-500-collection", "/folder/500"),
    ("folder-501-normal", "/folder/501"),
    ("settings", "/settings"),
    ("file-1", "/file/1"),
)
SCENARIOS = (
    ("normal-white-glass", "normal", "white", "glass"),
    ("high-white-glass", "high", "white", "glass"),
    ("normal-dark-solid", "normal", "dark", "solid"),
    ("high-dark-solid", "high", "dark", "solid"),
)
EXPECTED_BLOCKED_FONT = "https://fonts.googleapis.com/css2?family=Inter:"

SVG = {
    "white": """<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="980"><rect width="1440" height="980" fill="#f7f7f5"/><path d="M0 760L640 190l800 570v220H0z" fill="#e2e5e8"/></svg>""",
    "dark": """<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="980"><rect width="1440" height="980" fill="#07090e"/><path d="M0 780L700 120l740 660v200H0z" fill="#151b26"/></svg>""",
    "poster": """<svg xmlns="http://www.w3.org/2000/svg" width="180" height="270"><rect width="180" height="270" fill="#363c4f"/><circle cx="70" cy="82" r="31" fill="#b7a79e"/><path d="M0 270L180 88v182z" fill="#656d86"/></svg>""",
}


def folder(fid: int, name: str, *, pinned: int = 0, parent_id: int | None = None) -> dict[str, Any]:
    return {
        "id": fid,
        "library_id": 1,
        "parent_id": parent_id,
        "name": name,
        "path": f"D:/Fixture/Anime/{name}",
        "is_series": 1,
        "anilist_id": None,
        "has_poster": 1,
        "size": 2_147_483_648,
        "file_count": 1,
        "tags": [],
        "pinned": pinned,
        "rating": None,
        "genres": None,
        "synopsis": "仅供隔离浏览器验收使用的本地 fixture。",
        "year": 2026,
        "episodes": 1,
        "source": None,
        "poster_version": "fixture",
        "created_at": "2026-09-07T00:00:00.000Z",
        "updated_at": "2026-09-07T00:00:00.000Z",
    }


COLLECTION_CHILD = folder(502, "合集作品 A", parent_id=500)
COLLECTION_ITEM = {
    "id": 700,
    "library_id": 1,
    "root_folder_id": 500,
    "item_key": "local:502",
    "title": "合集作品 A",
    "title_zh": None,
    "kind": "season",
    "season_number": 1,
    "part_number": None,
    "manual_locked": 0,
    "confidence": 0.95,
    "conflict_reason": None,
    "source_ids": [],
}
COLLECTION_MAPPING = {
    "id": 800,
    "folder_id": 502,
    "media_item_id": 700,
    "root_folder_id": 500,
    "series_id": 1,
    "content_role": "main",
    "kind": "season",
    "season_number": 1,
    "part_number": None,
    "folder_name": "合集作品 A",
    "folder_path": COLLECTION_CHILD["path"],
    "manual_locked": 0,
    "confidence": 0.95,
    "conflict_reason": None,
    "detected_by": "fixture",
}
COLLECTION_CATALOG = {
    "root_folder_id": 500,
    "items": [COLLECTION_ITEM],
    "mappings": [COLLECTION_MAPPING],
    "work_groups": [{
        "id": 900,
        "key": "anchor:700",
        "group_key": "anchor:700",
        "title": "合集作品 A",
        "anchor": 700,
        "anchor_folder_id": 502,
        "manual_locked": 0,
        "item_ids": [700],
        "members": [],
        "summary": {
            "item_count": 1,
            "physical_folder_count": 1,
            "season_numbers": [1],
            "manual_count": 0,
            "conflict_count": 0,
            "unknown_count": 0,
        },
    }],
    "ungrouped_item_ids": [],
    "summary": {
        "root_folder_id": 500,
        "item_count": 1,
        "mapping_count": 1,
        "season_numbers": [1],
        "manual_count": 0,
        "conflict_count": 0,
        "unknown_count": 0,
    },
}
COLLECTION_ROOT = {
    **folder(500, "Fixture 合集", pinned=1),
    "children": [COLLECTION_CHILD],
    "files": [],
    "media_catalog": [{
        **COLLECTION_MAPPING,
        "series_title": "Fixture 合集",
        "series_key": "folder:500",
        "source": None,
        "external_id": None,
    }],
    "media_catalog_summary": {
        "root_folder_id": 500,
        "series_id": 1,
        "series_key": "folder:500",
        "series_title": "Fixture 合集",
        "entry_count": 1,
        "season_numbers": [1],
        "manual_count": 0,
        "conflict_count": 0,
        "unknown_count": 0,
    },
    "media_catalog_v2": COLLECTION_CATALOG,
    "media_catalog_candidates": [],
    "collection_artwork": [{"id": 502, "poster_version": "fixture"}],
    "collection_reset": {"snapshot_version": "fixture-v1"},
}
FILE_ITEM = {
    "id": 1,
    "folder_id": 501,
    "library_id": 1,
    "name": "Fixture Episode 01 [1080p].mkv",
    "path": "D:/Fixture/Anime/普通目录/Fixture Episode 01 [1080p].mkv",
    "size": 1_073_741_824,
    "date_modified": 1_788_739_200_000,
    "ext": ".mkv",
    "tags": [],
    "created_at": "2026-09-07T00:00:00.000Z",
    "updated_at": "2026-09-07T00:00:00.000Z",
}
NORMAL_FOLDER = {
    **folder(501, "普通目录"),
    "children": [],
    "files": [FILE_ITEM],
    "media_catalog": [],
    "media_catalog_summary": None,
    "media_catalog_v2": None,
    "media_catalog_candidates": [],
    "display_metadata_candidates": [{
        "id": 501,
        "name": "普通目录",
        "path": "D:/Fixture/Anime/普通目录",
        "kind": "self",
        "depth": 0,
        "hasMetadata": False,
    }],
}
LIBRARY = {
    "id": 1,
    "name": "Fixture Anime",
    "root_path": "D:/Fixture/Anime",
    "type": "anime",
    "everything_url": None,
    "created_at": "2026-09-07T00:00:00.000Z",
}
CALENDAR = {
    "season": "FALL",
    "year": 2026,
    "days": {day: [] for day in ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")},
    "favorites": [],
}
FAVORITES = [{
    "item_id": "fixture-favorite",
    "title": "Fixture Favorite",
    "title_zh": "心愿单示例",
    "air_day": "MON",
    "air_time": "20:00",
    "begin": "2026-10-01T12:00:00.000Z",
    "bangumi_id": None,
    "links": [],
    "image": None,
    "synopsis": "本地 fixture 简介。",
    "synopsis_original": None,
    "aired_episodes": 1,
    "total_episodes": 12,
    "air_status": "airing",
    "media_type": "anime",
    "lib_match_override": None,
    "lib_hit": None,
    "lib_status": "absent",
    "added_at": "2026-09-07T00:00:00.000Z",
}]


@dataclass
class FixtureState:
    settings: dict[str, str]
    wallpaper: str
    api_requests: list[str] = field(default_factory=list)
    settings_puts: list[dict[str, str]] = field(default_factory=list)
    background_requests: int = 0
    unmatched_api: list[str] = field(default_factory=list)
    blocked_nonlocal: list[str] = field(default_factory=list)


def fixture_settings(contrast: str, wallpaper: str, material: str) -> dict[str, str]:
    return {
        "background_type": "image",
        "background_path": f"fixture-{wallpaper}.svg",
        "background_dimmer": "0",
        "panel_material": material,
        "high_contrast_text": "1" if contrast == "high" else "0",
        "we_dirs": "",
    }


def fulfill_json(route: Route, value: Any, status: int = 200) -> None:
    route.fulfill(status=status, content_type="application/json; charset=utf-8", body=json.dumps(value, ensure_ascii=False))


def unexpected_nonlocal(urls: list[str]) -> list[str]:
    """The app imports Inter, but the isolation contract blocks even that known stylesheet."""
    return [url for url in urls if not url.startswith(EXPECTED_BLOCKED_FONT)]


def isolate(route: Route, state: FixtureState, local_origin: tuple[str, str]) -> None:
    request = route.request
    parsed = urlparse(request.url)
    if (parsed.scheme, parsed.netloc) != local_origin:
        state.blocked_nonlocal.append(request.url)
        route.abort("blockedbyclient")
        return

    path = parsed.path
    if not path.startswith("/api/"):
        route.continue_()
        return

    method = request.method.upper()
    state.api_requests.append(f"{method} {path}")
    if path == "/api/background/file" and method == "GET":
        state.background_requests += 1
        requested = parse_qs(parsed.query).get("p", [""])[0]
        shade = "white" if "white" in requested else "dark"
        route.fulfill(
            content_type="image/svg+xml",
            headers={"cache-control": "no-store"},
            body=SVG[shade],
        )
        return
    if re.fullmatch(r"/api/folders/\d+/poster", path) and method == "GET":
        route.fulfill(content_type="image/svg+xml", headers={"cache-control": "no-store"}, body=SVG["poster"])
        return
    if path == "/api/settings" and method == "GET":
        fulfill_json(route, state.settings)
        return
    if path == "/api/settings" and method == "PUT":
        body = request.post_data_json or {}
        if not isinstance(body, dict):
            fulfill_json(route, {"error": "Invalid fixture settings payload"}, 400)
            return
        update = {str(key): str(value) for key, value in body.items()}
        state.settings_puts.append(update)
        state.settings.update(update)
        fulfill_json(route, {"ok": True})
        return

    query = parse_qs(parsed.query)
    if path == "/api/folders" and method == "GET":
        rows = [COLLECTION_ROOT] if query.get("pinned") == ["1"] else [COLLECTION_ROOT, NORMAL_FOLDER]
        fulfill_json(route, rows)
        return
    if path == "/api/folders/500" and method == "GET":
        fulfill_json(route, COLLECTION_ROOT)
        return
    if path == "/api/folders/501" and method == "GET":
        fulfill_json(route, NORMAL_FOLDER)
        return
    if path == "/api/folders/500/collection-presentation" and method == "GET":
        fulfill_json(route, {"entries": []})
        return

    fixtures: dict[tuple[str, str], Any] = {
        ("/api/libraries", "GET"): [LIBRARY],
        ("/api/tags", "GET"): [],
        ("/api/files/1", "GET"): FILE_ITEM,
        ("/api/season/calendar", "GET"): CALENDAR,
        ("/api/season/favorites", "GET"): FAVORITES,
        ("/api/settings/system-info", "GET"): {
            "dataDir": "fixture",
            "databasePath": "fixture/animeshelf.db",
            "databaseSize": 0,
            "schemaVersion": 1,
            "healthy": True,
            "integrity": ["ok"],
        },
        ("/api/settings/backups", "GET"): {"backups": []},
        ("/api/settings/backups/poster-repair-status", "GET"): {
            "running": False,
            "total": 0,
            "processed": 0,
            "repaired": 0,
            "failed": 0,
            "done": True,
            "lastRun": 0,
        },
        ("/api/wallpapers", "GET"): [],
        ("/api/external-access", "GET"): {
            "enabled": False,
            "port": 3003,
            "status": "stopped",
            "base_url": "",
            "error": None,
            "tokens": [],
        },
    }
    marker = (path, method)
    if marker in fixtures:
        fulfill_json(route, fixtures[marker])
        return

    state.unmatched_api.append(f"{method} {path}")
    fulfill_json(route, {"error": f"Unmatched isolated fixture: {method} {path}"}, 500)


def color_parts(raw: str) -> tuple[float, float, float, float]:
    values = [float(value) for value in re.findall(r"[-+]?(?:\d*\.\d+|\d+)", raw)]
    if raw.startswith("rgba") and len(values) >= 4:
        return values[0], values[1], values[2], values[3]
    if raw.startswith("rgb") and len(values) >= 3:
        return values[0], values[1], values[2], 1.0
    raise AssertionError(f"Unsupported computed color: {raw!r}")


def visible_style(page: Page) -> dict[str, Any]:
    return page.evaluate("""() => {
      const visible = element => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const app = document.querySelector('[data-panel-material]')
      const header = document.querySelector('.page-header.ui-panel')
      const shell = document.querySelector('.page-shell')
      const secondary = header && [...header.querySelectorAll('.page-subtitle, [class~="text-text-secondary"]')].find(visible)
        || shell && [...shell.querySelectorAll('.page-subtitle, [class~="text-text-secondary"]')].find(visible)
      const lowSecondary = [...(shell || document).querySelectorAll('[class*="text-text-secondary/"]')]
        .filter(visible)
        .map(element => ({ color: getComputedStyle(element).color, className: element.className, text: (element.textContent || '').trim().slice(0, 80) }))
      const disabledButtons = [...document.querySelectorAll('button:disabled')].filter(visible)
      const disabled = disabledButtons.find(element => (element.textContent || '').trim()) || disabledButtons[0]
      if (!app || !header || !secondary) return { missing: { app: !app, header: !header, secondary: !secondary } }
      const hs = getComputedStyle(header)
      const rect = header.getBoundingClientRect()
      const h1 = header.querySelector('h1')
      const h1Rect = h1?.getBoundingClientRect()
      const main = document.querySelector('main')
      return {
        contrast: document.documentElement.getAttribute('data-text-contrast'),
        wallpaper: (() => { const image = document.querySelector('img[src^="/api/background/file"]'); return image ? { complete: image.complete, naturalWidth: image.naturalWidth, src: image.getAttribute('src') } : null })(),
        primary: getComputedStyle(shell || app).color,
        secondary: getComputedStyle(secondary).color,
        lowSecondary,
        header: {
          backgroundColor: hs.backgroundColor,
          backdropFilter: hs.backdropFilter || hs.webkitBackdropFilter,
          borderRadius: hs.borderRadius,
          rect: { left: rect.left, right: rect.right, width: rect.width },
          h1Rect: h1Rect ? { left: h1Rect.left, right: h1Rect.right, width: h1Rect.width } : null,
          h1Color: h1 ? getComputedStyle(h1).color : null,
        },
        h1Count: document.querySelectorAll('h1').length,
        h1Outside: [...document.querySelectorAll('h1')].filter(element => !element.closest('.page-header.ui-panel')).map(element => (element.textContent || '').trim()),
        overflow: {
          document: document.documentElement.scrollWidth > innerWidth + 1,
          body: document.body.scrollWidth > innerWidth + 1,
          mainX: Boolean(main && main.scrollWidth > main.clientWidth + 1),
          mainY: Boolean(main && main.scrollHeight > main.clientHeight + 1),
          shellX: Boolean(shell && shell.scrollWidth > shell.clientWidth + 1),
        },
        disabled: disabled ? {
          opacity: getComputedStyle(disabled).opacity,
          color: getComputedStyle(disabled).color,
          backgroundColor: getComputedStyle(disabled).backgroundColor,
          text: (disabled.textContent || '').trim().slice(0, 80),
        } : null,
        supportsMaxAlpha: CSS.supports('color', 'rgb(1 2 3 / max(.5, 1))'),
      }
    }""")


def screenshot(page: Page, output: Path, name: str) -> str:
    path = output / f"{name}.png"
    page.screenshot(path=str(path), full_page=False)
    return str(path)


def add_failure(failures: list[str], message: str, page: Page, output: Path, shot_name: str) -> None:
    path = screenshot(page, output, f"FAIL--{shot_name}")
    failures.append(f"{message}; screenshot={path}")


def new_context(browser: Browser, base: str, state: FixtureState) -> BrowserContext:
    parsed = urlparse(base)
    context = browser.new_context(viewport={"width": 1440, "height": 980}, reduced_motion="reduce")
    context.route("**/*", lambda route: isolate(route, state, (parsed.scheme, parsed.netloc)))
    return context


def verify_settings_behavior(browser: Browser, base: str, output: Path, failures: list[str]) -> None:
    # Default is normal, and the real checkbox save toggles the document attribute both ways.
    state = FixtureState(fixture_settings("normal", "white", "glass"), "white")
    state.settings.pop("high_contrast_text")
    context = new_context(browser, base, state)
    page = context.new_page()
    try:
        page.goto(f"{base}/settings#settings-appearance", wait_until="networkidle")
        expect(page.locator(".page-header.ui-panel")).to_be_visible()
        checkbox = page.get_by_role("checkbox", name=re.compile(r"^高对比度文字"))
        appearance = page.locator("#settings-appearance")
        if page.locator("html").get_attribute("data-text-contrast") != "normal" or checkbox.is_checked():
            add_failure(failures, "settings default: expected normal and unchecked", page, output, "settings-default")
        checkbox.check()
        expect(page.locator("html")).to_have_attribute("data-text-contrast", "high")
        appearance.get_by_role("button", name="保存", exact=True).click()
        expect(appearance.get_by_role("button", name="✓ 已保存", exact=True)).to_be_visible()
        if not state.settings_puts or state.settings_puts[-1].get("high_contrast_text") != "1":
            add_failure(failures, f"settings enable save: bad payload {state.settings_puts[-1:]}", page, output, "settings-enable")
        checkbox.uncheck()
        expect(page.locator("html")).to_have_attribute("data-text-contrast", "normal")
        appearance.get_by_role("button", name="保存", exact=True).click()
        expect(appearance.get_by_role("button", name="✓ 已保存", exact=True)).to_be_visible()
        if state.settings_puts[-1].get("high_contrast_text") != "0":
            add_failure(failures, f"settings disable save: bad payload {state.settings_puts[-1]}", page, output, "settings-disable")
    except Exception as error:  # Preserve a useful browser artifact instead of stopping at the first contract.
        add_failure(failures, f"settings real-checkbox flow: {error}", page, output, "settings-checkbox-exception")
    finally:
        if state.unmatched_api:
            failures.append(f"settings real-checkbox flow unmatched APIs: {state.unmatched_api}")
        if unexpected := unexpected_nonlocal(state.blocked_nonlocal):
            failures.append(f"settings real-checkbox flow attempted unexpected non-local requests: {unexpected}")
        context.close()

    # A legacy-only key remains effective on a background-only save, then an explicit off wins.
    legacy = fixture_settings("normal", "dark", "solid")
    legacy.pop("high_contrast_text")
    legacy["collection_high_contrast_text"] = "1"
    state = FixtureState(legacy, "dark")
    context = new_context(browser, base, state)
    page = context.new_page()
    try:
        page.goto(f"{base}/settings#settings-appearance", wait_until="networkidle")
        checkbox = page.get_by_role("checkbox", name=re.compile(r"^高对比度文字"))
        appearance = page.locator("#settings-appearance")
        expect(page.locator("html")).to_have_attribute("data-text-contrast", "high")
        expect(checkbox).to_be_checked()
        appearance.get_by_role("button", name="保存", exact=True).click()
        expect(appearance.get_by_role("button", name="✓ 已保存", exact=True)).to_be_visible()
        untouched = state.settings_puts[-1]
        if untouched.get("high_contrast_text") != "1" or state.settings.get("collection_high_contrast_text") != "1":
            add_failure(failures, f"legacy background save erased fallback: {untouched}", page, output, "settings-legacy-save")
        checkbox.uncheck()
        appearance.get_by_role("button", name="保存", exact=True).click()
        expect(appearance.get_by_role("button", name="✓ 已保存", exact=True)).to_be_visible()
        if state.settings_puts[-1].get("high_contrast_text") != "0":
            add_failure(failures, f"legacy explicit disable did not write 0: {state.settings_puts[-1]}", page, output, "settings-legacy-disable")
        expect(page.locator("html")).to_have_attribute("data-text-contrast", "normal")
    except Exception as error:
        add_failure(failures, f"settings legacy flow: {error}", page, output, "settings-legacy-exception")
    finally:
        if state.unmatched_api:
            failures.append(f"settings legacy flow unmatched APIs: {state.unmatched_api}")
        if unexpected := unexpected_nonlocal(state.blocked_nonlocal):
            failures.append(f"settings legacy flow attempted unexpected non-local requests: {unexpected}")
        context.close()


def verify_pages(browser: Browser, base: str, output: Path, geometry_only: bool) -> tuple[list[str], dict[str, Any]]:
    failures: list[str] = []
    readings: dict[tuple[str, str, str, int, str], dict[str, Any]] = {}
    material_fingerprints: dict[str, dict[str, str]] = {}
    low_token_counts = {"normal": 0, "high": 0}
    background_requests = 0
    blocked_nonlocal_requests = 0
    page_checks = 0

    for scenario, contrast, wallpaper, material in SCENARIOS:
        state = FixtureState(fixture_settings(contrast, wallpaper, material), wallpaper)
        context = new_context(browser, base, state)
        page = context.new_page()
        page_errors: list[str] = []
        console_errors: list[str] = []
        page.on("pageerror", lambda error, rows=page_errors: rows.append(str(error)))
        page.on("console", lambda message, rows=console_errors: rows.append(message.text) if message.type == "error" else None)
        for route_slug, route_path in ROUTES:
            try:
                page.set_viewport_size({"width": WIDTHS[0][0], "height": WIDTHS[0][1]})
                page.goto(f"{base}{route_path}", wait_until="networkidle")
                expect(page.locator(".page-header.ui-panel")).to_be_visible(timeout=5_000)
                for width, height in WIDTHS:
                    page.set_viewport_size({"width": width, "height": height})
                    # Reduced-motion mode intentionally keeps 100ms color/opacity transitions.
                    # Sample only after those transitions settle so widths are comparable.
                    page.wait_for_timeout(140)
                    style = visible_style(page)
                    page_checks += 1
                    marker = f"{scenario} route={route_path} viewport={width}x{height}"
                    shot_slug = f"{scenario}--{route_slug}--{width}"
                    problems: list[str] = []
                    if style.get("missing"):
                        problems.append(f"missing required rendered nodes {style['missing']}")
                    else:
                        if style["contrast"] != contrast:
                            problems.append(f"contrast={style['contrast']!r}, expected {contrast!r}")
                        if style["h1Count"] < 1 or style["h1Outside"]:
                            problems.append(f"h1Count={style['h1Count']} h1Outside={style['h1Outside']}")
                        wallpaper_state = style["wallpaper"]
                        if not wallpaper_state or not wallpaper_state["complete"] or wallpaper_state["naturalWidth"] <= 0 or wallpaper not in wallpaper_state["src"]:
                            problems.append(f"wallpaper did not render through /api/background/file: {wallpaper_state}")
                        header_color = color_parts(style["header"]["backgroundColor"])
                        if header_color[3] <= 0 or max(header_color[:3]) <= 0:
                            problems.append(f"page header background is transparent/non-gray: {header_color}")
                        header_rect = style["header"]["rect"]
                        h1_rect = style["header"]["h1Rect"]
                        if header_rect["left"] < -1 or header_rect["right"] > width + 1 or header_rect["width"] <= 0:
                            problems.append(f"page header is outside viewport: {header_rect}")
                        if not h1_rect or h1_rect["left"] < header_rect["left"] - 1 or h1_rect["right"] > header_rect["right"] + 1:
                            problems.append(f"h1 is outside its page header: {h1_rect}")
                        overflow = style["overflow"]
                        if overflow["document"] or overflow["body"] or overflow["mainX"] or overflow["shellX"]:
                            problems.append(f"horizontal overflow: {overflow}")
                        if overflow["mainY"]:
                            problems.append(f"main has extra outer scrolling: {overflow}")
                        material_style = {
                            "backgroundColor": style["header"]["backgroundColor"],
                            "backdropFilter": style["header"]["backdropFilter"],
                        }
                        expected_fingerprint = material_fingerprints.setdefault(scenario, material_style)
                        if material_style != expected_fingerprint:
                            problems.append(f"title material differs: expected {expected_fingerprint}, got {material_style}")
                        if material == "solid":
                            if header_color[3] < 0.95 or "blur(0px)" not in style["header"]["backdropFilter"]:
                                problems.append(f"solid title material not solid: color={header_color}, filter={style['header']['backdropFilter']!r}")
                        elif header_color[3] >= 0.95 or "blur(22px)" not in style["header"]["backdropFilter"]:
                            problems.append(f"glass title material not glass: color={header_color}, filter={style['header']['backdropFilter']!r}")
                        if not geometry_only:
                            if not style["supportsMaxAlpha"]:
                                problems.append("Chrome does not report CSS max() alpha support")
                            low_tokens = style["lowSecondary"]
                            low_token_counts[contrast] += len(low_tokens)
                            if contrast == "high":
                                bad = [token for token in low_tokens if color_parts(token["color"])[3] < 0.99]
                                if bad:
                                    problems.append(f"high secondary alpha floor failed: {bad[:3]}")
                            readings[(wallpaper, material, route_path, width, contrast)] = {
                                "primary": color_parts(style["primary"]),
                                "secondary": color_parts(style["secondary"]),
                                "disabled": style["disabled"],
                            }
                    if width in (1440, 320):
                        screenshot(page, output, shot_slug)
                    if problems:
                        add_failure(failures, f"{marker}: {'; '.join(problems)}", page, output, shot_slug)
            except Exception as error:
                add_failure(
                    failures,
                    f"{scenario} route={route_path} viewport={page.viewport_size}: {error}",
                    page,
                    output,
                    f"{scenario}--{route_slug}--exception",
                )
        background_requests += state.background_requests
        if state.background_requests < len(ROUTES):
            failures.append(f"{scenario}: only {state.background_requests} background fixture requests for {len(ROUTES)} routes")
        if state.unmatched_api:
            failures.append(f"{scenario}: unmatched isolated APIs {state.unmatched_api}")
        blocked_nonlocal_requests += len(state.blocked_nonlocal)
        if unexpected := unexpected_nonlocal(state.blocked_nonlocal):
            failures.append(f"{scenario}: attempted unexpected non-local requests {unexpected}")
        if page_errors:
            failures.append(f"{scenario}: page errors {page_errors}")
        unexpected_console = [message for message in console_errors if "ERR_BLOCKED_BY_CLIENT" not in message]
        if unexpected_console:
            failures.append(f"{scenario}: console errors {unexpected_console}")
        context.close()

    if not geometry_only:
        if low_token_counts["normal"] == 0 or low_token_counts["high"] == 0:
            failures.append(f"secondary alpha token coverage missing: {low_token_counts}")
        for wallpaper, material in (("white", "glass"), ("dark", "solid")):
            for _, route_path in ROUTES:
                for width, _ in WIDTHS:
                    normal = readings.get((wallpaper, material, route_path, width, "normal"))
                    high = readings.get((wallpaper, material, route_path, width, "high"))
                    if not normal or not high:
                        failures.append(f"contrast pair missing: wallpaper={wallpaper} material={material} route={route_path} viewport={width}")
                        continue
                    primary_rise = all(high["primary"][index] > normal["primary"][index] for index in range(3))
                    secondary_rise = all(high["secondary"][index] > normal["secondary"][index] for index in range(3))
                    if not primary_rise or not secondary_rise or high["secondary"][3] < normal["secondary"][3]:
                        failures.append(
                            f"contrast did not rise: wallpaper={wallpaper} material={material} route={route_path} viewport={width} "
                            f"primary {normal['primary']} -> {high['primary']}, secondary {normal['secondary']} -> {high['secondary']}"
                        )
                    if route_path == "/favorites" and normal["disabled"] and high["disabled"]:
                        normal_disabled = normal["disabled"]
                        high_disabled = high["disabled"]
                        if float(high_disabled["opacity"]) >= 0.9:
                            failures.append(f"disabled opacity lost: material={material} viewport={width} style={high_disabled}")
                        if abs(float(normal_disabled["opacity"]) - float(high_disabled["opacity"])) > 0.02 or normal_disabled["backgroundColor"] != high_disabled["backgroundColor"]:
                            failures.append(
                                f"disabled/state styling changed: material={material} viewport={width} "
                                f"normal={normal_disabled}, high={high_disabled}"
                            )

    return failures, {
        "page_checks": page_checks,
        "background_fixture_requests": background_requests,
        "blocked_nonlocal_requests": blocked_nonlocal_requests,
        "low_opacity_token_samples": low_token_counts,
        "screenshots": str(output),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify all AnimeShelf page title surfaces and global text contrast with isolated Playwright fixtures.")
    parser.add_argument("--url", default="http://127.0.0.1:5173", help="Existing Vite origin (default: %(default)s)")
    parser.add_argument("--output", default="data/.verification/page-appearance", help="Screenshot directory (default: %(default)s)")
    parser.add_argument("--geometry-only", action="store_true", help="Temporarily skip cross-mode color, Settings save, and portal checks")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        page_failures, summary = verify_pages(browser, base, output, args.geometry_only)
        failures.extend(page_failures)
        if not args.geometry_only:
            verify_settings_behavior(browser, base, output, failures)
        browser.close()

    if failures:
        print(f"FAIL: {len(failures)} isolated appearance checks failed")
        for failure in failures:
            print(f"  - {failure}")
        print(json.dumps({**summary, "ok": False, "failure_count": len(failures)}, ensure_ascii=False))
        raise SystemExit(1)

    print("PASS: isolated page appearance verification")
    print(json.dumps({**summary, "ok": True, "geometry_only": args.geometry_only}, ensure_ascii=False))


if __name__ == "__main__":
    main()


