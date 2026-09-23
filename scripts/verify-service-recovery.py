"""Exercise the real UI against isolated, temporarily unavailable read endpoints."""
from __future__ import annotations

import argparse
from collections import Counter
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


LIBRARY = {
    "id": 1, "name": "Recovery library", "root_path": "X:/fixture", "type": "anime",
    "everything_url": None, "created_at": "2026-01-01",
}
FOLDER = {
    "id": 1, "library_id": 1, "parent_id": None, "name": "Recovery series",
    "path": "X:/fixture/series", "is_series": 1, "anilist_id": None, "has_poster": 0,
    "size": 1024, "file_count": 1, "tags": [], "library_name": LIBRARY["name"],
    "created_at": "2026-01-01", "updated_at": "2026-01-01",
}
MODULES = {
    "modules": [{
        "id": "wallpapers", "name": "背景与壁纸", "version": "1.0.0", "requires": [],
        "optional": [], "pages": [], "defaultEnabled": True, "configuredEnabled": True,
        "active": True, "reason": None,
    }, {
        "id": "media-catalog", "name": "合集与作品清单", "version": "1.0.0", "requires": [],
        "optional": [], "pages": [], "defaultEnabled": True, "configuredEnabled": True,
        "active": True, "reason": None,
    }],
    "restartRequired": False,
}
SETTINGS = {
    "background_type": "image", "background_path": "X:/fixture/background.svg",
    "background_dimmer": "0.5", "color_theme": "light", "panel_material": "solid",
}


def scenario(browser, base, failures, *, resume=False, route="/all", late_failure=False, preview=False):
    context = browser.new_context(viewport={"width": 1440, "height": 960})
    calls = Counter()
    writes = []
    failures_left = dict(failures)
    origin = urlparse(base).netloc

    def isolate(intercept):
        request = intercept.request
        url = urlparse(request.url)
        if url.netloc != origin:
            intercept.abort()
            return
        if not url.path.startswith("/api/"):
            intercept.continue_()
            return
        key = url.path + ("?pinned=1" if url.query == "pinned=1" else "")
        calls[key] += 1
        if request.method != "GET":
            writes.append((request.method, url.path))
            intercept.fulfill(status=405, json={"error": "Unexpected mutation"})
            return
        if failures_left.get(key, 0) > 0:
            failures_left[key] -= 1
            if calls[key] % 2:
                intercept.fulfill(status=500, content_type="text/plain", body="")
            else:
                intercept.abort("connectionrefused")
            return
        if url.path == "/api/background/file":
            intercept.fulfill(content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#5683a0"/></svg>')
            return
        fixtures = {
            "/api/modules": MODULES, "/api/libraries": [LIBRARY], "/api/settings": SETTINGS,
            "/api/folders": [FOLDER], "/api/tags": [],
            "/api/folders?pinned=1": [{**FOLDER, "id": 2, "name": "Recovery collection", "pinned": 1}],
            "/api/wallpapers": [], "/api/settings/system-info": {},
        }
        if key not in fixtures:
            raise AssertionError(f"Unexpected API read: {url.path}")
        intercept.fulfill(json=fixtures[key])

    context.route("**/*", isolate)
    if resume:
        context.add_init_script("Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'})")
    page = context.new_page()
    documents = []
    page.on("request", lambda request: documents.append(request.url) if request.resource_type == "document" else None)
    try:
        page.goto(base + route, wait_until="networkidle")
        # The baseline displays media but never repairs the failed shell reads.
        if resume:
            page.evaluate("""() => {
                Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'});
                document.dispatchEvent(new Event('visibilitychange'));
                window.dispatchEvent(new Event('focus'));
                window.dispatchEvent(new Event('online'));
            }""")
        expect(page.locator('aside a[href="/library/1"]')).to_have_text("Recovery library", timeout=15000)
        if preview:
            wallpaper_settings = page.locator('#settings-wallpapers')
            wallpaper_settings.get_by_role('button', name='图片', exact=True).click()
            wallpaper_settings.get_by_label('文件路径（本地绝对路径）').fill('X:/fixture/new-preview.svg')
            failures_left['/api/settings'] = 0
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(page.locator('html')).to_have_attribute('data-theme', 'light', timeout=15000)
            expect(page.locator('img[src^="/api/background/file"]')).to_have_attribute(
                'src', '/api/background/file?p=X%3A%2Ffixture%2Fnew-preview.svg')
            assert not writes, writes
            assert len(documents) == 1, documents
            print('PASS pending appearance recovery preserves a newer unsaved preview', flush=True)
            return
        expect(page.locator('aside a[href="/folder/2"]')).to_have_text("Recovery collection", timeout=15000)
        expect(page.locator("tbody")).to_contain_text("Recovery series", timeout=15000)
        expect(page.locator("html")).to_have_attribute("data-theme", "light")
        background = page.locator('img[src^="/api/background/file"]')
        expect(background).to_be_visible()
        page.wait_for_function("""() => {
            const image = document.querySelector('img[src^="/api/background/file"]');
            return image && image.complete && image.naturalWidth > 0;
        }""")
        expected_route = "/library/1" if route == "/" else route
        expect(page).to_have_url(base + expected_route)
        # Recover in place, retaining current browsing input across resume events.
        search = page.get_by_placeholder("搜索名称或路径")
        if late_failure:
            failures_left['/api/folders'] = 2
            page.evaluate("Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'})")
        search.fill("Recovery")
        if late_failure:
            expect(page.get_by_role("status")).to_contain_text("正在自动重试")
            expect(page.locator('aside a[href="/library/1"]')).to_have_text("Recovery library")
            expect(background).to_be_visible()
            page.evaluate("""() => {
                Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'});
                document.dispatchEvent(new Event('visibilitychange'));
            }""")
        expect(page.locator("tbody")).to_contain_text("Recovery series")
        expect(page.get_by_role("status")).to_have_count(0, timeout=15000)
        page.evaluate("window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online'))")
        expect(search).to_have_value("Recovery")
        assert len(documents) == 1, documents
        assert not writes, writes
        print(f"PASS route={route} resume={resume} late={late_failure} failed={list(failures)} calls={dict(calls)}", flush=True)
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:5197")
    parser.add_argument("--case", choices=['all', 'pinned', 'preview'], default='all')
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe", headless=True)
        try:
            if args.case == 'all':
                scenario(browser, args.base, {"/api/libraries": 3, "/api/settings": 3}, resume=True)
                scenario(browser, args.base, {"/api/modules": 3})
                scenario(browser, args.base, {"/api/folders": 3, "/api/tags": 3})
                scenario(browser, args.base, {"/api/libraries": 3, "/api/settings": 3}, route="/")
                scenario(browser, args.base, {}, late_failure=True)
            if args.case in ['all', 'pinned']:
                scenario(browser, args.base, {'/api/folders?pinned=1': 3})
            if args.case in ['all', 'preview']:
                scenario(browser, args.base, {'/api/settings': 100}, route='/settings', preview=True)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
