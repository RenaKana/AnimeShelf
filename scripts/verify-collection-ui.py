"""Exercise the real React app with isolated HTTP fixtures; never mutate a real catalog."""
import json
import copy
import re
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding="utf-8")
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
OUT = Path("data/.verification/collection-navigation")
OUT.mkdir(parents=True, exist_ok=True)


def folder(fid, name, pinned=0):
    return dict(id=fid, library_id=1, parent_id=None if pinned else 500, name=name,
                path=f"D:/Anime/Monogatari/{name}", pinned=pinned, is_series=1, anilist_id=None,
                has_poster=1, poster_version="fixture", size=1024, file_count=12, tags=[],
                created_at="2026-09-07", updated_at="2026-09-07", children=[], files=[],
                media_catalog=[], media_catalog_summary=None, media_catalog_v2=None,
                media_catalog_candidates=[])


root = folder(500, "物语系列", 1)
names = {1: "1化物语", 2: "2伪物语", 10: "10终物语", 12: "伤物语 I 铁血篇", 13: "伤物语 II 热血篇", 14: "伤物语 III 冷血篇"}
folders = {fid: folder(fid, name) for fid, name in names.items()}
folders[22] = folder(22, "伪物语 BD 2160p")
root["children"] = [row for row in folders.values() if row["id"] != 13]
root["collection_artwork"] = [{"id": fid, "poster_version": "fixture"} for fid in folders]
root["collection_reset"] = {"snapshot_version": "fixture-v1"}
items = [dict(id=fid, library_id=1, root_folder_id=500, item_key=f"local:{fid}", title=name,
              title_zh=None, kind="movie" if fid >= 12 else "unknown", season_number=None,
              part_number=None, manual_locked=0, confidence=.8, conflict_reason=None, source_ids=[])
         for fid, name in names.items()]
mappings = [dict(id=fid, folder_id=fid, media_item_id=fid, root_folder_id=500, series_id=1,
                 content_role="main", kind="movie" if fid >= 12 else "unknown", season_number=None,
                 part_number=None, folder_name=name, folder_path=f"D:/Anime/Monogatari/{name}",
                 manual_locked=0, confidence=.8, conflict_reason=None, detected_by="fixture")
            for fid, name in names.items()]
mappings.append({**mappings[1], "id": 22, "folder_id": 22, "folder_name": "伪物语 BD 2160p"})


def group(gid, title, ids):
    return dict(id=gid, key=f"anchor:{gid}", group_key=f"anchor:{gid}", title=title, anchor=gid,
                anchor_folder_id=gid, manual_locked=0, item_ids=ids, members=[],
                summary=dict(item_count=len(ids), physical_folder_count=len(ids), season_numbers=[],
                             manual_count=0, conflict_count=0, unknown_count=0))


catalog = dict(root_folder_id=500, items=items, mappings=mappings,
               work_groups=[group(10, names[10], [10]), group(1, names[1], [1]), group(2, names[2], [2]), group(12, "12伤物语", [12, 13, 14])],
               ungrouped_item_ids=[], summary=dict(root_folder_id=500, item_count=6, mapping_count=7,
               season_numbers=[], manual_count=0, conflict_count=0, unknown_count=3))
root["media_catalog_v2"] = catalog
initial_catalog = copy.deepcopy(catalog)
root["media_catalog_candidates"] = [dict(folder_id=88, folder_name="OVA", folder_path="D:/Anime/Monogatari/OVA", suggested_kind="ova", suggested_season_numbers=[], suggested_part_number=None, confidence=.8, reason="excluded", source=None, external_id=None)]
prefs = {}
writes = []
unexpected = []
fail_next_patch = [True]
fail_next_preferences = [2]  # React StrictMode mounts the initial request twice.
fail_next_reset = [True]
fixture_settings = {"panel_material": "solid"}


