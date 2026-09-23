"""Isolated browser regressions for selection, synopsis timing, and light/dark themes."""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("appearance_fixtures", Path(__file__).with_name("verify-page-appearance.py"))
fixtures = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fixtures
spec.loader.exec_module(fixtures)


def context_for(browser, base, *, theme="dark", width=1440, material="solid", contrast="normal"):
    settings = fixtures.fixture_settings(contrast, "white", material)
    settings.update({"color_theme": theme, "background_type": "solid"})
    state = fixtures.FixtureState(settings, "white")
    context = browser.new_context(viewport={"width": width, "height": 980 if width > 500 else 844})
    parsed = urlparse(base)
    def isolate(route):
        url = urlparse(route.request.url)
        fixtures.isolate(route, state, (parsed.scheme, parsed.netloc))
    context.route("**/*", isolate)
    return context, state


def verify_wishlist_overflow(browser, base, output):
    context, state = context_for(browser, base)
    modules = []
    for module_id in ("metadata", "season", "download"):
        manifest = json.loads((Path(__file__).resolve().parents[1] / "modules" / module_id / "manifest.json").read_text(encoding="utf-8"))
        modules.append({**manifest, "configuredEnabled": True, "active": True, "reason": None})
    context.route("**/api/modules", lambda route: fixtures.fulfill_json(route, {"modules": modules, "restartRequired": False}))
    context.route("**/api/health", lambda route: fixtures.fulfill_json(route, {"status": "ok", "instanceId": "fixture"}))
    favorite = {**fixtures.FAVORITES[0], "title_zh": "银魂：用于检查两行标题完整显示的长标题", "title": "Gintama",
                "synopsis": "江户时代末期，伙伴们再次踏上旅程。" * 100}
    context.route("**/api/season/favorites", lambda route: fixtures.fulfill_json(route, [favorite]))
    context.add_init_script("localStorage.setItem('fav-anim-dur', '500'); localStorage.setItem('animeshelf.favorite-view', 'posters')")
    try:
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base + "/favorites", wait_until="domcontentloaded")
        expect(page.locator(".poster-card")).to_have_count(1)
        for width, card_width, scale in ((1440, 260, 1), (1440, 160, 1.4), (1440, 200, 1.4), (1440, 420, 1), (320, 260, 1.4)):
            page.set_viewport_size({"width": width, "height": 980 if width > 500 else 844})
            page.evaluate("([width, scale]) => { localStorage.setItem('fav-card-width', width); localStorage.setItem('fav-font-scale', scale) }", [card_width, scale])
            page.mouse.move(0, 0)
            page.reload(wait_until="domcontentloaded")
            card = page.locator(".poster-card")
            expect(card).to_be_visible()
            height = card.bounding_box()["height"]
            if width == 1440 and card_width == 260:
                measure_reveal(page, card, 500, output, "wishlist-overflow-motion")
            else:
                card.hover()
            reveal = card.locator(".poster-synopsis-reveal")
            expect(reveal).to_have_css("opacity", "1")
            name = f"wishlist-overflow-{width}-{card_width}-{scale}"
            card.screenshot(path=str(output / f"{name}.png"))
            bounds = card.evaluate("""card => {
              const title = card.querySelector('h3');
              const overlay = title.parentElement.parentElement.parentElement;
              return {title: title.getBoundingClientRect().top, overlay: overlay.getBoundingClientRect().top};
            }""")
            assert bounds["title"] >= bounds["overlay"], (name, "title is clipped above overlay", bounds)
            scroller = card.locator('[title="点击简介打开编辑面板"]')
            assert scroller.evaluate("el => { const r = el.getBoundingClientRect(); const p = el.parentElement.getBoundingClientRect(); return r.top >= p.top - 1 && r.bottom <= p.bottom + 1 && el.clientHeight > 20 && el.scrollHeight > el.clientHeight }"), (name, "synopsis must fit its viewport and remain scrollable")
            scroller.hover()
            page.mouse.wheel(0, 240)
            page.wait_for_function("document.querySelector('.poster-card [title=\"点击简介打开编辑面板\"]').scrollTop > 0")
            scroller.evaluate("el => el.scrollTop = el.scrollHeight")
            assert scroller.evaluate("el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1"), name
            assert abs(card.bounding_box()["height"] - height) < 1, name
            page.mouse.move(0, 0)
            expect(reveal).to_have_css("opacity", "0")
            card.locator('[data-favorite-edit]').focus()
            expect(reveal).to_have_css("opacity", "1")
            page.keyboard.press("Escape")
            expect(reveal).to_have_css("opacity", "0")
        favorite["synopsis"] = "简短的故事介绍。"
        page.set_viewport_size({"width": 1440, "height": 980})
        page.mouse.move(0, 0)
        page.reload(wait_until="domcontentloaded")
        card = page.locator(".poster-card")
        measure_reveal(page, card, 500, output, "wishlist-short-motion")
        scroller = card.locator('[title="点击简介打开编辑面板"]')
        assert scroller.evaluate("el => el.scrollHeight == el.clientHeight"), "short synopsis should not need scrolling"
        assert not errors, errors
        assert not state.unmatched_api, state.unmatched_api
    finally:
        context.close()


