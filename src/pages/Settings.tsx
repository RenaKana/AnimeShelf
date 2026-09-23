import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { colorTheme, textContrastMode } from '../lib/appearance'
import type { DatabaseSystemInfo, Library, Settings as S, Tag } from '../types'
import { api } from '../api'
import ServiceRestartControl, { useServiceRestartState } from '../components/ServiceRestartControl'
import MotionControl from '../components/settings/MotionControl'
import { ModuleErrorBoundary, useModules } from '../modules/registry'
import LibraryEditDialog from '../components/LibraryEditDialog'

import DataCredits from '../components/settings/DataCredits'
import BackupRestorePanel from '../components/settings/BackupRestorePanel'

// 正则重命名预设模板：点击填入正则框（可继续手改）
// 标准命名示例：[T.H.X&VCB-Studio&Eupho] 冰菓 (Hyouka) [2012]
const REGEX_TEMPLATES: { label: string; pattern: string; hint: string }[] = [
  { label: '去压制组前缀', pattern: '^\\[[^\\]]+\\]\\s*', hint: '[T.H.X&VCB-Studio&Eupho] 冰菓 (Hyouka) [2012] → 冰菓 (Hyouka) [2012]' },
  { label: '去年份后缀', pattern: '\\s*\\[\\d{4}\\]\\s*', hint: '冰菓 (Hyouka) [2012] → 冰菓 (Hyouka)' },
  { label: '去编码/分辨率标签', pattern: '\\s*\\[[^\\]]*(?:x?26[45]|1080p|720p|BDRip|WebRip|Ver\\.?)[^\\]]*\\]\\s*', hint: '名称 [x265-10Bit Ver.] → 名称' },
  { label: '去英文原名括号', pattern: '\\s*\\([^()]*\\)\\s*', hint: '冰菓 (Hyouka) → 冰菓' },
  { label: '去尾部季/特典', pattern: '\\s*[-–—]\\s*[^-]*$', hint: '名称 - TV + SP → 名称' },
  { label: '只留番剧名（含英文名）', pattern: '^\\[[^\\]]+\\]\\s*|\\s*\\[[^\\]]*\\]\\s*', hint: '[T.H.X&VCB-Studio&Eupho] 冰菓 (Hyouka) [2012] → 冰菓 (Hyouka)' },
  { label: '只留中文名', pattern: '^\\[[^\\]]+\\]\\s*|\\s*\\[[^\\]]*\\]\\s*|\\s*\\([^()]*\\)\\s*', hint: '[T.H.X&VCB-Studio&Eupho] 冰菓 (Hyouka) [2012] → 冰菓' },
]

