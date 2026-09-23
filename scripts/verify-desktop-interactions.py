"""Repeatable acceptance called by verify-desktop-design.py.

Real UI + read-only snapshot for browsing. Management uses explicit in-memory
fixtures; no source provider or user database is contacted for mutations.
"""
import json
import re
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import expect


def run(context, args, writes, errors, shot):
    page = context.new_page()
    page.goto(args.base + '/all', wait_until='domcontentloaded')
    expect(page.locator('.poster-card').first).to_be_visible()
    settings = context.new_page()
    settings.goto(args.base + '/settings', wait_until='domcontentloaded')
    motion = settings.get_by_role('group', name='动画效果', exact=True)
    expect(motion).to_be_visible(timeout=20000)
    chooser = settings.get_by_role('group', name='界面设计', exact=True)
    settings.evaluate("localStorage.setItem('fav-anim-dur','1000')")
    expect(page.locator('html')).to_have_attribute('data-motion-level', 'balanced')
    results = {'source': 'real browser UI; snapshot reads; isolated mutation fixtures', 'design': args.design, 'tiers': []}
    page.bring_to_front()
    # Layout/selection state must survive styling and preference changes.
    page.get_by_role('textbox', name='搜索名称或路径').fill('86')
    expect(page.locator('.poster-card')).to_have_count(1)
    page.locator('.poster-selection').click()
    page.evaluate("window.retainedSearch=document.querySelector('.library-search input')")
    for label in ('经典', '清爽', '经典' if args.design == 'classic' else '清爽'):
        chooser.get_by_role('button', name=label, exact=True).click()
    assert page.evaluate("window.retainedSearch===document.querySelector('.library-search input')")
    expect(page.get_by_role('textbox', name='搜索名称或路径')).to_have_value('86')
    expect(page.locator('.poster-selection')).to_have_attribute('aria-pressed', 'true')
    page.get_by_role('button', name='清除搜索', exact=True).click()
    expect(page.locator('.poster-card').nth(1)).to_be_visible()

    for level, label in [('minimal', '近乎无动画'), ('balanced', '适量动画'), ('rich', '丰富动画')]:
        motion.get_by_role('button', name=label, exact=True).click()
        page.bring_to_front()
        expect(page.locator('html')).to_have_attribute('data-motion-level', level)
        dock = page.locator('.sidebar-dock')
        page.mouse.move(500, 70)
        expect(dock).to_have_attribute('data-open', 'false')
        assert dock.evaluate('el=>el.getBoundingClientRect().width') == 0
        page.mouse.move(1, 350)
        expect(dock).to_have_attribute('data-open', 'true')
        page.mouse.move(90, 350, steps=12)
        # Deliberately exercise the 200ms grace period and interrupted leave.
        page.mouse.move(500, 350)
        page.wait_for_timeout(90)
        page.mouse.move(100, 350)
        page.wait_for_timeout(230)
        expect(dock).to_have_attribute('data-open', 'true')
        page.mouse.move(500, 70)
        expect(dock).to_have_attribute('data-open', 'false')
        expect(page.locator('.desktop-sidebar')).to_have_attribute('inert', '')
        sidebar_duration = page.locator('.desktop-sidebar').evaluate('el=>getComputedStyle(el).transitionDuration')

        # Sort direction is one click, field choices one menu, no direction submenu.
        direction = page.locator('.sort-direction')
        before = direction.get_attribute('aria-label')
        direction.click()
        assert direction.get_attribute('aria-label') != before
        page.get_by_role('button', name='选择排序字段', exact=True).click()
        fields = page.get_by_role('listbox', name='选择排序字段', exact=True)
        expect(fields.get_by_role('option')).to_have_count(5)
        fields.get_by_role('option', name='大小', exact=True).click()
        expect(direction).to_have_attribute('aria-label', '按大小降序，点击切换为升序')
        page.get_by_role('button', name='选择排序字段', exact=True).click()
        page.get_by_role('option', name='大小', exact=True).click()
        expect(direction).to_have_attribute('aria-label', '按大小降序，点击切换为升序')
        page.get_by_role('button', name='选择排序字段', exact=True).focus()
        page.keyboard.press('ArrowDown'); page.keyboard.press('Home'); page.keyboard.press('Enter')
        expect(direction).to_have_attribute('aria-label', '按名称升序，点击切换为降序')
        page.get_by_role('button', name='筛选', exact=True).click()
        filters = page.get_by_role('dialog', name='浏览选项', exact=True)
        expect(filters.get_by_role('checkbox', name='未看', exact=True)).to_be_visible()
        expect(page.get_by_role('listbox')).to_have_count(0)
        filters.get_by_role('checkbox', name='未看', exact=True).check()
        expect(filters.get_by_role('checkbox', name='未看', exact=True)).to_be_checked()
        filters.get_by_role('checkbox', name='未看', exact=True).uncheck()
        page.keyboard.press('Escape')
        expect(filters).to_have_count(0)
        expect(page.get_by_role('button', name='筛选', exact=True)).to_be_focused()

        # Measure from the first changed frame, not only the final state.
        expect(page.locator('.poster-card').first).to_be_visible()
        card = page.locator('.poster-card').first
        page.mouse.move(500, 60)
        expect(card).to_have_attribute('data-synopsis-open', 'false')
        page.wait_for_timeout(1050 if level != 'minimal' else 10)
        title_before = card.locator('.poster-title').bounding_box()
        reveal = card.locator('.poster-synopsis-reveal')
        box = card.bounding_box()
        page.mouse.move(box['x'] + box['width']/2, box['y'] + 40)
        page.wait_for_timeout(120)
        early = reveal.evaluate('el=>el.getBoundingClientRect().height')
        page.wait_for_timeout(1050)
        full = reveal.evaluate('el=>el.getBoundingClientRect().height')
        assert full > 8, (level, early, full)
        if level == 'minimal' or args.reduced_motion:
            assert abs(early-full) < 1, (level, early, full)
        else:
            assert 0 < early < full-1, (level, early, full)
        if args.design == 'liquid':
            assert abs(card.locator('.poster-title').bounding_box()['y'] - title_before['y']) < 1
            art = card.locator('.poster-art').bounding_box(); expanded = reveal.bounding_box()
            assert expanded['y'] >= art['y']-1 and expanded['y'] + expanded['height'] <= art['y'] + art['height']+1
        page.mouse.move(500, 60)
        page.wait_for_timeout(90)
        reverse = reveal.evaluate('el=>el.getBoundingClientRect().height')
        page.mouse.move(box['x'] + box['width']/2, box['y'] + 40)
        page.wait_for_timeout(35)
        resumed = reveal.evaluate('el=>el.getBoundingClientRect().height')
        assert resumed >= reverse-1, (level, reverse, resumed)
        shot(page, args, f'{level}-synopsis')
        card.locator('.poster-open').focus()
        page.keyboard.press('Escape')
        expect(card).to_have_attribute('data-synopsis-open', 'false')

        # Metadata dialog is frozen, close releases focus before visual exit.
        page.get_by_role('button', name='管理', exact=True).click()
        expect(page.get_by_role('menuitem', name='海报处理', exact=True)).to_have_count(0)
        for action in ['补齐缺失海报', '强制刷新海报', '匹配元数据', '清除元数据']:
            expect(page.get_by_role('menuitem', name=action, exact=True)).to_be_enabled()
        page.get_by_role('menuitem', name='匹配元数据', exact=True).click()
        dialog = page.get_by_role('dialog', name='匹配元数据', exact=True)
        expect(dialog).to_be_visible()
        expect(dialog).to_contain_text('部作品及其后代目录')
        shot(page, args, f'{level}-dialog')
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        expect(page.get_by_role('button', name='管理', exact=True)).to_be_focused()
        closed = page.locator('[data-overlay-state="closed"]')
        if closed.count():
            assert closed.evaluate_all('els=>els.every(el=>el.inert && getComputedStyle(el).pointerEvents==="none")')
        page.get_by_role('button', name='管理', exact=True).click()
        page.get_by_role('menuitem', name='匹配元数据', exact=True).click()
        expect(dialog).to_be_visible()
        page.keyboard.press('Escape')
        domain = page.get_by_role('group', name='媒体域', exact=True)
        domain.get_by_role('button', name='真人影视', exact=True).click()
        domain.get_by_role('button', name='动漫', exact=True).click()
        domain.get_by_role('button', name='全部', exact=True).click()
        expect(page.locator('.poster-card').first).to_be_visible()
        expect(page.locator('.library-content')).to_have_attribute('data-switching', 'false')
        results['tiers'].append({'level': level, 'sidebarDuration': sidebar_duration, 'synopsisEarly': early, 'synopsisFull': full, 'reverse': [reverse, resumed]})

    # Pinned is a new preference, persisted independently of the legacy expanded flag.
    page.mouse.move(1, 350)
    page.get_by_role('button', name='固定侧栏', exact=True).click()
    page.mouse.move(500, 80)
    expect(dock).to_have_attribute('data-open', 'true')
    page.reload(wait_until='domcontentloaded')
    expect(page.get_by_role('button', name='取消固定侧栏', exact=True)).to_be_visible()
    page.get_by_role('button', name='取消固定侧栏', exact=True).click()
    expect(dock).to_have_attribute('data-open', 'true')
    page.mouse.move(500, 80)
    expect(dock).to_have_attribute('data-open', 'false')
    edge = page.get_by_role('button', name='展开主导航', exact=True)
    edge.focus(); page.keyboard.press('Enter'); page.keyboard.press('Tab')
    expect(dock).to_have_attribute('data-open', 'true')
    assert page.evaluate('document.querySelector(".desktop-sidebar").contains(document.activeElement)')
    # Only open/cancel the owned confirmation; never send a restart request.
    restart = page.get_by_role('button', name='重启服务', exact=True)
    restart.focus(); restart.press('Enter')
    owned_dialog = page.get_by_role('dialog', name='重启 AnimeShelf 服务？', exact=True)
    expect(owned_dialog).to_be_visible()
    page.mouse.move(700, 70); page.wait_for_timeout(300)
    expect(dock).to_have_attribute('data-open', 'true')
    page.keyboard.press('Escape')
    expect(owned_dialog).to_have_count(0)
    expect(restart).to_be_focused()
    page.keyboard.press('Escape')
    expect(dock).to_have_attribute('data-open', 'false')
    expect(edge).to_be_focused()
    results['sidebar_pin_reload_keyboard_and_owned_dialog'] = True

    # Saved synopsis tuning remains visible in settings and is not clipped in fresh.
    preview = settings.get_by_label('心愿单海报预览', exact=True)
    settings.bring_to_front()
    preview.scroll_into_view_if_needed(); preview.hover()
    expect(preview).to_have_attribute('data-synopsis-open', 'true')
    settings.wait_for_timeout(1100)
    assert preview.locator('.poster-synopsis-reveal').evaluate('el=>el.getBoundingClientRect().height') > 8
    shot(settings, args, 'settings-synopsis-preview')
    assert page.evaluate("localStorage.getItem('fav-anim-dur')") == '1000'
    # Explicit system setting must override inline custom duration and rich details.
    page.emulate_media(reduced_motion='reduce')
    page.bring_to_front()
    expect(page.locator('html')).to_have_attribute('data-reduced-motion', 'true')
    card = page.locator('.poster-card').first
    card.hover()
    duration = card.locator('.poster-synopsis-reveal').evaluate('el=>getComputedStyle(el).transitionDuration')
    assert all(float(part.strip().removesuffix('s')) <= .1 for part in duration.split(',')), duration
    direction = page.locator('.sort-direction')
    direction.hover(); page.mouse.down()
    assert direction.evaluate('el=>getComputedStyle(el).scale') in ('none', '1')
    page.mouse.up()
    page.get_by_role('button', name='管理', exact=True).click()
    page.get_by_role('menuitem', name='清除元数据', exact=True).click()
    dialog = page.get_by_role('dialog', name='清除元数据', exact=True)
    expect(dialog).to_be_visible()
    assert dialog.evaluate('el=>getComputedStyle(el).scale') in ('none','1')
    page.keyboard.press('Escape')
    results['system_reduced_override'] = duration

    # Narrow touch input through Chrome's emulation, not a physical device claim.
    page.set_viewport_size({'width': 560, 'height': 820})
    page.mouse.move(400, 80)
    session = context.new_cdp_session(page)
    session.send('Emulation.setTouchEmulationEnabled', {'enabled': True})
    expect(dock).to_have_attribute('data-open', 'false')
    edge_box = edge.bounding_box()
    session.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': edge_box['x']+4, 'y': edge_box['y']+20}]})
    session.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    page.wait_for_timeout(450)
    expect(dock).to_have_attribute('data-open', 'true')
    assert dock.evaluate('el=>el.getBoundingClientRect().width') == 0
    session.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': 500, 'y': 180}]})
    session.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    expect(dock).to_have_attribute('data-open', 'false')
    shot(page, args, 'narrow-touch')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
    session.detach()
    results['narrow_emulated_touch'] = True
    results['unexpected_writes'] = list(writes)
    assert not results['unexpected_writes'], results['unexpected_writes']
    assert not errors, errors
    return results