def verify_selection(browser, base, output):
    context, state = context_for(browser, base)
    try:
        page = context.new_page()
        page.goto(base + "/all", wait_until="networkidle")
        expect(page.locator("tbody tr")).to_have_count(2)
        expect(page.get_by_role("checkbox", name="选择全部", exact=True)).to_have_count(0)
        row = page.locator("tbody tr").first
        row.hover()
        row.get_by_role("checkbox").check()
        all_box = page.get_by_role("checkbox", name="选择全部", exact=True)
        expect(all_box).to_be_visible()
        assert all_box.evaluate("el => el.indeterminate"), "partial selection must be indeterminate"
        all_box.check()
        assert page.locator("tbody input:checked").count() == 2
        page.get_by_role("button", name="取消选择", exact=True).click()
        expect(all_box).to_have_count(0)
        row.get_by_role("checkbox").focus()
        expect(row.get_by_role("checkbox")).to_have_css("opacity", "1")
        page.screenshot(path=str(output / "selection.png"))
        assert not state.unmatched_api, state.unmatched_api
    finally:
        context.close()


def measure_reveal(page, card, duration, output, name):
    reveal = card.locator(".poster-synopsis-reveal")
    reveal.evaluate("""(el, duration) => {
      const card = el.closest('.poster-card');
      const title = el.parentElement.firstElementChild;
      const capture = el.motionCapture = {frames: [], endings: []};
      const recordEnd = event => capture.endings.push({property: event.propertyName, duration: event.elapsedTime * 1000});
      el.addEventListener('transitionend', recordEnd);
      card.addEventListener('pointerenter', () => {
        const start = performance.now();
        const sample = () => {
          const style = getComputedStyle(el);
          capture.frames.push({time: performance.now() - start,
            height: el.getBoundingClientRect().height, titleY: title.getBoundingClientRect().y,
            opacity: Number(style.opacity), open: card.dataset.synopsisOpen,
            cardHeight: card.getBoundingClientRect().height});
          if (performance.now() - start < duration + 100) requestAnimationFrame(sample);
          else el.removeEventListener('transitionend', recordEnd);
        };
        sample();
      }, {once: true});
    }""", duration)
    card.hover()
    if duration >= 1000:
        page.wait_for_timeout(duration * 0.45)
        card.screenshot(path=str(output / f"{name}-mid-rise.png"))
        page.wait_for_timeout(duration * 0.55 + 150)
    else:
        page.wait_for_timeout(duration + 150)
    capture = reveal.evaluate("el => el.motionCapture")
    frames = capture["frames"]
    (output / f"{name}-motion.json").write_text(json.dumps(capture, indent=2), encoding="utf-8")
    closed, opened = frames[0], frames[-1]
    assert closed["height"] < 1, (name, "collapsed synopsis reserves space", closed)
    assert opened["height"] > 5 and opened["opacity"] == 1, (name, opened)
    intermediate = [frame for frame in frames if opened["height"] * 0.05 < frame["height"] < opened["height"] * 0.95]
    assert len(intermediate) >= 4, (name, "synopsis height must rise continuously, not jump", len(intermediate))
    assert min(frame["time"] for frame in frames if frame["open"] == "true") < 160, (name, "unexpected reveal delay")
    early = min(frames, key=lambda frame: abs(frame["time"] - duration * 0.2))
    assert 0.10 < early["height"] / opened["height"] < 0.35, (name, "expansion must be visible from the beginning", early)
    for previous, current in zip(frames, frames[1:]):
        step = (current["height"] - previous["height"]) / opened["height"]
        elapsed = (current["time"] - previous["time"]) / duration
        assert -0.002 <= step <= elapsed * 1.5 + 0.06, (name, "non-monotonic growth or a height jump", previous, current)
    assert any(opened["titleY"] + 1 < frame["titleY"] < closed["titleY"] - 1 for frame in intermediate), (name, "title must rise with synopsis")
    assert all(abs(frame["cardHeight"] - closed["cardHeight"]) < 1 for frame in frames), (name, "card resized")
    assert any(event["property"] == "grid-template-rows" and abs(event["duration"] - duration) < 5 for event in capture["endings"]), (name, "height transition ignored saved duration", capture["endings"])
    return opened["height"]