def route_api(route):
    req = route.request
    path = urlparse(req.url).path
    value = []
    if req.method != "GET":
        writes.append((path, req.post_data_json))
    if path == "/api/background/file":
        route.fulfill(content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="980"><rect width="1440" height="980" fill="white"/></svg>')
        return
    if path.endswith("/poster"):
        route.fulfill(content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="90" height="130"><rect width="90" height="130" fill="#4f526f"/><path d="M0 130L90 25V130" fill="#777d95"/><circle cx="35" cy="38" r="16" fill="#d6c0b4"/></svg>')
        return
    if path == "/api/settings":
        if req.method == "PUT":
            fixture_settings.update(req.post_data_json)
        value = fixture_settings
    elif path == "/api/settings/system-info":
        value = {"healthy": True, "integrity": ["ok"], "databasePath": "fixture", "databaseSize": 0, "schemaVersion": 1}
    elif path == "/api/settings/backups":
        value = {"backups": []}
    elif path == "/api/libraries":
        value = [dict(id=1, name="Anime", root_path="D:/Anime", type="anime", everything_url=None, created_at="2026-09-07")]
    elif path == "/api/folders":
        value = [root]
    elif path.endswith("/collection-presentation"):
        if req.method == "GET" and fail_next_preferences[0]:
            fail_next_preferences[0] -= 1
            route.fulfill(status=503, json={"error": "展示设置暂不可用"})
            return
        if req.method == "PATCH":
            if fail_next_patch[0]:
                fail_next_patch[0] = False
                route.fulfill(status=409, json={"error": "目录数据已变化，请刷新后重试"})
                return
            for update in req.post_data_json["updates"]:
                prefs.setdefault(update["key"], dict(key=update["key"], title=None, position=None)).update(update)
        value = {"entries": list(prefs.values())}
    elif path.startswith("/api/folders/500/collection-members/"):
        item_id = int(path.split("/")[-2])
        group_id = req.post_data_json["groupId"]
        for row in catalog["work_groups"]:
            row["item_ids"] = [i for i in row["item_ids"] if i != item_id]
            if row["id"] == group_id:
                row["item_ids"].append(item_id)
        catalog["work_groups"] = [row for row in catalog["work_groups"] if row["item_ids"]]
        value = root
    elif path == "/api/folders/500/collection-reset":
        assert req.post_data_json == {"confirm": True, "expected_snapshot_version": root["collection_reset"]["snapshot_version"]}
        if fail_next_reset[0]:
            fail_next_reset[0] = False
            root["collection_reset"]["snapshot_version"] = "fixture-v2"
            route.fulfill(status=409, json={"error": "合集内容已变化，请刷新后重新确认", "code": "COLLECTION_RESET_STALE"})
            return
        prefs.clear()
        catalog.clear()
        catalog.update(copy.deepcopy(initial_catalog))
        value = {"collection_reset": {"root_folder_id": 500, "before_snapshot_version": "fixture-v2", "after_snapshot_version": "fixture-v3"}}
        root["collection_reset"]["snapshot_version"] = "fixture-v3"
    elif path.endswith("/media-catalog") and req.method == "PUT":
        folder_id = int(path.split("/")[-2])
        body = req.post_data_json
        for mapping in catalog["mappings"]:
            if mapping["folder_id"] == folder_id:
                mapping.update(kind=body.get("kind", "unknown"), custom_label=body.get("customLabel"), season_number=(body.get("seasonNumbers") or [None])[0])
                for item in catalog["items"]:
                    if item["id"] == mapping["media_item_id"]:
                        item.update(kind=mapping["kind"], custom_label=mapping["custom_label"])
        value = root
    elif re.fullmatch(r"/api/folders/\d+", path):
        fid = int(path.rsplit("/", 1)[1])
        value = root if fid == 500 else folders.get(fid, folder(fid, "普通番剧"))
        if fid != 500:
            # The API deliberately returns the owning catalog even for descendants.
            value = {**value, "media_catalog_v2": catalog,
                     "media_catalog_summary": {"root_folder_id": 500, "season_numbers": [], "entry_count": len(mappings)},
                     "media_catalog": [{**row, "series_title": "物语系列", "series_key": "folder:500", "source": None, "external_id": None} for row in mappings],
                     "media_catalog_candidates": root["media_catalog_candidates"]}
    elif req.method != "GET":
        unexpected.append(path)
        route.fulfill(status=400, json={"error": "Unexpected fixture mutation"})
        return
    route.fulfill(json=value)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe")
    context = browser.new_context(viewport={"width": 1440, "height": 980}, reduced_motion="reduce")
    context.route("**/api/**", route_api)
    context.route(re.compile(r"https://.*"), lambda route: route.abort())
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(f"{BASE}/folder/500", wait_until="networkidle")
    expect(page.get_by_role("heading", name="物语系列", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="打开1化物语", exact=True)).to_be_visible()
    page.get_by_role("button", name="重试加载显示设置", exact=True).click()
    expect(page.get_by_text("显示设置加载失败：展示设置暂不可用", exact=True)).to_have_count(0)
    assert page.locator(".collection-work-title").all_text_contents()[:3] == ["1化物语", "2伪物语", "10终物语"]
    assert page.get_by_text("未指定季号").count() == 0
    page.locator(".collection-group-heading").click()
    expect(page.get_by_text("伤物语 I 铁血篇", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="打开伤物语 II 热血篇", exact=True).locator("img")).to_have_attribute("src", "/api/folders/13/poster?v=fixture")
    page.locator(".collection-versions>summary").click()
    expect(page.get_by_role("button", name="伪物语 BD 2160p", exact=True)).to_be_visible()
    for width in [1440, 1024, 768, 390, 320]:
        page.set_viewport_size({"width": width, "height": 980})
        page.screenshot(path=str(OUT / f"collection-{width}.png"), full_page=True)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"horizontal overflow {width}"
        assert page.locator("main").evaluate("el => el.scrollHeight <= el.clientHeight + 1"), f"outer scrolling {width}"
    page.set_viewport_size({"width": 1440, "height": 980})
    page.get_by_role("button", name="管理", exact=True).click()
    page.get_by_role("button", name="调整作品：1化物语", exact=True).click()
    dialog = page.get_by_role("dialog")
    expect(dialog.get_by_text("不会重命名磁盘文件夹。")).to_be_visible()
    dialog.get_by_label("显示名称", exact=True).fill("化物语 · 收藏版")
    dialog.get_by_role("button", name="保存名称", exact=True).click()
    expect(dialog.get_by_text("目录数据已变化，请刷新后重试", exact=True)).to_be_visible()
    # A committed mutation is not a failed save when its follow-up read fails.
    fail_next_preferences[0] = 1
    dialog.get_by_role("button", name="保存名称", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    expect(page.get_by_role("alert")).to_contain_text("已保存，但刷新显示失败")
    expect(page.get_by_role("button", name="添加作品", exact=True)).to_be_disabled()
    writes_after_save = len(writes)
    page.get_by_role("button", name="重试加载显示设置", exact=True).click()
    expect(page.get_by_role("button", name="打开化物语 · 收藏版")).to_be_visible()
    assert len(writes) == writes_after_save, "Refreshing a committed save must not replay it"
    assert writes[-1][0].endswith("collection-presentation")
    assert folders[1]["name"] == "1化物语"
    page.get_by_role("button", name="下移化物语 · 收藏版", exact=True).click()
    expect(page.locator(".collection-work-title").first).to_have_text("2伪物语")
    page.reload(wait_until="networkidle")
    expect(page.locator(".collection-work-title").first).to_have_text("2伪物语")
    page.get_by_role("button", name="管理", exact=True).click()
    page.get_by_role("button", name="调整作品：化物语 · 收藏版", exact=True).click()
    page.get_by_role("button", name="作品类型", exact=True).click()
    page.get_by_role("option", name="TV / 季度", exact=True).click()
    page.get_by_role("dialog").get_by_label("作品季号", exact=True).fill("")
    page.get_by_role("button", name="保存类型", exact=True).click()
    expect(page.get_by_role("button", name="打开化物语 · 收藏版")).to_contain_text("TV")
    assert writes[-1][1]["kind"] == "custom" and writes[-1][1]["customLabel"] == "TV"
    page.get_by_role("textbox", name="搜索合集", exact=True).fill("伤物语 I 铁血篇")
    page.get_by_role("button", name="调整分组", exact=True).click()
    page.get_by_role("dialog").locator("summary").click()
    expect(page.get_by_role("dialog").get_by_role("checkbox")).to_have_count(3)
    page.keyboard.press("Escape")
    page.get_by_role("textbox", name="搜索合集", exact=True).fill("")
    page.get_by_role("button", name="调整作品：化物语 · 收藏版", exact=True).click()
    page.get_by_role("button", name="所属分组", exact=True).click()
    page.get_by_role("option", name="12伤物语", exact=True).click()
    page.get_by_role("button", name="保存分组", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    assert writes[-1][0].endswith("/collection-members/1/group")
    page.get_by_role("button", name="添加作品", exact=True).click()
    page.get_by_role("dialog").get_by_role("button", name="OVA 已移出").click()
    page.get_by_role("button", name="作品类型", exact=True).click()
    page.keyboard.press("Escape")
    expect(page.get_by_role("dialog")).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.get_by_role("dialog")).to_have_count(0)
    writes_before_reset = len(writes)
    page.get_by_role("button", name="完全重置", exact=True).click()
    expect(page.get_by_role("dialog").get_by_role("button", name="完全重置并重新整理", exact=True)).to_be_disabled()
    page.get_by_role("dialog").get_by_role("button", name="取消", exact=True).click()
    assert len(writes) == writes_before_reset
    page.get_by_role("button", name="完全重置", exact=True).click()
    page.get_by_label("重置确认", exact=True).fill("重置")
    page.get_by_role("button", name="完全重置并重新整理", exact=True).click()
    expect(page.get_by_role("dialog").get_by_role("alert")).to_contain_text("合集内容已变化")
    page.keyboard.press("Escape")
    page.reload(wait_until="networkidle")
    page.get_by_role("button", name="管理", exact=True).click()
    page.get_by_role("button", name="完全重置", exact=True).click()
    page.get_by_label("重置确认", exact=True).fill("重置")
    page.get_by_role("button", name="完全重置并重新整理", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    expect(page.get_by_role("button", name="打开1化物语", exact=True)).to_be_visible()
    assert not prefs and folders[1]["name"] == "1化物语"
    page.get_by_role("button", name="文件夹", exact=True).click()
    page.get_by_role("button", name="10终物语 12 视频", exact=True).click()
    expect(page).to_have_url(re.compile(r"/folder/10$"))
    expect(page.locator(".collection-page")).to_have_count(0)
    expect(page.get_by_role("heading", name="10终物语", exact=True)).to_be_visible()
    expect(page.get_by_text("伤物语 I 铁血篇", exact=True)).to_have_count(0)
    expect(page.get_by_text("1化物语", exact=True)).to_have_count(0)
    # Validate the opt-in treatment against an actually rendered white wallpaper.
    fixture_settings.update(background_type="image", background_path="fixture-white.svg", background_dimmer="0")
    page.goto(f"{BASE}/folder/500", wait_until="networkidle")
    header_before = page.locator(".collection-header").bounding_box()
    expect(page.locator("html")).to_have_attribute("data-text-contrast", "normal")
    assert page.locator(".collection-header h1").evaluate("el => getComputedStyle(el).textShadow") == "none"
    page.screenshot(path=str(OUT / "collection-white-normal.png"))
    page.goto(f"{BASE}/settings", wait_until="networkidle")
    page.get_by_role("checkbox", name=re.compile("^高对比度文字")).check()
    page.locator("#settings-appearance").get_by_role("button", name="保存", exact=True).click()
    expect(page.locator("html")).to_have_attribute("data-text-contrast", "high")
    page.goto(f"{BASE}/folder/500", wait_until="networkidle")
    assert fixture_settings["high_contrast_text"] == "1"
    assert page.locator(".collection-header h1").evaluate("el => getComputedStyle(el).textShadow") != "none"
    for label in ["管理", "返回"]:
        assert page.get_by_role("button", name=label, exact=True).evaluate("el => getComputedStyle(el).textShadow") != "none", f"Unreadable header control: {label}"
    assert page.locator(".collection-header").bounding_box() == header_before
    page.screenshot(path=str(OUT / "collection-white-high.png"))
    assert not unexpected, unexpected
    assert not errors, errors
    print(json.dumps({"ok": True, "widths": [1440, 1024, 768, 390, 320], "fixture_mutations": len(writes), "page_errors": errors, "screenshots": str(OUT)}, ensure_ascii=False))
    browser.close()
