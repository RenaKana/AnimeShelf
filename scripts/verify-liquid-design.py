"""Desktop dual-design acceptance; all API calls are intercepted in memory.

Reuses the page-appearance fixtures. No backend, provider, filesystem operation,
mobile build, or real database writes. Local poster files are read only.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("appearance_fixtures", Path(__file__).with_name("verify-page-appearance.py"))
fixtures = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fixtures
spec.loader.exec_module(fixtures)

ROUTES = [("library", "/all"), ("wishlist", "/favorites"), ("collection", "/folder/500"),
          ("detail", "/folder/501"), ("file", "/file/1"),
          ("season", "/season"), ("download", "/download"), ("settings", "/settings")]
TITLES = ["葬送的芙莉莲", "紫罗兰永恒花园", "夏目友人帐", "跃动青春", "凉宫春日的消失", "来自深渊",
          "星际牛仔", "冰菓", "四叠半神话大系", "命运石之门", "声之形", "吹响吧！上低音号"]


def context_for(browser, base, *, design=None, theme="dark", material="glass", contrast="normal", width=1440, height=900, wallpaper=False, count=24):
    settings = fixtures.fixture_settings(contrast, "white", material)
    settings.update(color_theme=theme, background_type="image" if wallpaper else "solid")
    state = fixtures.FixtureState(settings, "white")
    state.writes = []
    modules = [{**json.loads(path.read_text(encoding="utf-8")), "configuredEnabled": True, "active": True, "reason": None}
               for path in sorted((ROOT / "modules").glob("*/manifest.json"))]
    state.modules = modules
    state.rows = [{**fixtures.folder(1000+i, TITLES[i % len(TITLES)] + (f" · {i+1}" if i >= 12 else "")),
                   "has_poster": 0 if i == 4 else 1, "year": 2020+i % 7, "rating": 7.5+i % 3/2,
                   "synopsis": ("在漫长的旅途中，新的相遇与旧日的回忆交织成故事。" * (80 if i == 0 else 5)),
                   "tags": [{"id": 1, "name": "状态:在看", "kind": "status"}] if i % 3 == 0 else []}
                  for i in range(count)]
    state.detail = {**copy.deepcopy(fixtures.NORMAL_FOLDER), "name": "葬送的芙莉莲：旅途之后的漫长故事与新的相遇",
                    "synopsis": "在漫长的旅途中，新的相遇与旧日的回忆交织成故事。\n" * 100}
    state.favorites = [{**fixtures.FAVORITES[0], "item_id": f"fixture-{i}", "title": title, "title_zh": title,
                        "image": f"{base}/api/folders/{1000+i}/poster", "synopsis": state.rows[i % len(state.rows)]["synopsis"]}
                       for i, title in enumerate(TITLES)]
    posters = sorted((ROOT / "data" / "posters").glob("al_*.jpg"))[:30]
    origin = urlparse(base)
    context = browser.new_context(viewport={"width": width, "height": height})
    def isolate(route):
        req, url = route.request, urlparse(route.request.url)
        if (url.scheme, url.netloc) != (origin.scheme, origin.netloc):
            route.abort("blockedbyclient")
            return
        path, method = url.path, req.method
        if not path.startswith("/api/"):
            route.continue_()
            return
        if method != "GET":
            state.writes.append(f"{method} {path}")
        if re.fullmatch(r"/api/folders/\d+/poster", path) and posters:
            route.fulfill(path=str(posters[int(path.split('/')[3]) % len(posters)]), content_type="image/jpeg")
            return
        extra = {
            "/api/modules": {"modules": state.modules, "restartRequired": False},
            "/api/health": {"status": "ok", "instanceId": "liquid-fixture", "port": 3002},
            "/api/folders": [fixtures.COLLECTION_ROOT] if 'pinned=1' in url.query else state.rows,
            "/api/folders/501": state.detail,
            "/api/folders/502": {**fixtures.NORMAL_FOLDER, **fixtures.COLLECTION_CHILD},
            "/api/season/favorites": state.favorites,
            "/api/tags": [{"id": 1, "name": "状态:在看", "kind": "status"}, {"id": 2, "name": "治愈", "kind": "custom"}],
            "/api/folders/500/collection-organization": {"revision": 0, "organization": {"version": 1, "orderSource": "existing", "watchEntries": [{"id": "watch:item:local:502", "targetKey": "item:local:502"}], "groups": []}},
            "/api/libraries/scan-status": {"instanceId": "liquid-fixture", "revision": 0, "libraries": []},
            "/api/settings/backups/poster-repair-status": None,
            "/api/download/sources": {"sources": [{"id": "dmhy", "name": "动漫花园", "url": "", "configured": False, "enabled": False, "revision": "fixture"}]},
            "/api/download/resources": {"source": "dmhy", "resources": [], "nextCursor": None, "status": {"kind": "success", "message": "隔离数据"}},
        }
        if method == "GET" and path in extra:
            fixtures.fulfill_json(route, extra[path])
            return
        fixtures.isolate(route, state, (origin.scheme, origin.netloc))
    context.route("**/*", isolate)
    pref = {"animeshelf.view": "poster", "animeshelf.favorite-view": "posters", "wall-card-width": "190"}
    if design is not None:
        pref["animeshelf.ui-design"] = design
    context.add_init_script("for (const [key,value] of Object.entries("+json.dumps(pref)+")) { if (localStorage.getItem(key) === null) localStorage.setItem(key,value) }")
    return context, state


def capture(browser, args):
    context, state = context_for(browser, args.base, design=args.design, theme=args.theme, width=args.width, height=args.height)
    errors = []
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(error.stack))
    try:
        for name, path in ROUTES:
            if args.only and name not in args.only.split(','):
                continue
            page.goto(args.base+path, wait_until="domcontentloaded")
            expect(page.locator("h1").first).to_be_visible(timeout=20000)
            if name == 'settings':
                page.locator('#settings-appearance').scroll_into_view_if_needed()
            page.locator("img").evaluate_all("""els => Promise.all(els.filter(el => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
            }).map(el => el.complete ? Promise.resolve() : new Promise(resolve => {
                const timer = setTimeout(resolve, 5000);
                const finish = () => { clearTimeout(timer); resolve(); };
                el.addEventListener('load', finish, {once: true});
                el.addEventListener('error', finish, {once: true});
            })))""")
            page.locator('.ui-segmented-indicator').evaluate_all("els => Promise.all(els.flatMap(el => el.getAnimations()).map(animation => animation.finished.catch(() => {})))")
            page.locator('.sidebar-link[aria-current="page"]').evaluate_all("els => Promise.all(els.flatMap(el => el.getAnimations()).map(animation => animation.finished.catch(() => {})))")
            page.screenshot(path=str(args.output / f"{args.design}-{name}-{args.width}.png"))
            print("CAPTURE", name, flush=True)
        print(json.dumps({"writes": state.writes, "errors": errors, "unmatched": state.unmatched_api}, ensure_ascii=False))
        assert not errors, errors
        assert not state.unmatched_api, state.unmatched_api
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:5173")
    parser.add_argument("--design", default="classic")
    parser.add_argument("--theme", default="dark")
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--only", default="")
    parser.add_argument("--preview", action="store_true", help="Leave an isolated, interactive Chrome preview open until its window is closed")
    parser.add_argument("--output", type=Path, default=ROOT / ".artifacts/liquid-design/baseline")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=fixtures.CHROME, headless=not args.preview)
        try:
            if args.preview:
                context, state = context_for(browser, args.base, design=args.design, theme=args.theme)
                page = context.new_page()
                page.goto(args.base + '/all', wait_until='domcontentloaded')
                expect(page.locator('h1').first).to_be_visible()
                print('PREVIEW READY — isolated browser; all APIs are fixtures; close the window to finish.', flush=True)
                while browser.is_connected() and context.pages:
                    try:
                        context.pages[0].wait_for_timeout(1000)
                    except Exception:
                        break
            else:
                capture(browser, args)
        finally:
            browser.close()


if __name__ == "__main__":
    main()