def run_management(context, args, writes, errors, shot):
    posts, reads, jobs = [], [], {}
    state = {'matchDone': False, 'conflict': True, 'posterDone': False, 'posterReadError': False, 'clearFail': True}
    libraries = [{'id': key, 'name': f'验收库 {key}', 'type': kind, 'root_path': f'D:/Isolated/{key}', 'everything_url': None, 'created_at': ''} for key, kind in [(701, 'anime'), (702, 'anime'), (703, 'live_action')]]
    folders = [dict(id=key, library_id=lib, parent_id=None, name=name, path=f'D:/Isolated/{lib}/{name}', is_series=1, anilist_id=None, has_poster=0, media_domain=domain,
                    size=key*100, file_count=2, tags=[], synopsis='隔离测试简介。'*150, created_at='', updated_at='')
               for key, lib, name, domain in [(7101, 701, '选集 Alpha', 'anime'), (7102, 701, '其他 Beta', 'anime'), (7201, 702, '选集 Gamma', 'anime'), (7301, 703, '选集 Live', 'live_action')]]
    poster_job = None
    def fixture(route):
        nonlocal poster_job
        req, parsed = route.request, urlparse(route.request.url)
        path, query = parsed.path, parse_qs(parsed.query)
        def reply(body, status=200): route.fulfill(status=status, json=body)
        if path == '/api/libraries' and req.method == 'GET': return reply(libraries)
        if path == '/api/folders' and req.method == 'GET':
            reads.append(parsed.query)
            if query.get('q') == ['读取失败']:
                return reply({'error': '隔离读取失败'}, 500)
            result = folders
            if query.get('q'): result = [f for f in result if query['q'][0] in f['name']]
            if query.get('mediaDomain', ['all'])[0] != 'all': result = [f for f in result if f['media_domain'] == query['mediaDomain'][0]]
            if query.get('libraryId'):
                ids = set(','.join(query['libraryId']).split(',')); result = [f for f in result if str(f['library_id']) in ids]
            return reply(result)
        match = re.fullmatch(r'/api/libraries/(\d+)/(match-metadata|match-status|clear-metadata)', path)
        if match:
            lib, action = int(match[1]), match[2]
            if req.method == 'POST':
                body = req.post_data_json; posts.append({'path': path, 'body': body})
                assert body.get('folderIds') and all(any(f['id'] == key and f['library_id'] == lib for f in folders) for key in body['folderIds']), body
                if action == 'clear-metadata':
                    if lib == 702 and state['clearFail']: return reply({'error': '隔离清除失败'}, 500)
                    return reply({'ok': True, 'folderIds': body['folderIds']})
                if lib == 702 and state['conflict']: return reply({'error': '已有其他范围的任务运行中'}, 409)
                job_id = f'match-{lib}-{len(posts)}'; jobs[job_id] = body['folderIds']
                return reply({'running': True, 'jobId': job_id, 'folderIds': body['folderIds']})
            job_id = query.get('jobId', [''])[0]
            assert job_id in jobs, f'Unsafe task adoption: {path}?{parsed.query}'
            done = state['matchDone']; ids = jobs[job_id]
            return reply({'jobId': job_id, 'libraryId': lib, 'folderIds': ids, 'running': not done, 'status': 'completed' if done else 'running', 'total': len(ids), 'done': len(ids) if done else 0, 'matched': len(ids) if done else 0, 'failed': 0, 'current': '', 'reasons': {}, 'error': None})
        if path == '/api/settings/repair-posters' and req.method == 'POST':
            body = req.post_data_json; posts.append({'path': path, 'body': body})
            assert body.get('folderIds') and body.get('includeFavorites') is False
            poster_job = {'jobId': f'poster-{len(posts)}', 'retryOf': None, 'mode': body['mode'], 'libraryId': None, 'folderIds': body['folderIds'], 'includeFavorites': False, 'status': 'running', 'running': True, 'done': False, 'total': len(body['folderIds']), 'processed': 0, 'repaired': 0, 'skipped': 0, 'failed': 0, 'failures': [], 'current': '', 'error': None, 'startedAt': 1, 'finishedAt': None}
            return reply({'ok': True, 'jobId': poster_job['jobId'], 'job': poster_job})
        if path == '/api/settings/backups/poster-repair-status':
            if not query.get('jobId'): return reply(None)
            assert poster_job and query['jobId'][0] == poster_job['jobId']
            if state['posterReadError']: return reply({'error': '隔离状态读取失败'}, 503)
            if state['posterDone']:
                poster_job.update(status='completed', running=False, done=True, processed=poster_job['total'], failed=0 if poster_job['retryOf'] else 1,
                                  failures=[] if poster_job['retryOf'] else [{'key': 'fixture', 'source': 'bangumi', 'sourceId': '1', 'name': '隔离海报', 'reason': '模拟下载失败', 'code': 'NETWORK_ERROR', 'retryable': True, 'folderIds': poster_job['folderIds']}])
            return reply(poster_job)
        if re.fullmatch(r'/api/settings/repair-posters/[^/]+/retry', path) and req.method == 'POST':
            assert poster_job['jobId'] in path
            posts.append({'path': path, 'body': None})
            original = poster_job['jobId']
            poster_job = {**poster_job, 'retryOf': original, 'jobId': f'poster-retry-{len(posts)}', 'status': 'running', 'running': True, 'done': False}
            return reply({'ok': True, 'jobId': poster_job['jobId'], 'job': poster_job})
        route.fallback()
    context.route('**/api/**', fixture)
    page = context.new_page(); page.goto(args.base+'/all', wait_until='domcontentloaded')
    expect(page.locator('.poster-card')).to_have_count(4)
    page.get_by_role('button', name='管理', exact=True).click()
    page.get_by_role('menuitem', name='匹配元数据', exact=True).click()
    expect(page.get_by_role('dialog')).to_contain_text('4 部作品')
    page.get_by_role('button', name='开始匹配', exact=True).click()
    expect(page.get_by_label('管理任务反馈')).to_contain_text('已有其他范围的任务运行中')
    assert len(posts) == 3 and sorted([p['body']['folderIds'] for p in posts]) == [[7101, 7102], [7201], [7301]], posts
    # Change design and motion without task remount/duplicate requests.
    for key,value,attribute in [('animeshelf.ui-design','classic','data-ui-design'),('animeshelf.ui-design','liquid','data-ui-design'),('animeshelf.motion-level','minimal','data-motion-level'),('animeshelf.motion-level','rich','data-motion-level')]:
        page.evaluate("([key,value]) => {localStorage.setItem(key,value);dispatchEvent(new StorageEvent('storage',{key,newValue:value,storageArea:localStorage}))}",[key,value])
        expect(page.locator('html')).to_have_attribute(attribute,value)
    assert len(posts) == 3
    page.get_by_role('group', name='媒体域', exact=True).get_by_role('button', name='真人影视', exact=True).click()
    expect(page.locator('.poster-card')).to_have_count(1)
    before_reads = len(reads)
    state['matchDone'] = True
    expect(page.get_by_label('管理任务反馈')).to_contain_text('任务部分或全部失败')
    assert len(reads) == before_reads, 'Old-scope completion refreshed the new domain'
    state['conflict'] = False
    page.get_by_role('button', name='重试失败媒体库', exact=True).click()
    expect(page.get_by_label('管理任务反馈')).to_contain_text('范围内任务已完成')
    assert posts[-1]['body']['folderIds'] == [7201]
    # Current effective selection wins over all current results and source dialog freezes it.
    page.get_by_role('group', name='媒体域', exact=True).get_by_role('button', name='全部', exact=True).click()
    expect(page.locator('.poster-card')).to_have_count(4)
    page.get_by_role('textbox', name='搜索名称或路径').fill('选集')
    expect(page.locator('.poster-card')).to_have_count(3)
    page.get_by_role('button', name='选择 选集 Alpha', exact=True).click()
    page.get_by_role('button', name='管理', exact=True).click()
    page.get_by_role('menuitem', name='补齐缺失海报', exact=True).click()
    assert posts[-1]['body']['folderIds'] == [7101] and posts[-1]['body']['mode'] == 'missing'
    expect(page.get_by_role('dialog')).to_have_count(0)
    state['posterReadError'] = True
    expect(page.get_by_role('button', name='重新读取海报任务状态', exact=True)).to_be_visible(timeout=15000)
    post_count = len(posts)
    page.get_by_role('button', name='管理', exact=True).click()
    expect(page.get_by_role('menuitem', name='强制刷新海报', exact=True)).to_be_disabled()
    page.keyboard.press('Escape')
    state['posterReadError'] = False; state['posterDone'] = True
    page.get_by_role('button', name='重新读取海报任务状态', exact=True).click()
    expect(page.get_by_label('海报任务反馈')).to_contain_text('有未完成项')
    page.get_by_text('查看未完成项（1 项）', exact=True).click()
    page.get_by_role('button', name='重试可恢复的失败项', exact=True).click()
    expect(page.get_by_label('海报任务反馈')).to_contain_text('海报任务完成')
    assert len(posts) == post_count+1 and posts[-1]['path'].endswith('/retry')
    assert poster_job['folderIds'] == [7101]
    page.get_by_role('button', name='取消选择', exact=True).click()
    page.get_by_role('button', name='管理', exact=True).click()
    page.get_by_role('menuitem', name='强制刷新海报', exact=True).click()
    expect(page.get_by_label('海报任务反馈')).to_contain_text('海报任务有未完成项')
    assert sorted(posts[-1]['body']['folderIds']) == [7101, 7201, 7301] and posts[-1]['body']['mode'] == 'refresh'
    # Clear remains a scoped confirmation; cancellation issues no write.
    page.get_by_role('button', name='管理', exact=True).click()
    page.get_by_role('menuitem', name='清除元数据', exact=True).click()
    expect(page.get_by_role('dialog')).to_contain_text('3 部作品')
    before = len(posts); page.get_by_role('button', name='取消', exact=True).click(); assert len(posts) == before
    page.get_by_role('button', name='管理', exact=True).click()
    page.get_by_role('menuitem', name='清除元数据', exact=True).click()
    page.get_by_role('button', name='确认清除', exact=True).click()
    expect(page.get_by_label('管理任务反馈')).to_contain_text('隔离清除失败')
    assert sorted([p['body']['folderIds'] for p in posts[before:]]) == [[7101], [7201], [7301]]
    shot(page, args, 'management-partial-failure')
    page.get_by_role('button', name='重试失败媒体库', exact=True).click()
    expect(page.get_by_role('dialog')).to_contain_text('1 部作品及其后代目录')
    expect(page.get_by_role('dialog')).not_to_contain_text('3 部作品')
    retry_before = len(posts); state['clearFail'] = False
    page.get_by_role('button', name='确认清除', exact=True).click()
    expect(page.get_by_label('管理任务反馈')).to_contain_text('范围内任务已完成')
    assert len(posts) == retry_before+1 and posts[-1]['body']['folderIds'] == [7201]
    page.get_by_role('textbox', name='搜索名称或路径').fill('无匹配')
    expect(page.locator('.poster-card')).to_have_count(0)
    page.get_by_role('button', name='管理', exact=True).click()
    expect(page.get_by_role('menuitem', name='清除元数据', exact=True)).to_be_disabled()
    page.keyboard.press('Escape')
    page.get_by_role('textbox', name='搜索名称或路径').fill('读取失败')
    expect(page.get_by_text('媒体库读取失败', exact=True)).to_be_visible(timeout=15000)
    page.get_by_role('button', name='管理', exact=True).click()
    expect(page.get_by_role('menuitem', name='匹配元数据', exact=True)).to_be_disabled()
    assert not errors, errors
    return {'source': 'real UI + in-memory API fixtures, no provider/database mutations', 'cross_library_grouping': True, 'conflict_not_adopted': True, 'selection_and_filtered_scope': True, 'task_survives_design_motion_and_domain_switch': True, 'stale_completion_no_refresh': True, 'poster_failed_status_reload_and_frozen_retry': True, 'clear_confirmation_and_partial_failure': True, 'empty_error_scope_disabled': True, 'requests': posts}


