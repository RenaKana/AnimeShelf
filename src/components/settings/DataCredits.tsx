import tmdbLogo from '../../assets/tmdb-approved.svg'

export default function DataCredits() {
  return <section id="settings-credits" className="ui-panel scroll-mt-4 space-y-3 rounded-2xl border border-border bg-surface p-4">
    <h2 className="font-semibold">关于 · 数据来源与署名</h2>
    <div className="flex flex-wrap items-center gap-3">
      <a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer" aria-label="The Movie Database (TMDB)">
        <img src={tmdbLogo} alt="TMDB" width="110" height="15" />
      </a>
      <p className="text-xs text-text-secondary">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </div>
    <p className="text-xs text-text-secondary">放送数据：<a className="text-accent" href="https://github.com/bangumi-data/bangumi-data" target="_blank" rel="noopener noreferrer">bangumi-data</a> · CC BY 4.0（原数据随依赖提供，应用进行格式转换与筛选）。普通元数据还使用 Bangumi 与 AniList，图片权利属于各权利人。</p>
    <p className="text-xs text-text-secondary">项目代码采用 MIT 许可（© 2026 Rena）；第三方许可及部分服务使用条件另见随包声明，未决项仍待确认。署名不代表数据提供方认可本项目。</p>
  </section>
}