def verify_reveal(browser, base, output):
    context, state = context_for(browser, base)
    context.add_init_script("""if (!localStorage.getItem('animeshelf.view')) {
      localStorage.setItem('animeshelf.view', 'poster');
      localStorage.setItem('poster-synopsis-delay', '0');
      localStorage.setItem('fav-anim-dur', '1500');
    }""")
    try:
        page = context.new_page()
        page.emulate_media(reduced_motion="no-preference")
        routes = (("wall", "/all"), ("wishlist", "/favorites"), ("preview", "/settings"))
        for name, route in routes:
            page.mouse.move(0, 0)
            page.goto(base + route, wait_until="networkidle")
            card = page.locator(".poster-card").first
            reveal = card.locator(".poster-synopsis-reveal")
            measure_reveal(page, card, 1500, output, name)
            page.mouse.move(0, 0)
            page.wait_for_timeout(300)
            closing_height = reveal.evaluate("el => el.getBoundingClientRect().height")
            assert closing_height > 0, (name, "exit must animate instead of disappearing")
            expect(reveal).to_have_css("visibility", "visible")
            expect(reveal).to_have_css("visibility", "hidden")
            assert reveal.evaluate("el => el.getBoundingClientRect().height") < 1

            # Rapid reversal must continue from the current height, not restart or latch open.
            card.hover()
            page.wait_for_timeout(450)
            before = reveal.evaluate("el => el.getBoundingClientRect().height")
            page.mouse.move(0, 0)
            page.wait_for_timeout(100)
            after = reveal.evaluate("el => el.getBoundingClientRect().height")
            assert 0 < after < before, (name, "interrupted reveal must reverse smoothly", before, after)
            card.hover()
            reopened_start = reveal.evaluate("el => el.getBoundingClientRect().height")
            page.wait_for_timeout(300)
            assert reveal.evaluate("el => el.getBoundingClientRect().height") > reopened_start
            page.mouse.move(0, 0)
            expect(reveal).to_have_css("visibility", "hidden")
            page.mouse.move(0, 0)
            page.keyboard.press("Tab")
            (card if name == "preview" else card.locator("button").first).focus()
            expect(card).to_have_attribute("data-synopsis-open", "true")
            page.wait_for_timeout(350)
            assert 0 < reveal.evaluate("el => el.getBoundingClientRect().height") < closing_height
            page.keyboard.press("Escape")
            expect(reveal).to_have_css("visibility", "hidden")

        page.goto(base + "/settings", wait_until="networkidle")
        expect(page.get_by_role("slider", name="弹起延时", exact=True)).to_have_count(0)
        page.get_by_role("slider", name="动画时长", exact=True).fill("400")
        page.mouse.move(0, 0)
        measure_reveal(page, page.locator(".poster-card").first, 400, output, "preview-live-saved")
        # Old installations may retain the removed delay key; it must no longer gate motion.
        page.evaluate("localStorage.setItem('poster-synopsis-delay', '3000')")
        page.reload(wait_until="networkidle")
        expect(page.get_by_role("slider", name="动画时长", exact=True)).to_have_value("400")
        for name, route in routes:
            page.mouse.move(0, 0)
            page.goto(base + route, wait_until="networkidle")
            measure_reveal(page, page.locator(".poster-card").first, 400, output, f"{name}-saved")

        page.emulate_media(reduced_motion="reduce")
        for name, route in routes:
            page.mouse.move(0, 0)
            page.goto(base + route, wait_until="networkidle")
            card = page.locator(".poster-card").first
            card.hover()
            reveal = card.locator(".poster-synopsis-reveal")
            expect(reveal).to_have_css("opacity", "1")
            assert "grid-template-rows" not in reveal.evaluate("el => getComputedStyle(el).transitionProperty")

        page.emulate_media(reduced_motion="no-preference")
        for width in (390, 320):
            page.set_viewport_size({"width": width, "height": 844})
            for name, route in routes:
                page.mouse.move(0, 0)
                page.goto(base + route, wait_until="networkidle")
                measure_reveal(page, page.locator(".poster-card").first, 400, output, f"{name}-{width}-saved")
                assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")

        long_favorites = [{**favorite, "synopsis": "Long synopsis with enough content to scroll. " * 100} for favorite in fixtures.FAVORITES]
        context.route("**/api/season/favorites", lambda route: fixtures.fulfill_json(route, long_favorites))
        for width in (1440, 320):
            page.set_viewport_size({"width": width, "height": 980 if width > 500 else 844})
            page.mouse.move(0, 0)
            page.goto(base + "/favorites", wait_until="networkidle")
            card = page.locator(".poster-card").first
            card.hover()
            expect(card.locator(".poster-synopsis-reveal")).to_have_css("opacity", "1")
            scroller = card.locator('[title="点击简介打开编辑面板"]')
            assert scroller.evaluate("el => el.scrollHeight > el.clientHeight")
            height = card.bounding_box()["height"]
            scroller.hover()
            page.mouse.wheel(0, 240)
            page.wait_for_function("() => document.querySelector('.poster-card [title=\"点击简介打开编辑面板\"]').scrollTop > 0")
            expect(card).to_have_attribute("data-synopsis-open", "true")
            assert abs(card.bounding_box()["height"] - height) < 1
            card.screenshot(path=str(output / f"wishlist-{width}-scrolled.png"))
        assert not state.unmatched_api, state.unmatched_api
    finally:
        context.close()