def run_repair_feedback(context, args, writes, errors, shot):
    """Real UI, held scan snapshots and poster results; all writes are fixtures."""
    libraries = [dict(id=key, name=f'隔离库 {key}', type='anime', root_path=f'D:/Fixture/{key}', everything_url=None, created_at='') for key in [701, 702]]
    folders = [dict(id=key*10, library_id=key, parent_id=None, name=f'来源待确认 {key}', path=f'D:/Fixture/{key}/Work',
                    is_series=1, anilist_id=8, source='tmdb', tmdb_media_type=None, has_poster=0, media_domain='anime',
                    size=100, file_count=0, tags=[], synopsis='隔离简介', created_at='', updated_at='', children=[], files=[]) for key in [701, 702]]
    scans = {'instanceId': 'fixture-a', 'revision': 0, 'libraries': [
        dict(libraryId=701, revision=0, sequence=10, reason='watch', status='error', error='隔离索引未就绪'),
        dict(libraryId=702, revision=0, sequence=1, reason='watch', status='complete')]}
    posts, reads = [], []
    job = None

    def fixture(route):
        nonlocal job
        request, parsed = route.request, urlparse(route.request.url)
        query, path = parse_qs(parsed.query), parsed.path
        if path == '/api/libraries/scan-status': return route.fulfill(json=scans)
        if path == '/api/libraries': return route.fulfill(json=libraries)
        if path == '/api/folders':
            reads.append(parsed.query)
            return route.fulfill(json=[f for f in folders if not query.get('libraryId') or str(f['library_id']) in query['libraryId']])
        if path in ['/api/folders/7010', '/api/folders/7020']:
            return route.fulfill(json=next(f for f in folders if str(f['id']) == path.split('/')[-1]))
        if path.startswith('/api/metadata/search'): return route.fulfill(json=[])
        if path == '/api/settings/backups/poster-repair-status': return route.fulfill(json=job)
        if path == '/api/settings/repair-posters' and request.method == 'POST':
            body = request.post_data_json; posts.append(body)
            assert body['folderIds'] == [7010] and body['mode'] == 'refresh'
            job = dict(jobId='fixture-confirmation', retryOf=None, mode='refresh', libraryId=701, folderIds=[7010], includeFavorites=False,
                       status='completed', total=1, processed=1, repaired=0, skipped=0, failed=1, current='', error=None, startedAt=1, finishedAt=2,
                       failures=[dict(key='tmdb:unknown:8', source='tmdb', sourceId='8', name='来源待确认 701', reason='旧 TMDb 绑定缺少电影／剧集类型，请确认来源',
                                      code='SOURCE_CONFIRMATION_REQUIRED', retryable=False, folderIds=[7010])])
            return route.fulfill(json={'ok': True, 'jobId': job['jobId'], 'job': job})
        route.fallback()
    context.route('**/api/**', fixture)
    page = context.new_page(); page.goto(args.base+'/library/701', wait_until='domcontentloaded')
    expect(page.locator('.poster-card')).to_have_count(1)
    expect(page.get_by_role('group', name='媒体域', exact=True)).to_have_count(0)
    notice = page.locator('.library-scan-notice').first
    expect(notice).to_contain_text('扫描未完成：隔离索引未就绪')
    page.evaluate('window.scanNoticeNode=document.querySelector(".library-scan-notice")')
    heights = [notice.bounding_box()['height']]

    def poll():
        with page.expect_response('**/api/libraries/scan-status') as response:
            page.evaluate("window.dispatchEvent(new Event('focus'))")
        response.value.json()
        page.wait_for_timeout(60)  # Flush React after the controlled poll, not a readiness substitute.

    for sequence, status, text in [(11, 'waiting', '稍后自动重试'), (12, 'queued', '等待重新扫描'), (13, 'scanning', '正在重新扫描')]:
        scans['libraries'][0].update(sequence=sequence, status=status, waitingReason='retry')
        poll()
        expect(notice).to_contain_text('隔离索引未就绪')
        expect(notice).to_contain_text(text)
        assert page.evaluate('window.scanNoticeNode===document.querySelector(".library-scan-notice") && window.scanNoticeNode.isConnected')
        heights.append(notice.bounding_box()['height'])
    before_reads = len(reads)
    scans['libraries'][0].update(sequence=9, status='complete', revision=99, error=None)
    poll()
    expect(notice).to_contain_text('正在重新扫描')
    assert len(reads) == before_reads, 'Stale scan response refreshed the library'
    scans['instanceId'] = 'fixture-b'
    scans['libraries'][0] = dict(libraryId=701, revision=0, sequence=1, reason='watch', status='complete')
    poll(); expect(page.locator('.library-scan-notice')).to_have_count(0)
    scans['instanceId'] = 'fixture-a'
    scans['libraries'][0].update(sequence=100, status='error', error='旧实例错误')
    poll(); expect(page.locator('.library-scan-notice')).to_have_count(0)
    scans['instanceId'] = 'fixture-b'
    scans['libraries'][0].update(sequence=2, status='waiting', waitingReason='maintenance', error=None)
    poll(); expect(notice).to_contain_text('等待当前维护任务完成后扫描')

    page.get_by_role('button', name='管理', exact=True).click()
    page.get_by_role('menuitem', name='强制刷新海报', exact=True).click()
    feedback = page.get_by_label('海报任务反馈')
    expect(feedback).to_contain_text('待确认 1')
    expect(notice).to_contain_text('等待当前维护任务完成后扫描')
    feedback.locator('summary').click()
    expect(page.get_by_role('button', name='重试可恢复的失败项', exact=True)).to_have_count(0)
    link = feedback.get_by_role('link', name='确认来源', exact=True)
    expect(link).to_have_attribute('href', '/folder/7010?metadata=match')
    shot(page, args, 'scan-and-source-confirmation')
    link.click()
    expect(page.get_by_role('dialog', name='匹配元数据', exact=True)).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog', name='匹配元数据', exact=True)).to_have_count(0)
    page.get_by_role('button', name='展开主导航', exact=True).click()
    page.locator('.sidebar-link[href="/library/702"]').click()
    expect(page.locator('.poster-card')).to_have_count(1)
    expect(page.locator('.library-scan-notice')).to_have_count(0)
    assert len(posts) == 1 and max(heights)-min(heights) < 1
    assert not writes and not errors, (writes, errors)
    return dict(source='real UI + isolated scan/poster fixtures; no real provider or database writes',
                stable_retry_notice=True, stale_sequence_ignored=True, retired_instance_ignored=True, route_scope_notice_reset=True,
                poster_and_scan_notices_independent=True, source_confirmation_dialog_and_escape=True, nonretryable_action_hidden=True,
                library_has_no_media_domain_filter=True, retry_notice_heights=heights)