export default function Settings({ onLibrariesChange, onBackgroundPreview }: { onLibrariesChange?: () => void; onBackgroundPreview?: (patch: Partial<S>) => void }) {
  const { modules, snapshot, loadErrors, snapshotError, configure } = useModules()
  const [settings, setSettings] = useState<S>({})
  const drafts = useRef<S>({})
  const contentRef = useRef<HTMLDivElement>(null)
  const [libraries, setLibraries] = useState<Library[]>([])
  const [editingLibrary, setEditingLibrary] = useState<Library | null>(null)
  const lastEditingLibrary = useRef<Library | null>(null)
  if (editingLibrary) lastEditingLibrary.current = editingLibrary
  const [tags, setTags] = useState<Tag[]>([])
  const [savedPart, setSavedPart] = useState('')
  const [moduleBusy, setModuleBusy] = useState<string | null>(null)
  const { restarting } = useServiceRestartState()
  const [moduleError, setModuleError] = useState('')
  const [backingUp, setBackingUp] = useState(false)
  const [databaseInfo, setDatabaseInfo] = useState<DatabaseSystemInfo | null>(null)
  const [backupMsg, setBackupMsg] = useState('')
  const [restoring, setRestoring] = useState(false)
  // 正则重命名：预览 → 确认应用
  const [rePattern, setRePattern] = useState('')
  const [reRepl, setReRepl] = useState('')
  const [reIgnore, setReIgnore] = useState(false)
  const [reScope, setReScope] = useState<'top' | 'all'>('top')
  const [reList, setReList] = useState<{ id: number; from: string; to: string }[]>([])
  const [reCount, setReCount] = useState(0)
  const [reBusy, setReBusy] = useState(false)
  const [reMsg, setReMsg] = useState('')
  const [reRestoreMsg, setReRestoreMsg] = useState('')
  const load = async () => {
    const saved = await api.settings.get()
    setSettings({ ...saved, ...drafts.current })
    try { setDatabaseInfo(await api.settings.systemInfo()) } catch { setDatabaseInfo(null) }
    setLibraries(await api.libraries.list())
    setTags((await api.tags.list()).filter(t => t.kind === 'custom'))
  }
  useEffect(() => { load().catch(console.error) }, [])

  // 外观相关字段：本地草稿更新 + 实时预览（App 内存态，不写库；点分区「保存」才持久化）
  const set = (k: string, v: string, preview = false) => {
    drafts.current[k] = v
    setSettings(prev => ({ ...prev, [k]: v }))
    if (preview && onBackgroundPreview) onBackgroundPreview({ [k]: v })
  }

  // 分区保存：只提交该分区字段子集，保存后同步服务端最新值
  const savePart = async (keys: string[], part: string) => {
    try {
      const patch: S = {}
      for (const k of keys) patch[k] = k === 'high_contrast_text'
        ? (textContrastMode(settings) === 'high' ? '1' : '0')
        : settings[k] ?? ''
      await api.settings.update(patch)
      for (const [key, value] of Object.entries(patch)) {
        if (drafts.current[key] === value) delete drafts.current[key]
      }
      setSavedPart(part); setTimeout(() => setSavedPart(''), 1500)
      onLibrariesChange?.()
      await load()
    } catch (e: any) { alert(e.message) }
  }

  // 分区保存按钮（右上角；只提交该分区字段）
  const PartSave = ({ part, keys }: { part: string; keys: string[] }) => (
    <button className="text-xs px-2.5 py-1 rounded-lg border border-accent/40 text-accent hover:bg-accent/10 transition-colors"
      onClick={() => savePart(keys, part)}>
      {savedPart === part ? '✓ 已保存' : '保存'}
    </button>
  )

  const moduleSettingsSections = modules.flatMap(loaded => (
    (loaded.contribution.settingsSections ?? []).map(section => ({ ...section, moduleId: loaded.id }))
  )).sort((left, right) => (left.order ?? 100) - (right.order ?? 100))

  const updateModule = async (id: string, enabled: boolean) => {
    if (moduleBusy || restarting) return
    setModuleBusy(id)
    setModuleError('')
    try {
      await configure({ [id]: enabled })
    } catch (error) {
      setModuleError(error instanceof Error ? error.message : String(error))
    } finally {
      setModuleBusy(null)
    }
  }

  // Keep the overview and content in one ordered list. Conditional module
  // sections are inserted at their contribution order, so hidden modules do
  // not leave stale links behind.
  const settingsSections: Array<{ id: string; label: string; content: ReactNode }> = [
    {
      id: 'settings-general', label: '常规', content: (
        <section id="settings-general" className="ui-panel scroll-mt-4 bg-[#111722]/88 border border-white/10 rounded-2xl p-4 space-y-3 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Everything</h2>
            <PartSave part="everything" keys={['everything_url', 'scan_on_startup', 'auto_scan']} />
          </div>
          <label className="block text-sm text-text-secondary">HTTP 地址</label>
          <input className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm" value={settings.everything_url ?? 'http://localhost:1223'} onChange={e => set('everything_url', e.target.value)} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={(settings.scan_on_startup ?? '0') === '1'} onChange={e => set('scan_on_startup', e.target.checked ? '1' : '0')} /> 启动时自动扫描
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.auto_scan !== '0'} onChange={e => set('auto_scan', e.target.checked ? '1' : '0')} /> 自动检测文件变更
          </label>
        </section>
      ),
    },
    {
      id: 'settings-appearance', label: '外观', content: (
        <section id="settings-appearance" className="ui-panel scroll-mt-4 bg-[#111722]/88 border border-white/10 rounded-2xl p-4 space-y-3 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">外观</h2>
          </div>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">显示</h3>
            <PartSave part="appearance" keys={['color_theme', 'high_contrast_text']} />
          </div>
          <MotionControl />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-text-secondary">界面主题</span>
            <button type="button" className="toolbar-trigger px-3 text-xs" onClick={() => set('color_theme', colorTheme(settings) === 'dark' ? 'light' : 'dark', true)}>
              切换为{colorTheme(settings) === 'dark' ? '浅色' : '深色'}主题
            </button>
          </div>
          <label className="flex items-start gap-2 text-sm text-text-secondary">
            <input type="checkbox" className="mt-0.5 accent-accent"
              checked={textContrastMode(settings) === 'high'}
              onChange={e => set('high_contrast_text', e.target.checked ? '1' : '0', true)} />
            <span><span className="text-text-primary">高对比度文字</span><span className="ml-2 text-[11px] text-text-secondary/65">增强所有页面的标题、说明与控件文字，保留状态颜色。</span></span>
          </label>
          {moduleSettingsSections.filter(section => section.group === 'appearance').map(({ moduleId, id, component: Section }) => (
            <ModuleErrorBoundary key={`${moduleId}:${id}`} moduleId={moduleId}>
              <Section embedded onRefresh={onLibrariesChange} onBackgroundPreview={onBackgroundPreview} />
            </ModuleErrorBoundary>
          ))}
        </section>
      ),
    },
    {
      id: 'settings-library', label: '媒体库', content: (
        <section id="settings-library" className="ui-panel scroll-mt-4 bg-[#111722]/88 border border-white/10 rounded-2xl p-4 space-y-3 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
          <h2 className="font-semibold">媒体库</h2>
          {libraries.length === 0 && <p className="text-xs text-text-secondary">还没有媒体库——可到「全部媒体」页直接添加（侧边栏 ➕ 添加媒体库），或在此添加：</p>}
          {libraries.map(lib => (
            <div key={lib.id} className="flex items-center gap-3 text-sm border-b border-border/50 pb-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-text-primary">{lib.name}</div>
                <div className="mt-0.5 truncate text-xs text-text-secondary" title={lib.root_path}>{lib.root_path}</div>
              </div>
              <button className="text-text-secondary hover:text-white" onClick={() => setEditingLibrary(lib)}>编辑</button>
              <button className="text-accent hover:underline" onClick={async () => { try { await api.libraries.scan(lib.id); onLibrariesChange?.() } catch (e: any) { alert(e.message) } }}>扫描</button>
              <button className="text-red-400 hover:underline" onClick={async () => { try { await api.libraries.remove(lib.id); onLibrariesChange?.(); await load() } catch (e: any) { alert(e.message) } }}>删除</button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1 sm:flex-nowrap">
            <input id="new-lib-name" placeholder="名称" className="min-w-0 flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm" />
            <input id="new-lib-path" placeholder="绝对路径，如 D:\\Anime" className="min-w-0 flex-[2] bg-bg border border-border rounded-lg px-3 py-2 text-sm" />
            <button className="bg-accent text-white rounded-lg px-3 py-2 text-sm" onClick={async () => {
              const name = (document.getElementById('new-lib-name') as HTMLInputElement).value.trim()
              const p = (document.getElementById('new-lib-path') as HTMLInputElement).value.trim()
              if (!name || !p) return alert('名称和路径必填')
              try { await api.libraries.create({ name, path: p, type: 'anime' }); onLibrariesChange?.(); await load() }
              catch (e: any) { alert(e.message) }
            }}>添加</button>
          </div>
        </section>
      ),
    },
    {
      id: 'settings-rename', label: '标签与命名', content: (
        <section id="settings-rename" className="ui-panel scroll-mt-4 bg-[#111722]/88 border border-white/10 rounded-2xl p-4 space-y-3 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
          <h2 className="font-semibold">正则重命名（显示名）</h2>
          <p className="text-xs text-text-secondary leading-relaxed">
            对动漫库中番剧的<strong className="text-text-primary">显示名称</strong>批量正则替换（如去掉压制组前缀、季后缀、统一译名），
            <strong className="text-text-primary">不会改变磁盘上的实际文件名</strong>。支持捕获组（$1、$2…）与 $&（完整匹配）。
          </p>
          <div className="text-xs leading-relaxed border border-border/60 rounded-lg p-2 bg-bg/50">
            <span className="text-text-secondary">模板以标准命名为基准：</span>
            <code className="text-accent font-mono">[压制组] 中文名 (英文原名) [年份]</code>
            <div className="mt-1 text-text-secondary/80">
              例：
              <code className="text-text-primary font-mono">[T.H.X&amp;VCB-Studio&amp;Eupho] 冰菓 (Hyouka) [2012]</code>
              <span className="ml-1">
                ——「去压制组前缀」去掉 <code className="text-text-primary font-mono">[T.H.X&amp;VCB-Studio&amp;Eupho]</code>，
                「去年份后缀」去掉 <code className="text-text-primary font-mono">[2012]</code>，
                「去英文原名括号」去掉 <code className="text-text-primary font-mono">(Hyouka)</code>，
                即可得到 <code className="text-text-primary font-mono">冰菓</code>
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {REGEX_TEMPLATES.map(t => (
              <button key={t.label} title={t.hint}
                className={`text-xs px-2 py-1 rounded-full border transition-colors duration-150 ${rePattern === t.pattern ? 'border-accent text-accent bg-accent/10' : 'border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'}`}
                onClick={() => { setRePattern(t.pattern); setReMsg('') }}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs text-text-secondary">
            <span>匹配范围：</span>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="re-scope" checked={reScope === 'top'} onChange={() => setReScope('top')} className="accent-accent" />
              仅番剧主目录（与「全部媒体」视图一致，不含季/子目录）
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="re-scope" checked={reScope === 'all'} onChange={() => setReScope('all')} className="accent-accent" />
              所有目录
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input value={rePattern} onChange={e => { setRePattern(e.target.value); setReMsg('') }}
              placeholder="正则表达式，如 ^\[[^\]]+\]\s* 或 \[[^\]]*x?26[45][^\]]*\]"
              className="bg-bg border border-border rounded-lg px-3 py-2 text-sm flex-1 min-w-56 font-mono" />
            <input value={reRepl} onChange={e => setReRepl(e.target.value)}
              placeholder="替换为（留空 = 删除匹配）"
              className="bg-bg border border-border rounded-lg px-3 py-2 text-sm flex-1 min-w-40" />
            <label className="text-xs text-text-secondary flex items-center gap-1.5 shrink-0 cursor-pointer">
              <input type="checkbox" checked={reIgnore} onChange={e => setReIgnore(e.target.checked)} className="accent-accent" />
              忽略大小写
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button className="bg-accent text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50" disabled={reBusy || !rePattern.trim()}
              onClick={async () => {
                setReBusy(true); setReMsg('')
                try {
                  const r = await api.folders.renameRegex({ pattern: rePattern.trim(), replacement: reRepl, ignoreCase: reIgnore, scope: reScope })
                  setReList(r.changes); setReCount(r.count ?? 0)
                  setReMsg(r.count === 0 ? '没有匹配到需要重命名的条目' : `预览：将重命名 ${r.count} 条（最多显示 200 条）`)
                } catch (e: any) { setReMsg(`预览失败：${e.message}`) } finally { setReBusy(false) }
              }}>预览匹配</button>
            {reCount > 0 && (
              <button className="text-red-400 hover:underline text-sm disabled:opacity-50" disabled={reBusy}
                onClick={async () => {
                  if (!confirm(`确认将 ${reCount} 条显示名称按此规则重命名？\n\n磁盘上的实际文件名不会改变，详情页可随时双击单个名称修改。`)) return
                  setReBusy(true); setReMsg('')
                  try {
                    const r = await api.folders.renameRegex({ pattern: rePattern.trim(), replacement: reRepl, ignoreCase: reIgnore, scope: reScope, apply: true })
                    setReMsg(`已重命名 ${r.applied ?? 0} 条显示名称`)
                    setReList([]); setReCount(0)
                  } catch (e: any) { setReMsg(`重命名失败：${e.message}`) } finally { setReBusy(false) }
                }}>应用重命名（{reCount}）</button>
            )}
            {reMsg && <span className={`text-xs ${reMsg.startsWith('失败') || reMsg.startsWith('预览失败') ? 'text-red-400' : 'text-text-secondary'}`}>{reMsg}</span>}
          </div>
          {reList.length > 0 && (
            <div className="max-h-56 overflow-y-auto space-y-1 text-xs border border-border/60 rounded-lg p-2">
              {reList.map(c => (
                <div key={c.id} className="flex items-center gap-2">
                  <span className="text-text-secondary line-through truncate flex-1 min-w-0">{c.from}</span>
                  <span className="text-accent shrink-0">→</span>
                  <span className="truncate flex-1 min-w-0">{c.to}</span>
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-border/60 pt-3 flex flex-wrap items-center gap-3">
            <button className="text-red-400 hover:underline text-sm" disabled={reBusy}
              onClick={async () => {
                setReBusy(true); setReRestoreMsg('')
                try {
                  const r = await api.folders.restoreNames({ scope: reScope, dryRun: true })
                  if ((r.count ?? 0) === 0) { setReRestoreMsg('没有需要恢复的条目（当前范围内没有被重命名过的显示名）'); return }
                  if (!confirm(`将恢复 ${r.count} 条显示名称为磁盘实际目录名（如「[VCB-Studio] Another [2012]」），并解除防覆盖标记？\n\n${r.items.slice(0, 3).map(i => `· ${i.from.slice(0, 30)} → ${i.to.slice(0, 30)}`).join('\n')}${(r.count ?? 0) > 3 ? `\n· …等共 ${r.count} 条` : ''}`)) return
                  const a = await api.folders.restoreNames({ scope: reScope })
                  setReRestoreMsg(`已恢复 ${a.restored ?? 0} 条显示名称`)
                } catch (e: any) { setReRestoreMsg(`恢复失败：${e.message}`) } finally { setReBusy(false) }
              }}>显示名恢复为当前磁盘名</button>
            {reRestoreMsg && <span className={`text-xs ${reRestoreMsg.startsWith('失败') ? 'text-red-400' : 'text-text-secondary'}`}>{reRestoreMsg}</span>}
          </div>
        </section>
      ),
    },
    {
      id: 'settings-custom-tags', label: '自定义标签', content: (
        <section id="settings-custom-tags" className="ui-panel bg-[#111722]/88 border border-white/10 rounded-2xl p-4 space-y-3 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
          <h2 className="font-semibold">自定义标签</h2>
          {tags.map(t => (
            <div key={t.id} className="flex items-center gap-2 text-sm">
              <input className="bg-bg border border-border rounded px-2 py-1 flex-1" defaultValue={t.name}
                onBlur={async e => { const n = e.target.value.trim(); if (n && n !== t.name) { try { await api.tags.update(t.id, { name: n }); await load() } catch (err: any) { alert(err.message) } } }} />
              <input type="color" value={t.color} className="w-8 h-8" onChange={async e => { try { await api.tags.update(t.id, { color: e.target.value }); await load() } catch (err: any) { alert(err.message) } }} />
              <button className="text-red-400 hover:underline" onClick={async () => { try { await api.tags.remove(t.id); await load() } catch (err: any) { alert(err.message) } }}>删除</button>
            </div>
          ))}
        </section>
      ),
    },
    ...moduleSettingsSections.filter(section => !section.group).map(({ moduleId, id, label, component: Section }) => ({
      id, label,
      content: <ModuleErrorBoundary key={`${moduleId}:${id}`} moduleId={moduleId}>
        <Section onRefresh={onLibrariesChange} onBackgroundPreview={onBackgroundPreview} />
      </ModuleErrorBoundary>,
    })),
    {
      id: 'settings-modules', label: '模块管理', content: (
        <section id="settings-modules" className="ui-panel scroll-mt-4 space-y-3 rounded-2xl border border-white/10 bg-[#111722]/88 p-4 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold">模块管理</h2>
              <p className="mt-1 text-xs text-text-secondary">开关自动保存，重启服务后生效。服务就绪后页面会自动刷新，更新已加载的模块。</p>
            </div>
            <ServiceRestartControl disabled={moduleBusy !== null || restoring || backingUp} />
          </div>
          {snapshotError && <p role="alert" className="rounded-lg border border-red-300/20 bg-red-400/[0.07] px-3 py-2 text-xs text-red-200">模块状态读取失败：{snapshotError}</p>}
          {moduleError && <p role="alert" className="rounded-lg border border-red-300/20 bg-red-400/[0.07] px-3 py-2 text-xs text-red-200">{moduleError}</p>}
          {snapshot?.restartRequired && <p role="status" className="rounded-lg border border-amber-300/20 bg-amber-300/[0.07] px-3 py-2 text-xs text-amber-100">模块配置已改变，请重启 AnimeShelf 服务后生效。</p>}
          <div className="divide-y divide-white/[0.06]">
            {(snapshot?.modules ?? []).map(module => (
              <label key={module.id} className="flex items-start gap-3 py-3 text-sm">
                <input type="checkbox" className="mt-0.5 accent-accent" checked={module.configuredEnabled} disabled={moduleBusy !== null || restarting} onChange={event => { void updateModule(module.id, event.target.checked) }} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2"><strong className="font-medium text-text-primary">{module.name}</strong><code className="text-[10px] text-text-secondary/70">{module.id}</code></span>
                  <span className="mt-1 block text-xs text-text-secondary">当前启动：{module.active ? '已加载' : '未加载'} · 下次启动：{module.configuredEnabled ? '启用' : '停用'}{module.reason ? ` · ${module.reason}` : ''}{loadErrors[module.id] ? ` · 前端加载失败：${loadErrors[module.id]}` : ''}</span>
                  <span className="mt-1 block text-[11px] text-text-secondary/70">必需依赖：{module.requires.length > 0 ? module.requires.map(id => snapshot?.modules.find(candidate => candidate.id === id)?.name ?? id).join('、') : '无'} · 可选集成：{module.optional.length > 0 ? module.optional.map(id => snapshot?.modules.find(candidate => candidate.id === id)?.name ?? id).join('、') : '无'}</span>
                </span>
                {moduleBusy === module.id && <span className="text-xs text-accent">保存中…</span>}
              </label>
            ))}
          </div>
        </section>
      ),
    },
    {
      id: 'settings-credits', label: '关于与署名', content: <DataCredits />,
    },
    {
      id: 'settings-backup', label: '备份与恢复', content: (
        <section id="settings-backup" className="ui-panel scroll-mt-4 bg-[#111722]/88 border border-white/10 rounded-2xl p-4 space-y-3 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">数据备份</h2>
            <PartSave part="backup" keys={['backup_dir_auto', 'backup_dir_manual', 'backup_include_posters']} />
          </div>
          {databaseInfo && (
            <div className={`rounded-xl border px-3 py-2.5 ${databaseInfo.healthy ? 'border-emerald-400/20 bg-emerald-400/[0.055]' : 'border-red-400/30 bg-red-400/[0.07]'}`}>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-text-secondary">当前数据库</span>
                <span className={databaseInfo.healthy ? 'text-emerald-300' : 'text-red-300'}>
                  {databaseInfo.healthy ? '● 完整性正常' : '● 需要修复'}
                </span>
              </div>
              <div className="mt-1 break-all font-mono text-xs text-white/85" title={databaseInfo.databasePath}>{databaseInfo.databasePath}</div>
              <div className="mt-1 text-[11px] text-text-secondary/75">
                {(databaseInfo.databaseSize / 1048576).toFixed(1)} MB · Schema {databaseInfo.schemaVersion} · 开发版与便携版路径可能不同，请以这里显示的路径为准
              </div>
              {!databaseInfo.healthy && <div className="mt-1 break-all text-[11px] text-red-300/85">{databaseInfo.integrity.join('；')}</div>}
            </div>
          )}
          <p className="text-xs text-text-secondary">自动备份：每次后端启动时生成 SQLite 一致性快照到「自动备份目录」（保留最近 10 份）。</p>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={(settings.backup_include_posters ?? '1') !== '0'} className="accent-accent"
              onChange={e => set('backup_include_posters', e.target.checked ? '1' : '0')} />
            <span>备份时同步海报到共享海报库（增量，只复制新海报；恢复时优先从海报库补回，缺的再自动抓取）</span>
          </label>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-24 shrink-0 text-text-secondary">自动备份目录</span>
            <input className="min-w-0 flex-1 bg-bg border border-border rounded-lg px-3 py-1.5 text-sm" placeholder="留空 = data/backups/auto"
              value={settings.backup_dir_auto ?? ''}
              onChange={e => set('backup_dir_auto', e.target.value)} />
          </label>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-24 shrink-0 text-text-secondary">手动备份目录</span>
            <input className="min-w-0 flex-1 bg-bg border border-border rounded-lg px-3 py-1.5 text-sm" placeholder="留空 = 桌面"
              value={settings.backup_dir_manual ?? ''}
              onChange={e => set('backup_dir_manual', e.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="bg-accent text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50"
              disabled={backingUp}
              onClick={async () => {
                setBackingUp(true); setBackupMsg('')
                try {
                  const r = await api.settings.backup()
                  setBackupMsg(`✅ 已备份到：${r.path}`)
                } catch (e: any) {
                  setBackupMsg(`❌ ${e.message}`)
                } finally { setBackingUp(false) }
              }}>
              {backingUp ? '备份中…' : '立即备份'}
            </button>
            {backupMsg && <span className="text-xs text-text-secondary break-all">{backupMsg}</span>}
          </div>
          <BackupRestorePanel onRestored={onLibrariesChange} onBusyChange={setRestoring} />
        </section>
      ),
    },
  ]

  return (
    <div className="settings-page clean-page page-shell overflow-hidden">
      <header className="clean-page-header page-header ui-panel shrink-0">
        <h1 className="page-title">设置</h1>
        <p className="page-subtitle">管理媒体库、外观、模块与本地数据；分区独立保存，媒体库与标签即时生效。</p>
      </header>
      <div className="settings-layout grid flex-1 min-h-0 gap-5 lg:grid-cols-[190px_minmax(0,1fr)]">
        <aside className="settings-navigation hidden lg:block">
          <nav className="settings-navigation-list ui-panel-subtle sticky top-0 space-y-1 rounded-2xl border border-white/[0.08] bg-black/15 p-2 text-sm text-text-secondary" aria-label="设置分组">
            {settingsSections.map(({ id, label }) => (
              <a key={id} href={`#${id}`} className="block rounded-lg px-3 py-2 transition hover:bg-white/[0.055] hover:text-white"
                onClick={event => {
                  event.preventDefault()
                  const container = contentRef.current
                  const section = container?.querySelector<HTMLElement>(`#${id}`)
                  if (!container || !section) return
                  container.scrollTo({ top: container.scrollTop + section.getBoundingClientRect().top - container.getBoundingClientRect().top, behavior: 'instant' })
                  section.tabIndex = -1
                  section.focus({ preventScroll: true })
                }}>{label}</a>
            ))}
          </nav>
        </aside>
        <div ref={contentRef} className="settings-form-content min-h-0 overflow-y-auto pr-1 space-y-6 pb-6">
          {settingsSections.map(({ id, content }) => (
            <Fragment key={id}>{content}</Fragment>
          ))}
        </div>
      </div>
      {lastEditingLibrary.current && (
        <LibraryEditDialog
          open={editingLibrary !== null}
          library={lastEditingLibrary.current}
          onClose={() => setEditingLibrary(null)}
          onSaved={updated => {
            setLibraries(current => current.map(library => library.id === updated.id ? updated : library))
            onLibrariesChange?.()
          }} />
      )}
    </div>
  )
}
