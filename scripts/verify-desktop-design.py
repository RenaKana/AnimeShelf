"""Bounded desktop design preview, using the existing isolated read-only API.

Adapted from the worktree's task-panels-browser-20260919.py. GET data and
filtering stay real by default; mutating requests to the snapshot API are rejected.
The retained download check uses isolated search fixtures, never real external
sites. Theme overrides exist only in this browser context. No phone or provider
tests.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import re
import runpy
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"


def create_context(browser, args, context=None):
    if context is None:
        context = browser.new_context(viewport={"width": args.width, "height": args.height}, reduced_motion="reduce" if args.reduced_motion else "no-preference")
    writes, errors = [], []
    origin = urlparse(args.base).netloc
    def isolate(route):
        request, parsed = route.request, urlparse(route.request.url)
        if parsed.netloc != origin:
            route.abort("blockedbyclient")
            return
        if parsed.path == '/__ui-test-wallpaper.png':
            route.fulfill(path=str(ROOT / '.artifacts/content-first-20260919/adopt-a/light/library-poster.png'), content_type='image/png')
            return
        if parsed.path.startswith("/api/"):
            if request.method not in ("GET", "HEAD"):
                writes.append({"method": request.method, "path": parsed.path})
                route.fulfill(status=405, content_type="application/json", body=json.dumps({"error": "只读设计预览：未执行此操作"}, ensure_ascii=False))
                return
            response = route.fetch(url=args.api + parsed.path + ("?" + parsed.query if parsed.query else ""))
            if parsed.path == "/api/settings" and response.ok:
                settings = response.json()
                settings.update(color_theme=args.theme, background_type="solid", panel_material=args.material, high_contrast_text="1" if args.contrast == "high" else "0")
                if args.wallpaper:
                    settings.update(background_type='image', background_path=args.base + '/__ui-test-wallpaper.png', background_dimmer='0')
                route.fulfill(response=response, json=settings)
            else:
                route.fulfill(response=response)
            return
        route.continue_()
    context.route("**/*", isolate)
    pref = {"animeshelf.view": "poster", "wall-card-width": "190", "animeshelf.sidebar-collapsed": "0"}
    if args.design != "missing":
        pref["animeshelf.ui-design"] = args.design
    context.add_init_script("if (location.origin === " + json.dumps(args.base) + ") { for (const [k,v] of Object.entries(" + json.dumps(pref) + ")) { if(localStorage.getItem(k) === null) localStorage.setItem(k,v) } }")
    context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
    return context, writes, errors


def settled(page):
    expect(page.locator("h1").first).to_be_visible(timeout=20000)
    page.locator("img").evaluate_all("""els => Promise.all(els.filter(el => {
      const r=el.getBoundingClientRect(); return r.width && r.height && r.bottom>0 && r.top<innerHeight;
    }).map(el=>el.complete?Promise.resolve():new Promise(resolve=>{
      const timer=setTimeout(resolve,4000); const done=()=>{clearTimeout(timer);resolve()};
      el.addEventListener('load',done,{once:true});el.addEventListener('error',done,{once:true});
    })))""")


def shot(page, args, name):
    # Ongoing UI indicators can be paused/replaced without settling.
    # Bound screenshot readiness; never stop product animations to manufacture a pass.
    page.evaluate("""() => Promise.race([
      Promise.all(document.getAnimations().filter(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))),
      new Promise(resolve=>setTimeout(resolve,1000))])""")
    if args.check_classic_isolation:
        expect(page.locator('html')).to_have_attribute('data-ui-design', 'classic')
        comparison = page.evaluate(r"""() => {
          const sheets = Array.from(document.styleSheets).filter(s => /\/(?:content-first|content-pages)\.css$/.test(s.ownerNode?.dataset.viteDevId || ''));
          const nodes = Array.from(document.querySelectorAll('body *')).filter(el => el.getClientRects().length);
          const props = ['display','position','width','height','margin','padding','gap','font-size','font-weight','line-height','color','background-color','background-image','border','border-radius','box-shadow','backdrop-filter','opacity','overflow','transition-property','transition-duration'];
          const sample = () => nodes.map(el => props.map(p => getComputedStyle(el).getPropertyValue(p)));
          const before = sample(), states = sheets.map(s => s.disabled);
          let after;
          try { sheets.forEach(s => s.disabled = true); after = sample(); }
          finally { sheets.forEach((s,i) => s.disabled = states[i]); }
          const changes = [];
          before.forEach((values,i) => values.forEach((v,j) => {if(v !== after[i][j]) changes.push({tag:nodes[i].tagName,cls:nodes[i].className,property:props[j],withSecondDesign:v,withoutSecondDesign:after[i][j]});}));
          return {sheets:sheets.length,nodes:nodes.length,changed:changes.length,examples:changes.slice(0,5)};
        }""")
        assert comparison['sheets'] >= 2 and comparison['changed'] == 0, comparison
        args.classic_isolation_checks.append({'page': name, **comparison})
    if args.native_zoom:
        # Playwright's CSS-size screenshot clip can crop a natively zoomed tab.
        # Capture the actual Chrome surface without resizing or changing zoom.
        session = page.context.new_cdp_session(page)
        captured = session.send('Page.captureScreenshot', {'format': 'png', 'fromSurface': True, 'captureBeyondViewport': False})
        (args.output / f'{name}.png').write_bytes(base64.b64decode(captured['data']))
        session.detach()
    else:
        page.screenshot(path=str(args.output / f"{name}.png"))


def capture(context, args, writes, errors):
    page = context.new_page()
    page.goto(args.base + "/all", wait_until="domcontentloaded")
    settled(page)
    expect(page.locator(".poster-card").first).to_be_visible(timeout=15000)
    settled(page)
    expected_design = args.design if args.design in ("classic", "liquid") else "classic"
    expect(page.locator("html")).to_have_attribute("data-ui-design", expected_design)
    result = {"source": "isolated read-only API, real app", "base": args.base, "design": args.design,
              "viewport": [args.width, args.height], "zoom": f"{args.native_zoom or 100}%", "electronTitlebar": False,
              "theme": args.theme, "material": args.material, "posterPreference": 190,
              "geometry": page.locator(".poster-card").first.evaluate("el=>{const r=el.getBoundingClientRect();return {top:r.top,width:r.width,height:r.height}}"),
              "posters": page.locator(".poster-card").count(), "resolvedDesign": expected_design,
              "contrast": args.contrast, "reducedMotion": args.reduced_motion}
    result['browserMetrics'] = page.evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,pinch:visualViewport.scale,cssZoom:getComputedStyle(document.documentElement).zoom})')
    if args.native_zoom:
        assert abs(result['browserMetrics']['dpr'] - args.native_zoom / 100) < .01, result['browserMetrics']
        assert result['browserMetrics']['cssZoom'] == '1' and result['browserMetrics']['pinch'] == 1
        result['viewport'] = [result['browserMetrics']['width'], result['browserMetrics']['height']]
    if args.design == "liquid" and ":5342" in args.base:
        domains = page.get_by_role("group", name="媒体域", exact=True).get_by_role("button")
        expect(domains).to_have_count(4)
        result["domainBounds"] = domains.evaluate_all("els=>els.map(el=>{const r=el.getBoundingClientRect(); return {label:el.textContent,left:r.left,right:r.right,clipped:el.scrollWidth>el.clientWidth}})")
        assert all(not b["clipped"] and b["left"] >= 0 and b["right"] <= result['browserMetrics']['width'] for b in result["domainBounds"])
        assert page.locator("main").evaluate("el=>el.scrollWidth<=el.clientWidth")
    shot(page, args, "library-poster")
    if args.baseline_only:
        return result
    page.get_by_role("button", name="表格", exact=True).click()
    # The all-media route renders a table per media domain.
    tables = page.get_by_role("table")
    expect(tables.first).to_be_visible()
    for table in tables.all():
        expect(table).to_be_visible()
    shot(page, args, "library-table")
    page.get_by_role("button", name="海报", exact=True).click()
    expect(page.locator(".poster-card").first).to_be_visible()
    settled(page)
    filter_button = page.get_by_role("button", name="筛选", exact=True)
    filter_button.click()
    expect(page.get_by_text("筛选结果", exact=True)).to_be_visible()
    if args.reduced_motion:
        expect(page.locator(".toolbar-popover")).to_have_css("transition-duration", "0s")
    shot(page, args, "filter-panel")
    page.keyboard.press("Escape")
    first_title = page.locator(".poster-card button[aria-label^='打开 ']").first
    first_title.click()
    expect(page).to_have_url(re.compile(r"/folder/\d+"))
    expect(page.locator(".detail-columns")).to_be_visible(timeout=15000)
    settled(page)
    shot(page, args, "detail")
    page.goto(args.base + "/settings", wait_until="domcontentloaded")
    settled(page)
    expect(page.locator("#settings-library button").filter(has_text="编辑").first).to_be_visible(timeout=15000)
    page.locator("#settings-appearance").scroll_into_view_if_needed()
    shot(page, args, "appearance")
    result.update(errors=errors, rejectedWrites=writes)
    return result


def check_slice(context, args, writes, errors):
    page=context.new_page()
    page.goto(args.base+"/all",wait_until="domcontentloaded")
    expect(page.locator(".poster-card").first).to_be_visible()
    page.get_by_role("group",name="媒体域",exact=True).get_by_role("button",name="动漫",exact=True).click()
    page.get_by_role("textbox",name="搜索名称或路径").fill("86")
    expect(page.locator(".poster-card")).to_have_count(1)
    page.locator(".poster-selection").click()
    expect(page.locator(".poster-selection")).to_have_attribute("aria-pressed","true")
    settings=context.new_page()
    settings.goto(args.base+"/settings",wait_until="domcontentloaded")
    expect(settings.locator("#settings-library button").filter(has_text="编辑").first).to_be_visible(timeout=15000)
    chooser=settings.get_by_role("group",name="界面设计",exact=True)
    # Provider hydration is a known existing write attempt. Count it separately.
    settings.wait_for_timeout(300)
    before=len(writes)
    other_prefs=page.evaluate("Object.fromEntries(Object.entries(localStorage).filter(([k])=>k!=='animeshelf.ui-design'))")
    page.get_by_role("textbox",name="搜索名称或路径").focus()
    page.evaluate("() => { window.designSearch = document.querySelector('.library-search input'); window.designSearch.setSelectionRange(1, 2) }")
    for name in ("经典","清爽","经典","清爽"):
        chooser.get_by_role("button",name=name,exact=True).click()
    expect(page.locator("html")).to_have_attribute("data-ui-design","liquid")
    expect(page.get_by_role("textbox",name="搜索名称或路径")).to_have_value("86")
    assert page.evaluate("window.designSearch === document.querySelector('.library-search input') && window.designSearch.selectionStart === 1 && window.designSearch.selectionEnd === 2")
    expect(page.get_by_role("textbox",name="搜索名称或路径")).to_be_focused()
    expect(page.locator(".poster-selection")).to_have_attribute("aria-pressed","true")
    expect(page.locator(".library-results")).to_contain_text("已选 1")
    settings.wait_for_timeout(250)
    assert len(writes)==before, {"unexpected_design_writes":writes[before:]}
    assert page.evaluate("Object.fromEntries(Object.entries(localStorage).filter(([k])=>k!=='animeshelf.ui-design'))")==other_prefs
    results={"rapid_switch_preserves_search_selection":True,"additional_design_writes":len(writes)-before,"other_local_preferences_unchanged":True}

    page.bring_to_front()
    # The expanded synopsis is deliberately scrollable, not a navigation hit target.
    page.locator(".poster-open").click(position={'x': 80, 'y': 50})
    expect(page).to_have_url(re.compile(r"/folder/\d+"))
    expect(page.locator(".detail-columns")).to_be_visible()
    page.get_by_role("button",name="返回",exact=True).click()
    expect(page.get_by_role("textbox",name="搜索名称或路径")).to_have_value("86")
    expect(page.locator(".poster-card")).to_have_count(1)
    results["detail_return_context"]=True

    page.get_by_role("button",name="筛选",exact=True).focus()
    page.keyboard.press("Enter")
    filters=page.get_by_role('dialog',name='浏览选项',exact=True)
    choices=filters.get_by_role('checkbox')
    expect(choices.first).to_be_focused()
    page.keyboard.press("Shift+Tab")
    expect(choices.last).to_be_focused()
    page.keyboard.press("Tab")
    expect(choices.first).to_be_focused()
    expect(page.get_by_role("listbox")).to_have_count(0)
    expect(page.get_by_text("筛选结果",exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    expect(filters).to_have_count(0)
    expect(page.get_by_role("button",name="筛选",exact=True)).to_be_focused()
    for _ in range(3):
        page.get_by_role("button",name="筛选",exact=True).click()
        page.keyboard.press("Escape")
    expect(filters).to_have_count(0)
    results["inline_filter_keyboard_and_rapid_popup"]=True

    page.bring_to_front()
    page.get_by_role('button',name='展开主导航',exact=True).focus()
    page.keyboard.press('Enter')
    page.locator(".sidebar-link[href^='/library/']").first.click()
    page.mouse.move(600,70)
    expect(page.locator('.sidebar-dock')).to_have_attribute('data-open','false')
    expect(page.locator(".poster-card").first).to_be_visible()
    page.get_by_role("button",name="管理",exact=True).click()
    page.get_by_role("menuitem",name=re.compile("编辑媒体库")).click()
    dialog=page.get_by_role("dialog",name="编辑媒体库",exact=True)
    name_field=dialog.get_by_role("textbox",name="媒体库名称")
    name_field.fill("本轮隔离预览草稿，不保存")
    chooser.get_by_role("button",name="经典",exact=True).click()
    chooser.get_by_role("button",name="清爽",exact=True).click()
    expect(name_field).to_have_value("本轮隔离预览草稿，不保存")
    expect(name_field).to_be_focused()
    assert dialog.evaluate("el=>getComputedStyle(el).borderRadius")=="10px"
    shot(page,args,"edit-dialog")
    # Exercise the real focus trap without executing its submit button.
    dialog.get_by_role("button",name="保存",exact=True).focus()
    page.keyboard.press("Tab")
    expect(dialog.get_by_role("button",name="关闭",exact=True)).to_be_focused()
    page.keyboard.press("Shift+Tab")
    expect(dialog.get_by_role("button",name="保存",exact=True)).to_be_focused()
    page.keyboard.press("Escape")
    expect(dialog).to_have_count(0)
    expect(page.get_by_role("button",name="管理",exact=True)).to_be_focused()
    results["draft_portal_keyboard_and_focus_restore"]=True

    chooser.get_by_role("button",name="经典",exact=True).click()
    expect(page.locator(".desktop-sidebar")).to_have_css("width","240px")
    expect(page.locator(".library-toolbar")).to_have_css("border-radius","12px")
    chooser.get_by_role("button",name="清爽",exact=True).click()
    settings.reload(wait_until="domcontentloaded")
    expect(settings.locator("html")).to_have_attribute("data-ui-design","liquid")
    results["classic_cleanup_and_reload_restore"]=True

    settings.evaluate("() => { window.originalSetItem=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){if(k==='animeshelf.ui-design')throw new DOMException('Isolated test','QuotaExceededError');return window.originalSetItem.call(this,k,v)} }")
    settings.get_by_role("group",name="界面设计",exact=True).get_by_role("button",name="经典",exact=True).click()
    expect(settings.get_by_role("alert").filter(has_text="未能保存到本机")).to_be_visible()
    expect(settings.locator("html")).to_have_attribute("data-ui-design","classic")
    settings.evaluate("Storage.prototype.setItem=window.originalSetItem;delete window.originalSetItem")
    settings.get_by_role("button",name="重试保存设计").click()
    expect(settings.locator(".ui-design-notice")).to_have_count(0)
    assert settings.evaluate("localStorage.getItem('animeshelf.ui-design')")=="classic"
    results["storage_failure_truthful_and_retry"]=True
    results.update(errors=errors,rejectedWrites=writes)
    assert not errors,errors
    return results


def capture_routes(context, args, writes, errors):
    """Loaded desktop routes; inspect real data, never start external jobs."""
    page = context.new_page()
    page.goto(args.base + '/all', wait_until='domcontentloaded')
    expect(page.locator('.poster-card').first).to_be_visible(timeout=20000)
    navigation = page.locator('aside a[href]').evaluate_all("els=>els.map(el=>({label:el.textContent,href:el.getAttribute('href')}))")
    route_list = [('favorites', '/favorites'), ('season', '/season'), ('download', '/download'), ('settings', '/settings')]
    collections = page.evaluate("async()=>{const r=await fetch('/api/folders?pinned=1');return (await r.json()).map(f=>({id:f.id,name:f.name}))}")
    if collections:
        route_list.append(('collection', '/folder/' + str(collections[0]['id'])))
    # Locate one real file via the snapshot; do not manufacture a passing detail.
    first_folder = page.locator('.poster-open').first
    first_folder.click()
    expect(page).to_have_url(re.compile(r'/folder/\d+'))
    folder_id = int(page.url.split('/folder/')[1].split('?')[0])
    file_id = page.evaluate("""async id=>{
      const queue=[id]; let examined=0;
      while(queue.length && examined++<12){const f=await(await fetch('/api/folders/'+queue.shift())).json();
        if(f.files?.length)return f.files[0].id; queue.push(...(f.children||[]).map(c=>c.id));}
      return null;
    }""", folder_id)
    if file_id:
        route_list.append(('file', '/file/' + str(file_id)))
    results = {'source': 'real desktop app, read-only snapshot API; writes rejected', 'viewport': [args.width, args.height], 'theme': args.theme, 'design': args.design, 'navigation': navigation, 'routes': {}}
    for name, path in route_list:
        page.goto(args.base + path, wait_until='domcontentloaded')
        settled(page)
        if name == 'favorites':
            expect(page.get_by_placeholder('搜索心愿单')).to_be_visible()
            expect(page.locator('.favorites-group').first).to_be_visible(timeout=20000)
        elif name == 'settings':
            expect(page.locator('#settings-library button').filter(has_text='编辑').first).to_be_visible(timeout=15000)
        elif name == 'season':
            expect(page.get_by_role('tablist', name='按星期筛选')).to_be_visible()
        elif name == 'collection':
            expect(page.get_by_role('button', name='管理', exact=True)).to_be_enabled(timeout=15000)
        settled(page)
        shot(page, args, name)
        results['routes'][name] = {'heading': page.locator('h1').first.inner_text(), 'horizontalOverflow': page.locator('main').evaluate('el=>el.scrollWidth>el.clientWidth'), 'dialogs': page.get_by_role('dialog').count()}
        if name == 'favorites':
            page.locator('[data-favorite-edit]').first.click()
            expect(page.get_by_role('dialog')).to_be_visible()
            shot(page, args, 'favorite-editor')
            page.keyboard.press('Escape')
            expect(page.get_by_role('dialog')).to_have_count(0)
        elif name == 'settings':
            sections = page.locator('.settings-navigation-list a').evaluate_all("els=>els.map(el=>({label:el.textContent,id:el.hash.slice(1)}))")
            results['settingsSections'] = sections
            for section in sections:
                target = page.locator('[id="' + section['id'] + '"]')
                target.scroll_into_view_if_needed()
                shot(page, args, section['id'])
        elif name == 'collection':
            page.get_by_role('button', name='系列结构', exact=True).click()
            expect(page.get_by_role('region', name='系列结构')).to_be_visible()
            shot(page, args, 'collection-structure')
            page.get_by_role('button', name='管理', exact=True).click()
            shot(page, args, 'collection-manage')
    results.update(errors=errors, rejectedWrites=writes)
    return results


def check_modules(context, args, writes, errors):
    settings = context.new_page()
    settings.goto(args.base + '/settings', wait_until='domcontentloaded')
    chooser = settings.get_by_role('group', name='界面设计', exact=True)
    expect(chooser).to_be_visible(timeout=15000)
    results = {'source': 'real app and read-only snapshot; unsaved browser-only drafts'}

    def reverse(page):
        before = len(writes)
        for name in ('经典', '清爽', '经典', '清爽'):
            chooser.get_by_role('button', name=name, exact=True).click()
        expect(page.locator('html')).to_have_attribute('data-ui-design', 'liquid')
        assert len(writes) == before, {'during_switch': writes[before:]}

    favorite = context.new_page()
    favorite.goto(args.base + '/favorites', wait_until='domcontentloaded')
    expect(favorite.locator('[data-favorite-edit]').first).to_be_visible(timeout=15000)
    favorite.locator('[data-favorite-edit]').first.click()
    draft = favorite.locator('#favorite-synopsis')
    draft.fill('隔离预览中的未保存简介。' * 30)
    draft.focus()
    reverse(favorite)
    expect(draft).to_have_value('隔离预览中的未保存简介。' * 30)
    expect(draft).to_be_focused()
    shot(favorite, args, 'favorite-draft')
    favorite.once('dialog', lambda dialog: dialog.accept())
    favorite.keyboard.press('Escape')
    expect(favorite.get_by_role('dialog')).to_have_count(0)
    expect(favorite.locator('[data-favorite-edit]').first).to_be_focused()
    source = favorite.get_by_role('button', name='选择资料搜索渠道', exact=True)
    source.focus()
    favorite.keyboard.press('ArrowDown')
    expect(favorite.get_by_role('listbox')).to_be_visible()
    favorite.keyboard.press('Escape')
    expect(favorite.get_by_role('listbox')).to_have_count(0)
    expect(source).to_be_focused()
    results['favorite_draft_focus_and_portal_escape'] = True
    favorite.close()

    collection = context.new_page()
    collection.goto(args.base + '/all', wait_until='domcontentloaded')
    collection.bring_to_front()
    collection.get_by_role('button', name='展开主导航', exact=True).focus()
    collection.keyboard.press('Enter')
    pinned = collection.locator('.sidebar-link[href^="/folder/"]').first
    expect(pinned).to_be_visible(timeout=15000)
    pinned.click()
    collection.mouse.move(600, 70)
    expect(collection.locator('.sidebar-dock')).to_have_attribute('data-open', 'false')
    collection.get_by_role('button', name='系列结构', exact=True).click()
    manage = collection.get_by_role('button', name='管理', exact=True)
    expect(manage).to_be_enabled(timeout=15000)
    manage.click()
    group = collection.get_by_role('textbox', name='新分组名称', exact=True)
    group.fill('未创建的分组草稿')
    reverse(collection)
    expect(group).to_have_value('未创建的分组草稿')
    expect(group).to_be_focused()
    expect(collection.get_by_role('button', name='系列结构', exact=True)).to_have_attribute('aria-pressed', 'true')
    results['collection_view_and_group_draft'] = True
    collection.close()
    results.update(errors=errors, rejectedWrites=writes)
    return results


def check_boundaries(context, args, writes, errors):
    page = context.new_page()
    page.goto(args.base + '/all', wait_until='domcontentloaded')
    expect(page.locator('.poster-card').first).to_be_visible(timeout=20000)
    result = {'source': 'real desktop layout with explicitly isolated stress/error inputs', 'physicalElectron': False}
    # Hidden navigation is inert; keyboard entry reveals the same mounted tree.
    dock=page.locator('.sidebar-dock')
    expect(dock).to_have_attribute('data-open','false')
    expect(page.locator('.desktop-sidebar')).to_have_attribute('inert','')
    entry=page.get_by_role('button',name='展开主导航',exact=True)
    entry.focus(); entry.press('Space')
    expect(dock).to_have_attribute('data-open','true')
    page.get_by_role('link', name='心愿单', exact=True).focus()
    page.keyboard.press('Enter')
    expect(page).to_have_url(re.compile('/favorites$'))
    page.get_by_role('button',name='固定侧栏',exact=True).press('Space')
    expect(dock).to_have_attribute('data-pinned','true')
    page.get_by_role('button',name='取消固定侧栏',exact=True).press('Space')
    page.keyboard.press('Escape')
    expect(dock).to_have_attribute('data-open','false')
    expect(entry).to_be_focused()
    result['hidden_navigation_keyboard_and_pin'] = True

    page.goto(args.base + '/all', wait_until='domcontentloaded')
    expect(page.locator('.poster-card').first).to_be_visible()
    count = page.locator('.poster-card').count()
    page.mouse.move(args.width - 60, args.height // 2)
    page.evaluate("""()=>{window.scrollFrames=[];window.scrollSampleDone=false;let last=performance.now();const end=last+1000;
      const tick=now=>{window.scrollFrames.push(now-last);last=now;if(now<end)requestAnimationFrame(tick);else window.scrollSampleDone=true};requestAnimationFrame(tick)}""")
    for _ in range(4):
        page.mouse.wheel(0, 400)
    page.wait_for_function('document.querySelector("main").scrollTop>0 || [...document.querySelectorAll(".library-page *")].some(el=>el.scrollTop>0)')
    page.wait_for_function('window.scrollSampleDone')
    frame_times = sorted(page.evaluate('window.scrollFrames'))
    shot(page, args, 'library-scroll')
    result['poster_scroll'] = {'items': count, 'raf_during_wheel_p95_ms': round(frame_times[int(len(frame_times)*.95)], 2), 'max_ms': round(max(frame_times), 2), 'note': 'headless Chrome wheel input and RAF sample, not physical-input/device performance proof'}
    page.goto(args.base + '/all', wait_until='domcontentloaded')
    expect(page.locator('.poster-card').first).to_be_visible()
    page.get_by_role('textbox', name='搜索名称或路径').fill('不存在的隔离验收作品名称_8675309')
    expect(page.locator('.poster-card')).to_have_count(0)
    shot(page, args, 'empty-library')
    page.goto(args.base + '/ui-unavailable-test', wait_until='domcontentloaded')
    expect(page.get_by_role('heading', name='此功能当前不可用')).to_be_visible()
    shot(page, args, 'unavailable')

    # Non-retryable detail read failure, never a fake success or real data edit.
    page.route('**/api/files/999999999', lambda route: route.fulfill(status=404, json={'error': '隔离验收：文件记录不存在'}))
    page.goto(args.base + '/file/999999999', wait_until='domcontentloaded')
    expect(page.get_by_text('加载失败：隔离验收：文件记录不存在')).to_be_visible()
    shot(page, args, 'file-error')
    page.route('**/api/libraries', lambda route: route.abort('connectionrefused'))
    page.goto(args.base + '/all', wait_until='domcontentloaded')
    expect(page.get_by_role('status').filter(has_text='暂时无法连接服务')).to_be_visible(timeout=15000)
    shot(page, args, 'disconnected')
    page.unroute('**/api/libraries')
    page.reload(wait_until='domcontentloaded')
    expect(page.locator('.poster-card').first).to_be_visible(timeout=15000)
    expect(page.get_by_role('status').filter(has_text='暂时无法连接服务')).to_have_count(0)
    result['empty_unavailable_error_connection_recovery'] = True
    # CSS zoom is explicit stress emulation, not an OS/browser zoom claim.
    page.evaluate("document.documentElement.style.zoom='1.25'")
    assert page.locator('main').evaluate('el=>el.scrollWidth<=el.clientWidth')
    shot(page, args, 'css-zoom-125')
    page.locator('.poster-open').first.click()
    expect(page.locator('.detail-columns')).to_be_visible()
    page.locator('main').evaluate('el=>el.scrollTop=0')
    shot(page, args, 'detail-css-zoom-125')
    result['css_zoom_125'] = 'no main horizontal overflow; not native browser zoom'
    folder_url = page.url
    folder_path = '/api' + urlparse(folder_url).path.replace('/folder/', '/folders/')
    def stress_detail(route):
        response = route.fetch(url=args.api + folder_path)
        data = response.json()
        data.update(name='长名称与缺图隔离验收 — ' * 12, synopsis='长简介验收段落：正文必须可完整展开阅读，不能被固定高度裁剪。' * 120, poster_version=None)
        route.fulfill(response=response, json=data)
    page.route(args.base + folder_path, stress_detail)
    page.goto(folder_url, wait_until='domcontentloaded')
    expect(page.locator('.detail-columns')).to_be_visible()
    page.get_by_role('button', name='展开全文', exact=True).click()
    expect(page.locator('.detail-synopsis')).to_have_attribute('data-expanded', 'true')
    assert page.locator('.detail-synopsis').evaluate('''el=>{
      if(el.scrollHeight<=el.clientHeight+1)return true;
      if(!['auto','scroll'].includes(getComputedStyle(el).overflowY))return false;
      el.scrollTop=el.scrollHeight;
      return Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<2;
    }''')
    assert page.locator('.media-catalog-header h2').evaluate('el=>el.getBoundingClientRect().width>60')
    shot(page, args, 'long-title-missing-art')
    result['long_title_missing_art_complete_synopsis'] = 'isolated read response only, no data saved'
    result.update(errors=errors, rejectedWrites=writes)
    return result


def check_native_zoom(context, args, writes, errors):
    assert args.native_zoom, '--check-native-zoom requires --native-zoom'
    result = capture(context, args, writes, errors)
    page = context.new_page()
    page.goto(args.base + '/all', wait_until='domcontentloaded')
    page.bring_to_front()
    expect(page.locator('.poster-card').first).to_be_visible()
    page.get_by_role('button', name='筛选', exact=True).click()
    panel = page.locator('.toolbar-popover')
    expect(panel).to_be_visible()
    def within_view(locator):
        return locator.evaluate('el=>{const r=el.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1}')
    assert within_view(panel), 'Filter panel outside zoomed viewport'
    page.keyboard.press('Escape')
    page.get_by_role('button', name='展开主导航', exact=True).focus()
    page.keyboard.press('Enter')
    page.locator('.sidebar-link[href^="/library/"]').first.click()
    expect(page.locator('.poster-card').first).to_be_visible()
    page.get_by_role('button', name='管理', exact=True).click()
    page.get_by_role('menuitem', name=re.compile('编辑媒体库')).click()
    dialog = page.get_by_role('dialog', name='编辑媒体库', exact=True)
    expect(dialog).to_be_visible()
    assert within_view(dialog), 'Edit dialog outside zoomed viewport'
    field = dialog.get_by_role('textbox', name='媒体库名称')
    field.fill('放大后的隔离草稿，不保存')
    save = dialog.get_by_role('button', name='保存', exact=True)
    save.scroll_into_view_if_needed()
    assert within_view(save), 'Save action cannot be reached at native zoom'
    save.focus()
    page.keyboard.press('Tab')
    expect(dialog.get_by_role('button', name='关闭', exact=True)).to_be_focused()
    shot(page, args, 'zoom-edit-dialog')
    page.keyboard.press('Escape')
    expect(dialog).to_have_count(0)
    expect(page.get_by_role('button', name='管理', exact=True)).to_be_focused()
    result['native_zoom_filter_dialog_actions_and_keyboard'] = True
    result['window_size_not_css_viewport'] = [args.width, args.height]
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--base",default="http://127.0.0.1:5342")
    parser.add_argument("--api",default="http://127.0.0.1:5341")
    parser.add_argument("--design",default="classic")
    parser.add_argument("--theme",default="dark")
    parser.add_argument("--material",default="glass")
    parser.add_argument("--contrast",default="normal")
    parser.add_argument("--width",type=int,default=1440)
    parser.add_argument("--height",type=int,default=900)
    parser.add_argument("--reduced-motion",action="store_true")
    parser.add_argument("--wallpaper",action="store_true")
    parser.add_argument("--baseline-only",action="store_true")
    parser.add_argument("--check",action="store_true")
    parser.add_argument("--check-interactions",action="store_true")
    parser.add_argument("--check-management",action="store_true")
    parser.add_argument("--check-repair-feedback",action="store_true")
    parser.add_argument("--check-synopsis",action="store_true")
    parser.add_argument("--routes",action="store_true")
    parser.add_argument("--check-modules",action="store_true")
    parser.add_argument("--check-boundaries",action="store_true")
    parser.add_argument("--preview",action="store_true")
    parser.add_argument("--native-zoom",type=int,choices=(125,150))
    parser.add_argument("--check-native-zoom",action="store_true")
    parser.add_argument("--check-classic-isolation",action="store_true")
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    args.classic_isolation_checks = []
    args.output.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='animeshelf-ui-check-') as profile:
        context = None
        if args.native_zoom:
            # Disposable Chrome profile, never the user's browser preferences.
            default = Path(profile) / 'Default'
            default.mkdir()
            (default / 'Preferences').write_text(json.dumps({'partition': {'default_zoom_level': {'x': math.log(args.native_zoom / 100) / math.log(1.2)}}}), encoding='utf-8')
            context = p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=not args.preview,
                no_viewport=True, args=[f'--window-size={args.width},{args.height}', '--force-device-scale-factor=1'],
                reduced_motion="reduce" if args.reduced_motion else "no-preference")
            browser = context.browser
        else:
            browser=p.chromium.launch(executable_path=CHROME,headless=not args.preview)
        context,writes,errors=create_context(browser,args,context)
        try:
            if args.preview:
                page=context.new_page()
                page.goto(args.base+"/all",wait_until="domcontentloaded")
                settled(page)
                print("PREVIEW READY: real read-only data; writes are rejected; close window to stop",flush=True)
                while browser.is_connected() and context.pages:
                    try: context.pages[0].wait_for_timeout(1000)
                    except Exception: break
            else:
                result=runpy.run_path(str(ROOT / 'scripts/verify-desktop-interactions.py'))['run_repair_feedback' if args.check_repair_feedback else 'run_synopsis' if args.check_synopsis else 'run_management' if args.check_management else 'run'](context,args,writes,errors,shot) if args.check_interactions or args.check_management or args.check_synopsis or args.check_repair_feedback else check_native_zoom(context,args,writes,errors) if args.check_native_zoom else check_boundaries(context,args,writes,errors) if args.check_boundaries else check_modules(context,args,writes,errors) if args.check_modules else capture_routes(context,args,writes,errors) if args.routes else check_slice(context,args,writes,errors) if args.check else capture(context,args,writes,errors)
                result.update(errors=errors,rejectedWrites=writes)
                if args.check_classic_isolation:
                    result['classic_style_isolation'] = args.classic_isolation_checks
                (args.output/"evidence.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
                print(json.dumps(result,ensure_ascii=False),flush=True)
                assert not errors, errors
        finally:
            context.unroute_all(behavior="ignoreErrors")
            browser.close()


if __name__=="__main__": main()