def run_synopsis(context, args, writes, errors, shot):
    def preference(page, key, value):
        page.evaluate("([key,value])=>{localStorage.setItem(key,value);dispatchEvent(new StorageEvent('storage',{key,newValue:value,storageArea:localStorage}))}", [key, value])

    def appearance(card):
        return card.evaluate('''el=>{
          const fresh=document.documentElement.dataset.uiDesign==='liquid';
          const reveal=el.querySelector('.poster-synopsis-reveal');
          const caption=el.querySelector('.poster-caption,.favorite-poster-caption');
          const layer=getComputedStyle(fresh?reveal:caption);
          const scroller=el.querySelector('.poster-synopsis-scroll,.favorite-synopsis-panel');
          const text=getComputedStyle(scroller.matches('p')?scroller:scroller.querySelector('p'));
          const panel=getComputedStyle(scroller);
          const sample=(style,props)=>Object.fromEntries(props.map(p=>[p,style.getPropertyValue(p)]));
          const shade=el.querySelector('.poster-shade'), shadeRect=shade.getBoundingClientRect();
          const artwork=el.querySelector('.favorite-poster-art,.poster-art');
          const artRect=(getComputedStyle(artwork).display==='contents'?artwork.parentElement:artwork).getBoundingClientRect();
          const reading=scroller.getBoundingClientRect();
          return {
            text:sample(text,['font-size','line-height','font-weight','color','letter-spacing']),
            panel:sample(panel,['background-color','padding','border-radius','border-color','backdrop-filter','max-height','overflow-y']),
            overlay:sample(layer,['background-image','padding']),
            artworkWidth:artRect.width,
            shadeInArtwork:['top','left','right','bottom'].every(p=>Math.abs(shadeRect[p]-artRect[p])<1),
            readingInArtwork:reading.top>=artRect.top-1&&reading.bottom<=artRect.bottom+1,
            shadeOpacity:getComputedStyle(shade).opacity,
            synopsisCount:el.querySelectorAll('.poster-synopsis-reveal').length,
            titleCount:el.querySelectorAll('.poster-title,h3').length
          };
        }''')

    def check_input(page, card, width):
        reveal = card.locator('.poster-synopsis-reveal')
        page.mouse.move(width-10, 10)
        page.evaluate('document.activeElement?.blur()')
        expect(reveal).to_have_css('opacity', '0')
        card.hover(); page.wait_for_timeout(170)
        opening = float(reveal.evaluate('el=>getComputedStyle(el).opacity'))
        page.mouse.move(width-10, 10); page.wait_for_timeout(50)
        closing = float(reveal.evaluate('el=>getComputedStyle(el).opacity'))
        assert 0 < closing < opening < 1, (opening, closing)
        card.hover(); page.wait_for_timeout(80)
        assert float(reveal.evaluate('el=>getComputedStyle(el).opacity')) > closing
        page.mouse.move(width-10, 10)
        page.keyboard.press('Tab')  # Establish keyboard input before programmatic focus.
        card.locator('.poster-open,[data-favorite-edit]').focus()
        expect(card).to_have_attribute('data-synopsis-open', 'true')
        page.keyboard.press('Escape')
        expect(card).to_have_attribute('data-synopsis-open', 'false')
        page.emulate_media(reduced_motion='reduce')
        card.hover()
        durations = reveal.evaluate('el=>getComputedStyle(el).transitionDuration')
        assert all(float(value.strip().removesuffix('s')) <= .1 for value in durations.split(',')), durations
        expect(reveal).to_have_css('opacity', '1')
        page.emulate_media(reduced_motion='no-preference')
        return {'reverse_from_current_progress': True, 'keyboard_escape': True, 'reduced_motion_duration': durations}

    def long_favorite(route):
        response = route.fetch(url=args.api+'/api/season/favorites')
        rows = response.json()
        assert rows, 'Snapshot must contain a favorite'
        favorite = {**rows[0], 'synopsis': '长简介内部滚动验收，不改变标题位置或卡片高度。'*180}
        route.fulfill(json=[favorite])
    context.route('**/api/season/favorites', long_favorite)
    context.add_init_script("if (location.origin === " + json.dumps(args.base) + ") { localStorage.setItem('fav-card-width','260');localStorage.setItem('fav-anim-dur','1000');localStorage.setItem('animeshelf.favorite-view','poster') }")
    page = context.new_page(); page.goto(args.base+'/favorites', wait_until='domcontentloaded'); page.bring_to_front()
    card = page.locator('.favorite-poster-card')
    expect(card).to_be_visible(timeout=15000)
    results, styles, input_checks = [], {}, []
    for design in ['classic', 'liquid']:
        preference(page, 'animeshelf.ui-design', design)
        expect(page.locator('html')).to_have_attribute('data-ui-design',design)
        for width in [1440, 390]:
            page.set_viewport_size({'width': width, 'height': 900})
            for level in ['minimal', 'balanced', 'rich']:
                preference(page, 'animeshelf.motion-level', level)
                expect(page.locator('html')).to_have_attribute('data-motion-level', level)
                page.mouse.move(width-10, 10)
                reveal = card.locator('.poster-synopsis-reveal')
                expect(reveal).to_have_css('opacity', '0')
                card.scroll_into_view_if_needed()
                before_height = card.bounding_box()['height']; before_title = card.locator('h3').bounding_box()['y']-card.bounding_box()['y']
                card.hover(); page.wait_for_timeout(125)
                early = reveal.evaluate('el=>el.getBoundingClientRect().height')
                page.wait_for_timeout(1020)
                full = reveal.evaluate('el=>el.getBoundingClientRect().height')
                assert full > 20
                assert abs(early-full) < 1 if level == 'minimal' else 0 < early < full-1, (design,width,level,early,full)
                panel = card.locator('.favorite-synopsis-panel')
                assert panel.evaluate('el=>{const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return el.clientHeight>20 && el.scrollHeight>el.clientHeight && r.top>=p.top-1 && r.bottom<=p.bottom+1}'), (design,width,level)
                panel.hover(); page.mouse.wheel(0, 200)
                expect(panel).not_to_have_js_property('scrollTop', 0)
                panel.evaluate('el=>el.scrollTop=el.scrollHeight')
                assert panel.evaluate('el=>Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<2')
                assert abs(card.bounding_box()['height']-before_height)<1
                if design == 'liquid': assert abs(card.locator('h3').bounding_box()['y']-card.bounding_box()['y']-before_title)<1
                card.locator('[data-favorite-edit]').focus(); page.keyboard.press('Escape')
                expect(card).to_have_attribute('data-synopsis-open','false')
                results.append({'design':design,'width':width,'level':level,'early':early,'full':full})
            input_checks.append({'page':'favorites','design':design,'width':width,**check_input(page,card,width)})
            # Escape closed the reveal while the pointer stayed over the card.
            # Trigger a new enter and frame the caption and expanded scroller.
            page.mouse.move(width-10, 10); card.hover()
            expect(card).to_have_attribute('data-synopsis-open', 'true')
            card.locator('h3').scroll_into_view_if_needed()
            page.wait_for_timeout(1050)
            shot(page,args,f'favorite-long-{design}-{width}')
        # Equal artwork width for style comparison only; natural layouts are tested above.
        page.set_viewport_size({'width':1440,'height':900})
        favorite_columns = page.locator('.favorites-poster-grid').evaluate('el=>el.style.gridTemplateColumns')
        page.locator('.favorites-poster-grid').evaluate('(el,width)=>el.style.gridTemplateColumns=`repeat(auto-fill, ${width}px)`', 262 if design=='classic' else 260)
        card.hover(); page.wait_for_timeout(1050)
        styles[f'favorites-{design}'] = appearance(card)
        shot(page,args,f'favorite-equal-size-{design}')
        page.locator('.favorites-poster-grid').evaluate('(el,value)=>el.style.gridTemplateColumns=value', favorite_columns)

    # One snapshot work with isolated long text, rendered through both real library routes.
    folders = context.request.get(args.api+'/api/folders').json()
    assert folders, 'Snapshot must contain a library work'
    work = {**next((folder for folder in folders if folder.get('has_poster')), folders[0]),
            'synopsis':'媒体库长简介滚动验收，保留经典字体、渐变和阅读高度。'*180}
    context.route(re.compile(r'/api/folders(?:\?.*)?$'), lambda route: route.fulfill(json=[work]))
    library = context.new_page()
    for route_name, path in [('all','/all'), ('library',f'/library/{work["library_id"]}')]:
        library.goto(args.base+path,wait_until='domcontentloaded')
        poster = library.locator('.poster-card').first
        expect(poster).to_be_visible(timeout=15000)
        for design in ['classic','liquid']:
            preference(library,'animeshelf.ui-design',design)
            preference(library,'animeshelf.motion-level','rich')
            library.set_viewport_size({'width':1440,'height':900})
            library_columns = poster.evaluate('el=>el.parentElement.style.gridTemplateColumns')
            poster.evaluate('(el,width)=>el.parentElement.style.gridTemplateColumns=`repeat(auto-fill, ${width}px)`', 262 if design=='classic' else 260)
            poster.hover();library.wait_for_timeout(1050)
            styles[f'{route_name}-{design}'] = appearance(poster)
            shot(library,args,f'{route_name}-equal-size-{design}')
            # Restore the actual grid before checking narrow layout and interactions.
            poster.evaluate('(el,value)=>el.parentElement.style.gridTemplateColumns=value', library_columns)
            library.set_viewport_size({'width':390,'height':900})
            poster.scroll_into_view_if_needed()
            input_checks.append({'page':route_name,'design':design,'width':390,**check_input(library,poster,390)})
            title = poster.locator('.poster-title')
            library.mouse.move(380,10);expect(poster.locator('.poster-synopsis-reveal')).to_have_css('opacity','0')
            before = title.bounding_box()['y']-poster.bounding_box()['y']
            height = poster.bounding_box()['height']
            poster.hover();library.wait_for_timeout(1050)
            scroll = poster.locator('.poster-synopsis-scroll')
            scroll.hover();library.mouse.wheel(0,200)
            expect(scroll).not_to_have_js_property('scrollTop',0)
            scroll.evaluate('el=>el.scrollTop=el.scrollHeight')
            assert scroll.evaluate('el=>el.scrollHeight>el.clientHeight&&Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<2')
            assert abs(poster.bounding_box()['height']-height)<1
            if design=='liquid': assert abs(title.bounding_box()['y']-poster.bounding_box()['y']-before)<1
            assert library.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            narrow = appearance(poster)
            assert narrow['shadeInArtwork'] and narrow['readingInArtwork'], narrow
            shot(library,args,f'{route_name}-narrow-{design}')

    for route_name in ['favorites','all','library']:
        classic, fresh = styles[f'{route_name}-classic'], styles[f'{route_name}-liquid']
        for key in ['text','panel','overlay']:
            assert classic[key]==fresh[key], (route_name,key,classic[key],fresh[key])
        for value in [classic,fresh]:
            assert abs(value['artworkWidth']-260)<1, value
            assert value['shadeInArtwork'] and value['readingInArtwork'] and value['shadeOpacity']=='1', value
            assert value['synopsisCount']==value['titleCount']==1, value
            assert value['overlay']['background-image'].startswith('linear-gradient('), value

    settings = context.new_page();settings.goto(args.base+'/settings',wait_until='domcontentloaded')
    preview=settings.get_by_label('心愿单海报预览',exact=True)
    slider=settings.get_by_role('slider',name=re.compile('简介遮罩'))
    opacity_checks=[]
    for design in ['classic','liquid']:
        preference(settings,'animeshelf.ui-design',design)
        expect(page.locator('html')).to_have_attribute('data-ui-design',design)
        for value in [0,25,80]:
            slider.focus();slider.press('Home' if value<50 else 'End')
            for _ in range(value//5 if value<50 else (95-value)//5): slider.press('ArrowRight' if value<50 else 'ArrowLeft')
            expect(slider).to_have_value(str(value))
            # Favorites reads display preferences on entry in both designs.
            page.reload(wait_until='domcontentloaded')
            expect(card).to_be_visible(timeout=15000)
            panel = card.locator('.favorite-synopsis-panel')
            expected = 'rgba(0, 0, 0, 0)' if value==0 else f'rgba(0, 0, 0, {value/100})'
            expect(panel).to_have_css('background-color',expected)
            expect(panel).to_have_css('backdrop-filter','none' if value==0 else 'blur(5px)')
            preview_panel=preview.locator('.poster-synopsis-reveal .overflow-y-auto')
            expect(preview_panel).to_have_css('background-color',expected)
            opacity_checks.append({'design':design,'percent':value})
        for width in [1440,390]:
            settings.set_viewport_size({'width':width,'height':900})
            preview.scroll_into_view_if_needed();preview.hover();settings.wait_for_timeout(1050)
            assert preview.locator('.poster-synopsis-reveal').evaluate('el=>{const r=el.getBoundingClientRect(),p=el.closest(".poster-card").getBoundingClientRect();return r.height>20&&r.top>=p.top&&r.bottom<=p.bottom+1}')
            shot(settings,args,f'settings-preview-{design}-{width}')
    assert page.evaluate("localStorage.getItem('fav-anim-dur')")=='1000'
    assert not writes, writes
    assert not errors, errors
    return {'source':'real components; snapshot works with isolated long-text responses; equal artwork width only for style comparisons; natural responsive layout tested separately',
            'theme':args.theme,'cases':results,'appearance':styles,'input_checks':input_checks,'opacity_setting':opacity_checks,
            'preview_fits_card':True,'internal_scroll_reaches_end':True,'same_work_same_size_style_parity':True}
