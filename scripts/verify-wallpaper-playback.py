"""Isolated settings writes and original-video playback regressions.
Only temporary local video-preview capabilities reach the running backend;
all settings/library requests are fulfilled in memory. No real data is changed.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import expect, sync_playwright

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('wallpaper_fixtures', ROOT/'scripts/verify-page-appearance.py')
f = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = f
spec.loader.exec_module(f)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://127.0.0.1:5173')
    parser.add_argument('--video', type=Path, required=True, help='Disposable MP4 fixture, at least 8 seconds, 1280x720')
    parser.add_argument('--out', type=Path, default=ROOT/'.artifacts/settings-wallpaper-fix')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    video_path = str(args.video.resolve())
    video_bytes = args.video.read_bytes()
    parsed = urlparse(args.base)
    state = f.FixtureState({'color_theme':'dark','background_type':'solid','background_path':'','background_dimmer':'0.15'}, 'white')
    manifest = json.loads((ROOT/'modules/wallpapers/manifest.json').read_text(encoding='utf8'))
    modules = [{**manifest, 'configuredEnabled':True, 'active':True, 'reason':None}]
    requests, errors, previews = [], [], []

    def serve_video(route):
        raw = route.request.headers.get('range')
        start, end = 0, len(video_bytes)-1
        if raw:
            m = re.fullmatch(r'bytes=(\d+)-(\d*)',raw)
            assert m, raw
            start = int(m[1]); end = min(int(m[2]) if m[2] else end,end)
        headers = {'accept-ranges':'bytes','cache-control':'no-store'}
        if raw: headers['content-range'] = f'bytes {start}-{end}/{len(video_bytes)}'
        route.fulfill(status=206 if raw else 200,content_type='video/mp4',headers=headers,body=video_bytes[start:end+1])

    def isolate(route):
        u = urlparse(route.request.url)
        method = route.request.method
        if (u.scheme,u.netloc) != (parsed.scheme,parsed.netloc):
            return f.isolate(route,state,(parsed.scheme,parsed.netloc))
        if u.path.startswith('/api/'):
            requests.append(method+' '+u.path)
        if u.path.startswith('/api/background/video-preview'):
            if method == 'POST':
                assert route.request.post_data_json == {'path':video_path}
            return route.continue_()
        if u.path == '/api/modules': return f.fulfill_json(route,{'modules':modules,'restartRequired':False})
        if u.path == '/api/health': return f.fulfill_json(route,{'status':'ok','instanceId':'wallpaper-fixture'})
        if u.path == '/api/libraries/scan-status': return f.fulfill_json(route,{'instanceId':'wallpaper-fixture','libraries':[]})
        if u.path == '/api/wallpapers':
            return f.fulfill_json(route,[{'id':'original-video','name':'清晰完整视频','type':'video','mediaFile':'C:/Fixture/original.mp4','preview':'C:/Fixture/preview.gif','renderMode':'video'}])
        if u.path == '/api/wallpapers/file':
            if parse_qs(u.query).get('p',[''])[0].endswith('.gif'):
                return route.fulfill(content_type='image/svg+xml',body=f.SVG['white'])
            return serve_video(route)
        if u.path == '/api/background/file' and parse_qs(u.query).get('p',[''])[0] == video_path:
            return serve_video(route)
        return f.isolate(route,state,(parsed.scheme,parsed.netloc))

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=f.CHROME,headless=True)
        context = browser.new_context(viewport={'width':1440,'height':900})
        context.route('**/*',isolate)
        page = context.new_page()
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(args.base+'/settings',wait_until='domcontentloaded')
        page.get_by_role('link',name='外观',exact=True).click()
        panel=page.locator('#settings-wallpapers')
        panel.get_by_role('button',name='Wallpaper Engine',exact=True).click()
        panel.get_by_role('button',name='清晰完整视频',exact=False).click()
        video=page.locator('video')
        page.wait_for_function('document.querySelector("video")?.videoWidth === 1280 && !document.querySelector("video").paused')
        assert video.evaluate('v=>v.videoHeight') == 720
        assert '/api/wallpapers/file?' in video.get_attribute('src')
        page.evaluate('''() => { const v = document.querySelector('video'); window.originalWallpaper = v; window.loops = 0; window.emptied = 0; let last = v.currentTime; v.addEventListener('timeupdate', () => { if (last > v.duration - 2 && v.currentTime < 2) window.loops++; last = v.currentTime }); v.addEventListener('emptied',()=>window.emptied++); }''')
        page.wait_for_function('document.querySelector("video").currentTime > .5')
        page.screenshot(path=str(args.out/'video-preview-dark.png'))
        page.wait_for_function('document.querySelector("video").currentTime > 6')
        page.wait_for_function('window.loops >= 1',timeout=22000)
        previews.append({'mode':'WE','dimensions':video.evaluate('v=>[v.videoWidth,v.videoHeight]'),'duration':video.evaluate('v=>v.duration'),'loops':page.evaluate('window.loops')})
        assert not state.settings_puts
        # Successful save retains the same source/node, and leaving settings keeps it playing.
        panel.get_by_role('button',name='保存',exact=True).click()
        expect(panel.get_by_role('status')).to_have_text('壁纸设置已保存')
        assert page.evaluate('document.querySelector("video") === window.originalWallpaper && window.emptied === 0')
        page.locator('a[href="/all"]').first.click()
        expect(page).to_have_url(args.base+'/all')
        assert page.evaluate('document.querySelector("video") === window.originalWallpaper && window.emptied === 0')
        # Simulate Chromium background-page suspension plus returning focus, preserving timeline.
        page.evaluate('''() => { window.wallpaperVisibility = 'hidden'; Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.wallpaperVisibility}); Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.wallpaperVisibility === 'hidden'}); document.dispatchEvent(new Event('visibilitychange')); }''')
        assert video.evaluate('v=>v.paused')
        paused_at=video.evaluate('v=>v.currentTime')
        page.evaluate('''() => { window.wallpaperVisibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); }''')
        page.wait_for_function('!document.querySelector("video").paused')
        page.wait_for_function('(t)=>Math.abs(document.querySelector("video").currentTime-t) > .2',arg=paused_at)
        assert page.evaluate('document.querySelector("video") === window.originalWallpaper && window.emptied === 0')
        original_source = video.get_attribute('src')
        page.evaluate('''() => {
            const v = document.querySelector('video');
            const sample = document.createElement('canvas');
            sample.width = v.videoWidth; sample.height = v.videoHeight;
            sample.getContext('2d').drawImage(v, 0, 0);
            window.expectedBlurPixel = Array.from(sample.getContext('2d').getImageData(Math.floor(v.videoWidth/2), Math.floor(v.videoHeight/2), 1, 1).data);
            window.blurredWallpaperPlayCalls = 0;
            const play = v.play.bind(v);
            v.play = (...args) => { window.blurredWallpaperPlayCalls += 1; return play(...args); };
            window.dispatchEvent(new Event('blur'));
        }''')
        assert video.evaluate('v=>v.paused')
        blurred_at = video.evaluate('v=>v.currentTime')
        assert page.evaluate('source => document.visibilityState === "visible" && document.querySelector("video") === window.originalWallpaper && document.querySelector("video").getAttribute("src") === source', original_source)
        overlay_pixel = page.evaluate('''() => {
            const overlay = document.querySelector('canvas[data-wallpaper-frame="true"]');
            if (!overlay || getComputedStyle(overlay).visibility !== 'visible') return null;
            const pixel = Array.from(overlay.getContext('2d').getImageData(Math.floor(overlay.width/2), Math.floor(overlay.height/2), 1, 1).data);
            return {pixel, expected: window.expectedBlurPixel};
        }''')
        assert overlay_pixel is not None, 'blur did not retain a visible canvas frame'
        assert overlay_pixel['pixel'] == overlay_pixel['expected'], overlay_pixel
        page.evaluate('''() => {
            const v = document.querySelector('video');
            v.dispatchEvent(new Event('loadeddata'));
            v.dispatchEvent(new Event('canplay'));
            window.dispatchEvent(new Event('pageshow'));
        }''')
        assert video.evaluate('v=>v.paused')
        assert page.evaluate('window.blurredWallpaperPlayCalls === 0')
        immediate_resume = page.evaluate('''() => {
            window.dispatchEvent(new Event('focus'));
            return {visible: getComputedStyle(document.querySelector('canvas[data-wallpaper-frame="true"]')).visibility, playCalls: window.blurredWallpaperPlayCalls};
        }''')
        assert immediate_resume == {'visible':'visible','playCalls':1}, immediate_resume
        page.wait_for_function('!document.querySelector("video").paused')
        page.wait_for_function('getComputedStyle(document.querySelector("canvas[data-wallpaper-frame=\\"true\\"]")).visibility === "hidden"')
        page.wait_for_function('(t)=>Math.abs(document.querySelector("video").currentTime-t) > .2',arg=blurred_at)
        assert page.evaluate('source => document.querySelector("video") === window.originalWallpaper && document.querySelector("video").getAttribute("src") === source && window.emptied === 0', original_source)
        for _ in range(4):
            page.evaluate('''() => { document.querySelector('video').pause(); window.dispatchEvent(new Event('focus')); }''')
            page.wait_for_function('!document.querySelector("video").paused')
        assert page.evaluate('window.emptied === 0')
        resume_reloads = page.evaluate('window.emptied')
        # The local-file preview uses the real temporary streaming endpoint with isolated media.
        page.locator('a[href="/settings"]').first.click()
        page.locator('.settings-page .page-title').click()
        page.get_by_role('link',name='外观',exact=True).click()
        # Avoid registering the previous synthetic WE path during the debounced type switch.
        panel.get_by_role('button',name='视频',exact=True).click()
        panel.get_by_label('文件路径（本地绝对路径）').fill(video_path)
        page.wait_for_function('document.querySelector("video")?.getAttribute("src")?.startsWith("/api/background/video-preview/") && document.querySelector("video").videoWidth === 1280')
        local_url=video.get_attribute('src')
        page.wait_for_function('document.querySelector("video").currentTime > 6')
        previews.append({'mode':'local','dimensions':video.evaluate('v=>[v.videoWidth,v.videoHeight]'),'duration':video.evaluate('v=>v.duration')})
        page.get_by_role('link',name='外观',exact=True).click()
        page.locator('#settings-appearance').get_by_role('button',name='切换为浅色主题',exact=True).click()
        expect(page.locator('html')).to_have_attribute('data-theme','light')
        page.get_by_role('link',name='外观',exact=True).click()
        page.screenshot(path=str(args.out/'video-preview-light.png'))
        panel.get_by_role('button',name='保存',exact=True).click()
        expect(panel.get_by_role('status')).to_have_text('壁纸设置已保存')
        page.wait_for_function('document.querySelector("video")?.getAttribute("src")?.startsWith("/api/background/file?") && document.querySelector("video").videoWidth === 1280')
        assert any(r == 'DELETE '+local_url for r in requests)
        assert state.settings['background_path'] == video_path
        assert not errors,errors
        assert not state.unmatched_api,state.unmatched_api
        report={'passed':True,'previews':previews,'savedDimensions':video.evaluate('v=>[v.videoWidth,v.videoHeight]'),'focusRecoveries':6,'sourceReloadsOnResume':resume_reloads,'blurEvidence':'visible-document window blur; paused timeline; retained decoded frame; focus resumed without click','pageErrors':errors,'settingsWrites':'isolated fixtures only','visibilityEvidence':'simulated document lifecycle; real video decoding','videoPreviewStream':'real local endpoint with disposable MP4'}
        (args.out/'video-playback.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(report,ensure_ascii=False,indent=2))
        context.close(); browser.close()

if __name__ == '__main__': main()
