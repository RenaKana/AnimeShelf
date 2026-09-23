"""Verify Settings navigation, scrolling, and appearance draft lifecycle.

Run against the existing Vite server. All API calls are intercepted and served
from an in-memory fixture, including PUTs; the user's database is never touched.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "appearance_fixtures", Path(__file__).with_name("verify-page-appearance.py")
)
fixtures = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fixtures
spec.loader.exec_module(fixtures)

CHROME = fixtures.CHROME
VIEWPORTS = ((1440, 900), (900, 700), (390, 844))
MODULE_SNAPSHOT = {
    "modules": [{
        "id": "wallpapers",
        "name": "背景与壁纸",
        "version": "1.0.0",
        "defaultEnabled": True,
        "requires": [],
        "optional": [],
        "routes": [],
        "pages": [],
        "configuredEnabled": True,
        "active": True,
        "reason": None,
    }],
    "restartRequired": False,
}


def make_state(theme: str):
    settings = fixtures.fixture_settings("normal", "white", "solid")
    settings.update({
        "color_theme": theme,
        "background_type": "solid",
        "high_contrast_text": "0",
        "everything_url": "http://fixture:1223",
        "scan_on_startup": "0",
        "auto_scan": "1",
    })
    return fixtures.FixtureState(settings, "white")


def isolated_route(state, origin: tuple[str, str]):
    def handle(route: Route) -> None:
        request = route.request
        parsed = urlparse(request.url)
        if (parsed.scheme, parsed.netloc) == origin and parsed.path.startswith("/api/"):
            method = request.method.upper()
            if parsed.path == "/api/modules" and method == "GET":
                state.api_requests.append(f"{method} {parsed.path}")
                fixtures.fulfill_json(route, MODULE_SNAPSHOT)
                return
            if parsed.path == "/api/libraries/scan-status" and method == "GET":
                state.api_requests.append(f"{method} {parsed.path}")
                fixtures.fulfill_json(route, {"instanceId": "fixture", "revision": 0, "libraries": []})
                return
        fixtures.isolate(route, state, origin)

    return handle


def new_context(browser: Browser, base: str, state, width: int, height: int) -> BrowserContext:
    parsed = urlparse(base)
    context = browser.new_context(viewport={"width": width, "height": height}, reduced_motion="reduce")
    context.route("**/*", isolated_route(state, (parsed.scheme, parsed.netloc)))
    return context


def capture(page: Page, output: Path, name: str) -> str:
    path = output / f"{name}.png"
    page.screenshot(path=str(path), full_page=False)
    return str(path)


def wait_for_settings(page: Page, theme: str) -> None:
    expect(page.locator("#settings-general")).to_be_visible()
    expect(page.locator("#settings-appearance")).to_be_visible()
    expect(page.locator("#settings-wallpapers")).to_be_visible()
    expect(page.locator("html")).to_have_attribute("data-theme", theme)
    expect(page.get_by_role("navigation", name="设置分组")).to_be_visible()


def settings_nav(page: Page):
    return page.get_by_role("navigation", name="设置分组", exact=True)


def scroll_container(page: Page):
    return page.locator(".settings-form-content")


def theme_button(page: Page, target: str):
    label = {"light": "浅色", "dark": "深色"}.get(target, target)
    return page.get_by_role("button", name=f"切换为{label}主题", exact=True)


def choose_settings_section(page: Page, label: str, section_id: str) -> None:
    nav = settings_nav(page)
    link = nav.get_by_role("link", name=label, exact=True)
    expect(link).to_be_visible()
    link.click()
    section = page.locator(f"#{section_id}")
    expect(section).to_be_visible()
    page.wait_for_function(
        """id => {
          const content = document.querySelector('.settings-form-content');
          const section = document.getElementById(id);
          if (!content || !section) return false;
          const outer = content.getBoundingClientRect();
          const inner = section.getBoundingClientRect();
          return inner.top < outer.bottom && inner.bottom > outer.top;
        }""",
        arg=section_id,
    )


def geometry(page: Page) -> dict:
    return page.evaluate("""() => {
      const rect = selector => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return {top: box.top, left: box.left, width: box.width, height: box.height};
      };
      return {
        appTop: rect('#root')?.top,
        frameTop: rect('.desktop-frame')?.top,
        mainTop: rect('main.desktop-content')?.top,
        pageTop: rect('.settings-page')?.top,
        layoutTop: rect('.settings-layout')?.top,
        contentTop: rect('.settings-form-content')?.top,
        contentScrollTop: document.querySelector('.settings-form-content')?.scrollTop ?? null,
        mainScrollTop: document.querySelector('main.desktop-content')?.scrollTop ?? null,
        documentScrollTop: document.documentElement.scrollTop,
        bodyScrollTop: document.body.scrollTop,
        rootOverflowX: document.documentElement.scrollWidth > innerWidth,
        bodyOverflowX: document.body.scrollWidth > innerWidth,
      };
    }""")


def assert_fixed_shell(before: dict, after: dict, context: str) -> None:
    for key in ("appTop", "frameTop", "mainTop", "pageTop", "layoutTop"):
        old, new = before[key], after[key]
        assert old is not None and new is not None and abs(old - new) <= 1, (context, key, old, new)
    assert after["mainScrollTop"] == 0, (context, "main scroll moved", after)
    assert after["documentScrollTop"] == 0 and after["bodyScrollTop"] == 0, (context, "outer scroll moved", after)
    assert not after["rootOverflowX"] and not after["bodyOverflowX"], (context, "root horizontal overflow", after)


def horizontal_nav_scroller(nav) -> dict | None:
    return nav.evaluate("""nav => {
      let element = nav;
      while (element && element !== document.body) {
        const style = getComputedStyle(element);
        if ((style.overflowX === 'auto' || style.overflowX === 'scroll')
          && element.scrollWidth > element.clientWidth + 1) {
          return {
            scrollLeft: element.scrollLeft,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            maxScrollLeft: element.scrollWidth - element.clientWidth,
          };
        }
        element = element.parentElement;
      }
      return null;
    }""")


def verify_layout(browser: Browser, base: str, output: Path, theme: str, width: int, height: int) -> dict:
    state = make_state(theme)
    context = new_context(browser, base, state, width, height)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    name = f"layout-{theme}-{width}x{height}"
    try:
        page.goto(f"{base}/settings", wait_until="domcontentloaded")
        wait_for_settings(page, theme)
        nav = settings_nav(page)
        start = geometry(page)
        assert start["contentScrollTop"] == 0, (name, "content did not start at top", start)

        horizontal = horizontal_nav_scroller(nav)
        if width <= 800:
            assert horizontal is not None, (name, "narrow navigation has no horizontal scroller")
            nav.evaluate("""nav => {
              let element = nav;
              while (element && element !== document.body) {
                const style = getComputedStyle(element);
                if ((style.overflowX === 'auto' || style.overflowX === 'scroll')
                  && element.scrollWidth > element.clientWidth + 1) {
                  element.scrollLeft = element.scrollWidth;
                  return;
                }
                element = element.parentElement;
              }
            }""")
            backup_link = nav.get_by_role("link", name="备份与恢复", exact=True)
            expect(backup_link).to_be_visible()
            nav_rect = page.locator(".settings-navigation").bounding_box()
            link_rect = backup_link.bounding_box()
            assert nav_rect and link_rect and link_rect["x"] >= nav_rect["x"] - 1 and link_rect["x"] + link_rect["width"] <= nav_rect["x"] + nav_rect["width"] + 1, (name, "last narrow-nav link is not horizontally reachable", nav_rect, link_rect)

        choose_settings_section(page, "备份与恢复", "settings-backup")
        after_backup = geometry(page)
        assert after_backup["contentScrollTop"] > start["contentScrollTop"], (name, "right settings pane did not scroll to backup", start, after_backup)
        assert_fixed_shell(start, after_backup, name)
        backup_shot = capture(page, output, f"{name}-backup")

        choose_settings_section(page, "常规", "settings-general")
        after_general = geometry(page)
        assert after_general["contentScrollTop"] < after_backup["contentScrollTop"], (name, "navigation did not return the settings pane", after_backup, after_general)
        assert_fixed_shell(start, after_general, name)

        content = scroll_container(page)
        content_box = content.bounding_box()
        assert content_box and content_box["height"] > 80, (name, "settings content has no scroll area", content_box)
        page.mouse.move(content_box["x"] + content_box["width"] / 2, content_box["y"] + content_box["height"] / 2)
        page.mouse.wheel(0, 260)
        page.wait_for_function("document.querySelector('.settings-form-content')?.scrollTop > 0")
        after_wheel = geometry(page)
        assert after_wheel["contentScrollTop"] > 0, (name, "wheel did not scroll the right settings pane", after_wheel)
        assert_fixed_shell(start, after_wheel, name)

        choose_settings_section(page, "外观", "settings-appearance")
        expect(nav.get_by_role("link", name="背景与壁纸", exact=True)).to_have_count(0)
        expect(page.locator("#settings-appearance #settings-wallpapers")).to_be_visible()
        expect(theme_button(page, "浅色" if theme == "dark" else "深色")).to_be_visible()
        final = geometry(page)
        assert_fixed_shell(start, final, name)
        screenshot = capture(page, output, f"{name}-appearance")
        assert not errors, (name, "page errors", errors)
        assert not state.unmatched_api, (name, "unmatched fixture APIs", state.unmatched_api)
        assert not fixtures.unexpected_nonlocal(state.blocked_nonlocal), (name, "unexpected external requests", state.blocked_nonlocal)
        return {
            "theme": theme,
            "viewport": {"width": width, "height": height},
            "backupScrollTop": after_backup["contentScrollTop"],
            "wheelScrollTop": after_wheel["contentScrollTop"],
            "narrowNav": horizontal,
            "screenshots": [backup_shot, screenshot],
            "apiRequestCount": len(state.api_requests),
        }
    except Exception as error:
        failure_shot = capture(page, output, f"FAIL--{name}")
        raise AssertionError(f"{name}: {error}; screenshot={failure_shot}") from error
    finally:
        context.close()


def verify_theme_and_drafts(browser: Browser, base: str, output: Path, saved_theme: str) -> dict:
    state = make_state(saved_theme)
    context = new_context(browser, base, state, 1440, 900)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    name = f"theme-drafts-{saved_theme}"
    preview_theme = "light" if saved_theme == "dark" else "dark"
    try:
        page.goto(f"{base}/settings", wait_until="domcontentloaded")
        wait_for_settings(page, saved_theme)

        theme_button(page, "light" if saved_theme == "dark" else "dark").click()
        expect(page.locator("html")).to_have_attribute("data-theme", preview_theme)
        expect(theme_button(page, saved_theme == "dark" and "dark" or "light")).to_be_visible()

        main_nav = page.get_by_role("navigation", name="主导航", exact=True)
        main_nav.get_by_role("link", name="全部媒体", exact=True).click()
        expect(page).to_have_url(re.compile(r"/all(?:$|[?#])"))
        expect(page.locator("html")).to_have_attribute("data-theme", saved_theme)
        page.get_by_role("link", name="设置", exact=True).click()
        expect(page).to_have_url(re.compile(r"/settings(?:$|[?#])"))
        page.locator(".settings-page .page-title").click()
        wait_for_settings(page, saved_theme)
        expect(theme_button(page, "light" if saved_theme == "dark" else "dark")).to_be_visible()

        theme_button(page, "light" if saved_theme == "dark" else "dark").click()
        expect(page.locator("html")).to_have_attribute("data-theme", preview_theme)
        choose_settings_section(page, "常规", "settings-general")
        auto_scan = page.get_by_role("checkbox", name="自动检测文件变更", exact=True)
        auto_scan.set_checked(not auto_scan.is_checked())
        general = page.locator("#settings-general")
        general.get_by_role("button", name="保存", exact=True).click()
        expect(general.get_by_role("button", name=re.compile("已保存"))).to_be_visible()
        assert state.settings["color_theme"] == saved_theme, (name, "ordinary save persisted the unsubmitted theme", state.settings)
        assert state.settings["auto_scan"] == ("1" if auto_scan.is_checked() else "0"), (name, "ordinary setting was not persisted", state.settings)
        expect(page.locator("html")).to_have_attribute("data-theme", preview_theme)
        expect(theme_button(page, saved_theme)).to_be_visible()

        url_input = general.get_by_role("textbox").first
        url_input.fill("http://unsaved-core.fixture/")
        choose_settings_section(page, "外观", "settings-appearance")
        appearance = page.locator("#settings-appearance")
        appearance.get_by_role("button", name="保存", exact=True).first.click()
        expect(appearance.get_by_role("button", name=re.compile("已保存"))).to_be_visible()
        assert state.settings["color_theme"] == preview_theme, (name, "appearance save did not persist the selected theme", state.settings)
        assert state.settings["everything_url"] == "http://fixture:1223", (name, "unsubmitted core input reached the fixture store", state.settings)
        expect(page.locator("html")).to_have_attribute("data-theme", preview_theme)
        expect(theme_button(page, saved_theme)).to_be_visible()

        choose_settings_section(page, "常规", "settings-general")
        expect(general.get_by_role("textbox").first).to_have_value("http://unsaved-core.fixture/")
        saved_url = state.settings["everything_url"]
        assert len(state.settings_puts) >= 2, (name, "fixture did not record isolated saves", state.settings_puts)
        assert "color_theme" not in state.settings_puts[-2], (name, "ordinary save included appearance keys", state.settings_puts[-2])
        assert state.settings_puts[-1].get("color_theme") == preview_theme, (name, "appearance save payload mismatch", state.settings_puts[-1])

        page.reload(wait_until="domcontentloaded")
        wait_for_settings(page, preview_theme)
        expect(theme_button(page, saved_theme)).to_be_visible()
        expect(page.locator("#settings-general").get_by_role("textbox").first).to_have_value(saved_url)
        assert not errors, (name, "page errors", errors)
        assert not state.unmatched_api, (name, "unmatched fixture APIs", state.unmatched_api)
        assert not fixtures.unexpected_nonlocal(state.blocked_nonlocal), (name, "unexpected external requests", state.blocked_nonlocal)
        screenshot = capture(page, output, f"{name}-persisted")
        return {
            "initialTheme": saved_theme,
            "previewTheme": preview_theme,
            "settingsPuts": state.settings_puts,
            "persistedUrl": saved_url,
            "unmatchedApi": state.unmatched_api,
            "screenshots": [screenshot],
        }
    except Exception as error:
        failure_shot = capture(page, output, f"FAIL--{name}")
        raise AssertionError(f"{name}: {error}; screenshot={failure_shot}") from error
    finally:
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify Settings navigation and appearance draft lifecycle against isolated fixtures.")
    parser.add_argument("--base", default="http://127.0.0.1:5173", help="Existing Vite origin (default: %(default)s)")
    parser.add_argument("--output", default=".artifacts/settings-wallpaper-fix", help="Screenshot and JSON report directory")
    args = parser.parse_args()
    base = args.base.rstrip("/")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"base": base, "ok": False, "layout": [], "themeDrafts": [], "failures": []}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        try:
            for theme in ("dark", "light"):
                for width, height in VIEWPORTS:
                    try:
                        result = verify_layout(browser, base, output, theme, width, height)
                        report["layout"].append(result)
                        print(f"PASS layout theme={theme} viewport={width}x{height}", flush=True)
                    except Exception as error:
                        report["failures"].append(str(error))
                        print(f"FAIL layout theme={theme} viewport={width}x{height}: {error}", flush=True)
                try:
                    result = verify_theme_and_drafts(browser, base, output, theme)
                    report["themeDrafts"].append(result)
                    print(f"PASS theme-drafts initial={theme}", flush=True)
                except Exception as error:
                    report["failures"].append(str(error))
                    print(f"FAIL theme-drafts initial={theme}: {error}", flush=True)
        finally:
            browser.close()

    report["ok"] = not report["failures"]
    report_path = output / "settings-navigation-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "report": str(report_path), "failures": report["failures"]}, ensure_ascii=False))
    if not report["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