def verify_theme(browser, base, output):
    measurements = []
    for theme in ("dark", "light"):
        for width in (1440, 390, 320):
            context, state = context_for(browser, base, theme=theme, width=width)
            errors = []
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            try:
                for name, route in fixtures.ROUTES:
                    page.goto(base + route, wait_until="networkidle")
                    expect(page.locator("html")).to_have_attribute("data-theme", theme)
                    header = page.locator(".page-header").first
                    expect(header).to_be_visible()
                    colors = header.evaluate("""el => ({
                      background: getComputedStyle(el).backgroundColor,
                      heading: getComputedStyle(el.querySelector('h1') || el).color,
                      overflow: document.documentElement.scrollWidth > innerWidth,
                    })""")
                    bg = fixtures.color_parts(colors["background"])
                    fg = fixtures.color_parts(colors["heading"])
                    if theme == "light":
                        assert min(bg[:3]) > 200, (name, colors)
                        assert max(fg[:3]) < 125, (name, colors)
                    else:
                        assert max(bg[:3]) < 65, (name, colors)
                    assert not colors["overflow"], (name, width, colors)
                    measurements.append({"theme": theme, "width": width, "page": name, **colors})
                    page.screenshot(path=str(output / f"{theme}-{width}-{name}.png"))
                assert not errors, errors
                assert not state.unmatched_api, state.unmatched_api
            finally:
                context.close()

    (output / "theme-measurements.json").write_text(json.dumps(measurements, ensure_ascii=False, indent=2), encoding="utf-8")
    verify_theme_controls(browser, base, output)


def verify_theme_controls(browser, base, output):
    context, state = context_for(browser, base)
    try:
        page = context.new_page()
        page.goto(base + "/settings#settings-appearance", wait_until="networkidle")
        page.get_by_role("button", name="浅色", exact=True).click()
        expect(page.locator("html")).to_have_attribute("data-theme", "light")
        for name in ("浅色", "纯色", "实色"):
            selected = page.locator("#settings-appearance").get_by_role("button", name=name, exact=True)
            expect(selected).to_have_css("color", "rgb(255, 255, 255)")
        page.locator("#settings-appearance").get_by_role("button", name="保存", exact=True).click()
        expect(page.locator("#settings-appearance").get_by_role("button", name="已保存")).to_be_visible()
        assert state.settings_puts[-1]["color_theme"] == "light"
        page.reload(wait_until="networkidle")
        expect(page.locator("html")).to_have_attribute("data-theme", "light")
        page.get_by_role("button", name="深色", exact=True).click()
        expect(page.locator("html")).to_have_attribute("data-theme", "dark")
    finally:
        context.close()

    # The public desktop candidate has no AI settings section. The appearance
    # and editor drawer checks above cover the retained settings surfaces.


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:5173")
    parser.add_argument("--output", default="data/.ui-verification/browsing")
    parser.add_argument("--only", choices=("selection", "reveal", "wishlist-overflow", "theme", "theme-controls", "all"), default="all")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=fixtures.CHROME, headless=True)
        try:
            for name, check in (("selection", verify_selection), ("reveal", verify_reveal), ("wishlist-overflow", verify_wishlist_overflow), ("theme", verify_theme), ("theme-controls", verify_theme_controls)):
                if args.only == name or (args.only == "all" and name != "theme-controls"):
                    check(browser, args.base.rstrip("/"), output)
                    print(f"PASS {name}", flush=True)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
