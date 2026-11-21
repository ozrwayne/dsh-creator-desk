// 收藏与知识原子的手动整理。
import React from 'react'
import { detectSourcePlatform } from './card.jsx'
import { archiveFavorite, archiveFavoriteBatch, confirmAtom, createPiece, getDesk, loadFavoriteSpan, loadInbox, loadInboxItem, openPiece, rejectAtom, renameAtom, report, request, retryIngest, saveAtom, searchFavorites, setDesk, toast, useDesk, useInboxRefresh } from './desk.js'
import { lang, t } from './i18n.js'
import { PlatformLogo } from './platforms.jsx'
import { Dialog, Empty, Icon, IconButton, Segmented } from './ui.jsx'
import { renderMarkdown } from './util.js'

const META = ['日期', '来源', '标签']

const tr = (zh, en) => lang() === 'en' ? en : zh


function sourceMatches(row, filters) {
  if (filters.origin && filters.origin !== 'all' && row.origin !== filters.origin) return false
  if (filters.handle && row.handle !== filters.handle) return false
  if (filters.path && (row.fromBench?.path || row.benchPath) !== filters.path) return false
  return true
}

function SourceFilter({ rows, origin, handle, path }) {
  const handles = [...new Set(rows.filter(row => row.origin === 'bench' && row.handle).map(row => row.handle))].sort()
  return <>
    <select className="md-clean-select" aria-label={t('来源')} value={handle ? `handle:${handle}` : origin} onChange={event => {
      const value = event.target.value
      setDesk({ pendingOrigin: value.startsWith('handle:') ? 'bench' : value, pendingHandle: value.startsWith('handle:') ? value.slice(7) : '', pendingBenchPath: '' })
    }}>
      <option value="all">{tr('全部来源', 'All sources')}</option>
      <option value="fav">{t('收藏')}</option>
      <option value="bench">{tr('对标', 'Benchmarks')}</option>
      {handles.map(value => <option key={value} value={`handle:${value}`}>@{value}</option>)}
    </select>
    {path ? <button type="button" className="md-btn is-small" onClick={() => setDesk({ pendingBenchPath: '' })}>{tr('清除原文筛选', 'Clear source file filter')}</button> : null}
  </>
}

const FAV_RANGE_KEY = 'dsh-media-desk-fav-range'
const FAV_PAGE = 30

function readFavRange() {
  try {
    const value = localStorage.getItem(FAV_RANGE_KEY)
    return value === '30' || value === 'all' ? value : '3'
  } catch {
    return readFavRange.mem || '3'
  }
}

function rememberFavRange(value) {
  readFavRange.mem = value
  try { localStorage.setItem(FAV_RANGE_KEY, value) } catch { /* 隐私模式只记在这次打开里 */ }
}

function favDays(range) {
  return range === 'all' ? 'all' : Number(range)
}

function safeUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

function renderBody(item) {
  const html = renderMarkdown(item.body || '')
  if (item.place !== 'fav') return html
  return html.replace(/!\[\[[^\]]*\/images\/([\w.-]+)\|Image\]\]/g, (match, name) => {
    if (name === '.' || name === '..' || name.includes('..')) return match
    return `<img class="md-atom-img" src="media-desk/inbox/image?name=${encodeURIComponent(name)}" alt="">`
  })
}

function confirmBox(title, submitLabel, note, onSubmit) {
  setDesk({ dialog: { title, submitLabel, fields: [{ name: 'note', type: 'hidden', label: note }], onSubmit } })
}

// 列表里的 id 是「atom:相对路径」，稿件接口认的是笔记名（文件名去掉 .md）
function noteOf(id) {
  return String(id || '').split('/').pop().replace(/\.md$/, '')
}

// 看板里带 merged 的长文稿件，哪些并入了这条原子
function mergedTitlesOf(note, pieces) {
  return (pieces || []).filter(piece => (piece.merged || []).includes(note)).map(piece => piece.title).filter(Boolean)
}

function askTitle(id) {
  const originNote = noteOf(id)
  setDesk({
    dialog: {
      title: t('开内容线'),
      submitLabel: t('新建'),
      fields: [{ name: 'title', label: t('短推标题'), required: true }],
      onSubmit: (values) => {
        const title = String(values.title || '').trim()
        if (!title) return
        createPiece({ form: '短推', title, originNote }).then(() => setDesk({ atomOpen: null })).catch(report)
      },
    },
  })
}

function favLabel() {
  return lang() === 'en' ? t('收藏（素材）') : t('收藏')
}

function IngestNote({ ingest }) {
  if (!ingest) return null
  const running = ingest.running || 0
  const queued = ingest.queued || 0
  const failedRows = (ingest.recent || []).filter(row => row.status === 'failed')
  if (!running && !queued && !ingest.failed && !failedRows.length) return null
  let active = null
  if (running && queued) active = t('Wiki 收录：{running} 篇进行中，{queued} 篇排队', { running, queued })
  else if (running) active = t('Wiki 收录：{n} 篇进行中', { n: running })
  else if (queued) active = t('Wiki 收录：{n} 篇排队', { n: queued })
  return (
    <p className="md-atom-ingest">
      {active ? <span>{active}</span> : null}
      {failedRows.map(row => (
        <span key={row.id} className="md-atom-ingest-fail">
          {t('Wiki 收录失败 {n} 篇：{title}', { n: 1, title: row.title })}
          <button type="button" className="md-btn is-small" onClick={() => retryIngest(row.id)}>{t('重试')}</button>
        </span>
      ))}
      {!failedRows.length && ingest.failed ? <span>{t('Wiki 收录失败 {n} 篇', { n: ingest.failed })}</span> : null}
    </p>
  )
}

const LEVELS = ['高', '中', '低']
const LEVEL_RANK = { 高: 3, 中: 2, 低: 1 }

function levelOf(value) {
  const text = String(value || '').trim()
  return LEVELS.find(level => text.startsWith(level)) || ''
}

function pendingFilters(desk = getDesk()) {
  return {
    q: desk.pendingQ || '',
    traffic: desk.pendingTraffic || 'all',
    value: desk.pendingValue || 'all',
    sort: desk.pendingSort || 'new',
    origin: desk.pendingOrigin || 'all',
    handle: desk.pendingHandle || '',
    path: desk.pendingBenchPath || '',
  }
}

function orderedPending(rows, filters = pendingFilters()) {
  const query = String(filters.q || '').trim().toLowerCase()
  const list = (rows || []).filter(row => {
    if (!sourceMatches(row, filters)) return false
    if (query && !`${row.title || ''}\n${row.excerpt || ''}`.toLowerCase().includes(query)) return false
    if (filters.traffic !== 'all' && levelOf(row.meta?.流量) !== filters.traffic) return false
    if (filters.value !== 'all' && levelOf(row.meta?.商业价值) !== filters.value) return false
    return true
  })
  return [...list].sort((a, b) => {
    if (filters.sort === 'value') {
      const diff = (LEVEL_RANK[levelOf(b.meta?.商业价值)] || 0) - (LEVEL_RANK[levelOf(a.meta?.商业价值)] || 0)
      if (diff) return diff
    }
    const date = (a.date || '').localeCompare(b.date || '')
    if (date) return filters.sort === 'old' ? date : -date
    return (a.title || '').localeCompare(b.title || '', 'zh')
  })
}

const REVIEW_KEY = 'dsh-media-desk-pending-review'

export async function resumeReview() {
  const from = getDesk().view
  try {
    const { pending } = await loadInbox()
    if (getDesk().view !== from) return
    let saved
    try { saved = localStorage.getItem(REVIEW_KEY) } catch { /* Storage may be disabled. */ }
    const filters = { ...pendingFilters({}), sort: 'old' }
    const list = orderedPending(pending, filters)
    setDesk({ view: 'atoms', atomTab: 'pending', focusId: null,
      atomOpen: (list.find(row => row.id === saved) || list[0])?.id ?? null,
      pendingQ: '', pendingTraffic: 'all', pendingValue: 'all', pendingSort: 'old',
      pendingOrigin: 'all', pendingHandle: '', pendingBenchPath: '', pendingRelationsOnly: false })
  } catch (err) { report(err) }
}

function AtomBentoCard({ row, isAtom, line, mergedInto = [], onOpen, onLineAction }) {
  const trafficLvl = levelOf(row.meta?.流量)
  const valLvl = levelOf(row.meta?.商业价值)
  const mechanism = String(row.meta?.机制 || '').trim()
  const audience = String(row.meta?.谁会看 || '').trim()
  const srcPlat = row.origin === 'bench' ? 'X' : detectSourcePlatform(row.group || '')
  return (
    <article className={`md-bento-card md-insight-bento-card ${isAtom ? 'is-confirmed' : 'is-pending'}`}>
      <div className="md-insight-card-top">
        <div className="md-insight-card-tags">
          {row.origin === 'bench' && row.handle ? (
            <span className="md-insight-src-chip">
              <PlatformLogo platform="X" size={13} />
              <span>@{row.handle}</span>
            </span>
          ) : row.group ? (
            <span className="md-insight-domain-chip">
              {srcPlat ? <PlatformLogo platform={srcPlat} size={13} /> : null}
              <span>{row.group}</span>
            </span>
          ) : (
            <span className="md-insight-domain-chip">{isAtom ? t('知识原子') : t('待确认')}</span>
          )}
          {valLvl ? (
            <em className={`md-insight-lvl is-val-${valLvl === '高' ? 'high' : valLvl === '中' ? 'mid' : 'low'}`}>
              {tr('商业', 'Val')}·{t(valLvl)}
            </em>
          ) : null}
          {trafficLvl ? (
            <em className={`md-insight-lvl is-trf-${trafficLvl === '高' ? 'high' : trafficLvl === '中' ? 'mid' : 'low'}`}>
              {t('流量')}·{t(trafficLvl)}
            </em>
          ) : null}
        </div>
        {row.date ? <time className="md-insight-date">{row.date}</time> : null}
      </div>

      <button type="button" className="md-insight-card-body" onClick={onOpen}>
        <h3>{row.title}</h3>
        {(mechanism || row.excerpt) ? (
          <p className="md-insight-mech">
            {mechanism ? <b>{tr('机制：', 'Mechanism: ')}</b> : null}
            {mechanism || row.excerpt}
          </p>
        ) : null}
        {audience ? (
          <span className="md-insight-aud">{tr('受众：', 'Audience: ')}{audience}</span>
        ) : null}
      </button>

      {mergedInto.length ? (
        <div className="md-insight-merged-row">
          {mergedInto.map(title => <span key={title} className="md-atom-merged">{t('已并入《{title}》', { title })}</span>)}
        </div>
      ) : null}


      <footer className="md-insight-card-foot">
        <button type="button" className="md-act-btn" onClick={onOpen}>
          <Icon name="eye" size={12} />
          <span>{isAtom ? tr('查看详情', 'Details') : tr('审阅确认', 'Review')}</span>
        </button>
        {isAtom && onLineAction ? (
          <button type="button" className={`md-act-btn ${line ? 'is-accent' : 'is-primary'}`} onClick={onLineAction}>
            <Icon name="branch" size={12} />
            <span>{line ? t('查看流程') : t('开内容线')}</span>
          </button>
        ) : null}
      </footer>
    </article>
  )
}

export function AtomsView() {
  const inbox = useDesk(s => s.inbox)
  const tab = useDesk(s => s.atomTab || 'fav')
  const ingest = inbox?.ingest
  const live = (ingest?.queued || 0) + (ingest?.running || 0) > 0
  useInboxRefresh(live ? 5000 : 30000)
  const [q, setQ] = React.useState('')
  const [hits, setHits] = React.useState(null)
  const [searching, setSearching] = React.useState(false)
  const [picked, setPicked] = React.useState({})
  const [batch, setBatch] = React.useState(null)
  const [fails, setFails] = React.useState(null)
  const lines = useDesk(s => s.board?.lines)
  const boardPieces = useDesk(s => s.board?.pieces)
  const lineList = lines || []
  const pendingQ = useDesk(s => s.pendingQ || '')
  const pendingTraffic = useDesk(s => s.pendingTraffic || 'all')
  const pendingValue = useDesk(s => s.pendingValue || 'all')
  const pendingSort = useDesk(s => s.pendingSort || 'new')
  const pendingOrigin = useDesk(s => s.pendingOrigin || 'all')
  const pendingHandle = useDesk(s => s.pendingHandle || '')
  const pendingBenchPath = useDesk(s => s.pendingBenchPath || '')
  const atomLine = useDesk(s => s.atomLine || 'all')
  const query = q.trim()
  const [range, setRange] = React.useState(readFavRange)
  const [span, setSpan] = React.useState(null)
  const [spanBusy, setSpanBusy] = React.useState(false)
  const viewRef = React.useRef({ query: '', range: '3', shown: 0 })
  const favorites = query ? (hits?.favorites ?? []) : (span?.favorites ?? [])
  const listMeta = query ? hits : span
  const counts = inbox?.counts ?? { favorites: (inbox?.favorites ?? []).length, pending: (inbox?.pending ?? []).length, atoms: (inbox?.atoms ?? []).length }
  viewRef.current = { query, range, shown: favorites.length }

  React.useEffect(() => {
    if (tab !== 'fav' || !query) { setHits(null); return undefined }
    let stop = false
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        const data = await searchFavorites(query, 0)
        if (!stop) setHits(data)
      } catch (err) {
        if (!stop) report(err)
      } finally {
        if (!stop) setSearching(false)
      }
    }, 300)
    return () => { stop = true; clearTimeout(timer) }
  }, [query, tab])

  React.useEffect(() => {
    if (tab !== 'fav' || query) return undefined
    let stop = false
    setSpan(null)
    setSpanBusy(true)
    loadFavoriteSpan(favDays(range), 0, FAV_PAGE).then(data => {
      if (!stop) setSpan(data)
    }).catch(err => {
      if (!stop) report(err)
    }).finally(() => {
      if (!stop) setSpanBusy(false)
    })
    return () => { stop = true }
  }, [tab, query, range])

  const startLine = (row) => askTitle(row.id)
  const refreshList = async () => {
    const view = viewRef.current
    const limit = Math.max(FAV_PAGE, view.shown)
    if (view.query) {
      const data = await searchFavorites(view.query, 0, limit).catch(err => { report(err); return null })
      if (data) setHits(data)
      return
    }
    const data = await loadFavoriteSpan(favDays(view.range), 0, limit).catch(err => { report(err); return null })
    if (data) setSpan(data)
  }
  const more = async () => {
    if (query) {
      if (!hits?.favoriteMore) return
      const data = await searchFavorites(query, hits.favorites.length).catch(err => { report(err); return null })
      if (!data) return
      setHits({ ...data, favorites: [...hits.favorites, ...data.favorites] })
      return
    }
    if (!span?.favoriteMore) return
    const data = await loadFavoriteSpan(favDays(range), span.favorites.length, FAV_PAGE).catch(err => { report(err); return null })
    if (!data) return
    setSpan({ ...data, favorites: [...span.favorites, ...data.favorites] })
  }
  const pickRange = (value) => {
    rememberFavRange(value)
    setRange(value)
  }
  const chosen = Object.entries(picked)
  const togglePick = (row) => {
    setPicked(prev => {
      const next = { ...prev }
      if (next[row.id]) delete next[row.id]
      else next[row.id] = row.title || t('无标题')
      return next
    })
  }
  const selectShown = () => {
    setPicked(prev => {
      const next = { ...prev }
      for (const row of favorites) {
        next[row.id] = row.title || t('无标题')
      }
      return next
    })
  }
  const askArchive = () => {
    if (!chosen.length) return
    const titles = Object.fromEntries(chosen)
    setBatch({
      title: t('归档'),
      submit: t('归档'),
      note: t('这 {n} 篇会移到已处理收藏，并逐篇在后台收录进 Wiki（gpt-6.1-sol）。', { n: chosen.length }),
      titles: chosen.map(([, title]) => title),
      run: async () => {
        const ids = chosen.map(([id]) => id)
        setBatch(null)
        const data = await archiveFavoriteBatch(ids)
        if (!data) return
        const failedIds = new Set((data.failed || []).map(row => row.id))
        setPicked(prev => {
          const next = {}
          for (const [id, title] of Object.entries(prev)) if (failedIds.has(id)) next[id] = title
          return next
        })
        if (data.failed?.length) setFails(data.failed.map(row => ({ id: row.id, title: titles[row.id] || row.id, error: row.error })))
        else toast(t('已归档'))
        refreshList()
      },
    })
  }
  const pendingAll = inbox?.pending ?? []
  const sourceFilters = { origin: pendingOrigin, handle: pendingHandle, path: pendingBenchPath }
  const pendingShown = orderedPending(pendingAll, { q: pendingQ, traffic: pendingTraffic, value: pendingValue, sort: pendingSort, ...sourceFilters })
  const atomRows = (inbox?.atoms ?? []).filter(row => {
    if (!sourceMatches(row, sourceFilters)) return false
    const lined = lineList.some(item => item.originNote === noteOf(row.id))
    if (atomLine === 'open') return !lined
    if (atomLine === 'lined') return lined
    return true
  })

  return (
    <div className="md-board-page md-atom-bento-page">
      <div className="md-atom-shell">
        <div className="md-atom-pipeline" role="tablist" aria-label={t('知识原子分段')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'fav'}
            className={`md-bento-card md-pipe-stage is-blue ${tab === 'fav' ? 'is-on' : ''}`}
            onClick={() => setDesk({ atomTab: 'fav' })}
          >
            <div className="md-pipe-top">
              <span className="md-pipe-icon"><Icon name="bookmark" size={17} /></span>
              <span className="md-pipe-step">STEP 01</span>
            </div>
            <strong>{counts.favorites}</strong>
            <span className="md-pipe-title">{favLabel()}</span>
            <small>{tr('已保存的素材', 'Raw saved materials')}</small>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pending'}
            className={`md-bento-card md-pipe-stage is-purple ${tab === 'pending' ? 'is-on' : ''}`}
            onClick={() => setDesk({ atomTab: 'pending' })}
          >
            <div className="md-pipe-top">
              <span className="md-pipe-icon"><Icon name="spark" size={17} /></span>
              <span className="md-pipe-step">STEP 02</span>
            </div>
            <strong>{counts.pending}</strong>
            <span className="md-pipe-title">{t('待确认')}</span>
            <small>{tr('等待你确认的笔记', 'Candidate insights')}</small>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'atoms'}
            className={`md-bento-card md-pipe-stage is-green ${tab === 'atoms' ? 'is-on' : ''}`}
            onClick={() => setDesk({ atomTab: 'atoms' })}
          >
            <div className="md-pipe-top">
              <span className="md-pipe-icon"><Icon name="star" size={17} /></span>
              <span className="md-pipe-step">STEP 03</span>
            </div>
            <strong>{counts.atoms}</strong>
            <span className="md-pipe-title">{t('知识原子')}</span>
            <small>{tr('已入库可开内容线', 'Confirmed knowledge atoms')}</small>
          </button>
        </div>

        <IngestNote ingest={inbox?.ingest} />

        {tab === 'fav' ? (
          <div className="md-atom-pane">
            <div className="md-bento-card md-atom-toolbar">
              <div className="md-search md-atom-search">
                <Icon name="search" size={14} />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('搜索收藏')} aria-label={t('搜索收藏')} />
              </div>
              <Segmented
                label={t('收藏时间范围')}
                value={range}
                disabled={Boolean(query)}
                onChange={pickRange}
                options={[{ value: '3', label: t('近 3 天') }, { value: '30', label: t('近 30 天') }, { value: 'all', label: t('全部') }]}
              />
              {listMeta ? <span className="md-filter-count" style={{ marginLeft: 'auto' }}>{t('共 {n} 篇，已显示 {m} 篇', { n: listMeta.favoriteTotal ?? favorites.length, m: favorites.length })}</span> : null}
            </div>

            {!favorites.length ? <div className="md-bento-card"><Empty title={searching || spanBusy ? t('正在搜索') : t('没有待处理的收藏')} /></div> : (
              <>
                <div className="md-atom-batch">
                  <button type="button" className="md-btn is-small" onClick={selectShown}>{t('全选当前列表')}</button>
                  {chosen.length ? (
                    <>
                      <span>{t('已选 {n} 篇', { n: chosen.length })}</span>
                      <button type="button" className="md-btn is-small" onClick={askArchive}>{t('归档')}</button>
                      <button type="button" className="md-btn is-small" onClick={() => setPicked({})}>{t('取消选择')}</button>
                    </>
                  ) : null}
                </div>
                <ul className="md-atom-list">
                  {favorites.map(row => {
                    const url = safeUrl(row.url)
                    const srcPlat = detectSourcePlatform(`${row.source || ''} ${row.url || ''}`)
                    const thumbSrc = row.image ? `media-desk/inbox/image?name=${encodeURIComponent(row.image)}` : null
                    return (
                      <li key={row.id} className="md-bento-card md-fav-bento-card">
                        <input type="checkbox" className="md-atom-check" checked={Boolean(picked[row.id])} aria-label={row.title || t('无标题')} onChange={() => togglePick(row)} />
                        <div className="md-fav-visual" onClick={() => setDesk({ atomOpen: row.id })}>
                          {thumbSrc ? (
                            <img src={thumbSrc} alt="" loading="lazy" />
                          ) : srcPlat ? (
                            <PlatformLogo platform={srcPlat} size={28} />
                          ) : (
                            <Icon name="bookmark" size={20} />
                          )}
                        </div>
                        <button type="button" className="md-atom-row-main" onClick={() => setDesk({ atomOpen: row.id })}>
                          <div className="md-fav-meta-row">
                            {row.source ? <span className="md-fav-src-pill">{row.source}</span> : null}
                            {row.author ? <span className="md-fav-author">{row.author}</span> : null}
                            {row.saved ? <time>{row.saved.slice(0, 10)}</time> : null}
                          </div>
                          <strong>{row.title}</strong>
                          {row.excerpt ? <p>{row.excerpt}</p> : null}
                        </button>
                        <div className="md-atom-ops">
                          <button type="button" className="md-act-btn" onClick={() => confirmBox(t('归档这篇收藏'), t('归档'), t('这篇收藏会移到已处理收藏，并在后台收录进 Wiki。'), async () => { if (await archiveFavorite(row.id)) refreshList() })}>{t('归档')}</button>
                          {url ? <a className="md-act-btn" href={url} target="_blank" rel="noreferrer">{t('原文')}</a> : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
            {listMeta?.favoriteMore ? <button type="button" className="md-btn md-atom-more" onClick={more}>{t('加载更多')}</button> : null}
          </div>
        ) : null}

        {tab === 'pending' ? (
          <div className="md-atom-pane">
            <div className="md-bento-card md-atom-toolbar">
              <SourceFilter rows={[...pendingAll, ...(inbox?.atoms || [])]} origin={pendingOrigin} handle={pendingHandle} path={pendingBenchPath} />
              <div className="md-search md-atom-search">
                <Icon name="search" size={14} />
                <input value={pendingQ} onChange={event => setDesk({ pendingQ: event.target.value })} placeholder={t('搜索待确认')} aria-label={t('搜索待确认')} />
              </div>
              <select className="md-clean-select" aria-label={t('流量')} value={pendingTraffic} onChange={event => setDesk({ pendingTraffic: event.target.value })}>
                <option value="all">{t('流量')}</option>
                {LEVELS.map(level => <option key={level} value={level}>{t(level)}</option>)}
              </select>
              <select className="md-clean-select" aria-label={t('商业价值')} value={pendingValue} onChange={event => setDesk({ pendingValue: event.target.value })}>
                <option value="all">{t('商业价值')}</option>
                {LEVELS.map(level => <option key={level} value={level}>{t(level)}</option>)}
              </select>
              <select className="md-clean-select" aria-label={t('排序')} value={pendingSort} onChange={event => setDesk({ pendingSort: event.target.value })}>
                <option value="new">{t('日期新到旧')}</option>
                <option value="old">{t('日期旧到新')}</option>
                <option value="value">{t('商业价值高到低')}</option>
              </select>
              <span className="md-filter-count" style={{ marginLeft: 'auto' }}>{t('共 {n} 条，筛出 {m} 条', { n: pendingAll.length, m: pendingShown.length })}</span>
            </div>

            {!pendingAll.length ? <div className="md-bento-card"><Empty title={t('没有待确认的笔记')} /></div> : !pendingShown.length ? <div className="md-bento-card"><Empty title={t('没有符合筛选的笔记')} /></div> : (
              <div className="md-atom-bento-grid">
                {pendingShown.map(row => (
                  <AtomBentoCard
                    key={row.id}
                    row={row}
                    isAtom={false}
                    onOpen={() => setDesk({ atomOpen: row.id })}
                  />
                ))}
              </div>
            )}
          </div>
        ) : null}

        {tab === 'atoms' ? (
          <div className="md-atom-pane">
            <div className="md-bento-card md-atom-toolbar">
              <SourceFilter rows={[...pendingAll, ...(inbox?.atoms || [])]} origin={pendingOrigin} handle={pendingHandle} path={pendingBenchPath} />
              <Segmented
                label={t('内容线')}
                value={atomLine}
                onChange={value => setDesk({ atomLine: value })}
                options={[{ value: 'all', label: t('全部') }, { value: 'open', label: t('未开线') }, { value: 'lined', label: t('已开线') }]}
              />
              <span className="md-filter-count" style={{ marginLeft: 'auto' }}>{tr(`共 ${atomRows.length} 个知识原子`, `${atomRows.length} atoms`)}</span>
            </div>

            {!inbox?.atoms?.length ? <div className="md-bento-card"><Empty title={t('没有已确认的知识原子')} /></div> : !atomRows.length ? <div className="md-bento-card"><Empty title={t('没有符合筛选的知识原子')} /></div> : (
              <div className="md-atom-bento-grid">
                {atomRows.map(row => {
                  const line = lineList.find(item => item.originNote === noteOf(row.id))
                  const mergedInto = mergedTitlesOf(noteOf(row.id), boardPieces)
                  return (
                    <AtomBentoCard
                      key={row.id}
                      row={row}
                      isAtom
                      line={line}
                      mergedInto={mergedInto}
                      onOpen={() => setDesk({ atomOpen: row.id })}
                      onLineAction={() => line ? (setDesk({ view: 'flow' }), openPiece(line.nodes.find(node => node.pieces.length)?.pieces[0]?.note)) : startLine(row)}
                    />
                  )
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>
      {batch ? (
        <Dialog title={batch.title} onClose={() => setBatch(null)} width={520}>
          <p className="md-atom-note">{batch.note}</p>
          <ul className={batch.titles.length > 12 ? 'md-batch-list is-scroll' : 'md-batch-list'}>
            {batch.titles.map((title, index) => <li key={`${index}-${title}`}>{title}</li>)}
          </ul>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setBatch(null)}>{t('取消')}</button>
            <button type="button" className="md-btn is-primary" onClick={batch.run}>{batch.submit}</button>
          </div>
        </Dialog>
      ) : null}
      {fails ? (
        <Dialog title={t('有收藏没有归档')} onClose={() => setFails(null)} width={520}>
          <ul className="md-batch-list is-scroll">
            {fails.map(row => <li key={row.id}><b>{row.title}</b> {row.error}</li>)}
          </ul>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn is-primary" onClick={() => setFails(null)}>{t('关闭')}</button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

function LineButton({ id }) {
  const lines = useDesk(s => s.board?.lines || [])
  const line = lines.find(row => row.originNote === noteOf(id))
  return (
    <button type="button" className="md-btn is-primary" onClick={() => {
      if (line) {
        setDesk({ view: 'flow', atomOpen: null })
        openPiece(line.nodes.find(node => node.pieces.length)?.pieces[0]?.note)
        return
      }
      askTitle(id)
    }}>{line ? t('查看流程') : t('开内容线')}</button>
  )
}

export function AtomReader() {
  const view = useDesk(s => s.view)
  const id = useDesk(s => s.atomOpen)
  const inbox = useDesk(s => s.inbox)
  const [item, setItem] = React.useState(null)
  const [wikiBusy, setWikiBusy] = React.useState(false)
  const [ask, setAsk] = React.useState(false)
  const [conflict, setConflict] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [leave, setLeave] = React.useState(null)
  const heldId = React.useRef(id)
  const leaving = React.useRef(false)
  const saving = React.useRef(false)
  const dirty = editing && draft !== (item?.raw ?? '')
  const dirtyRef = React.useRef(dirty)
  const saveRef = React.useRef(null)
  const placeRef = React.useRef(item?.place)
  placeRef.current = item?.place
  dirtyRef.current = leaving.current ? false : dirty

  React.useEffect(() => {
    if (dirtyRef.current && id === heldId.current && view === 'atoms') return undefined
    if (dirtyRef.current && (id !== heldId.current || view !== 'atoms')) {
      setLeave({ kind: 'switch', id, view })
      setDesk({ atomOpen: heldId.current, view: 'atoms' })
      return undefined
    }
    leaving.current = false
    heldId.current = id
    if (view !== 'atoms' || !id) { setItem(null); setEditing(false); return undefined }
    let stop = false
    loadInboxItem(id).then(data => {
      if (stop) return
      if (data.place === 'pending') {
        try { localStorage.setItem(REVIEW_KEY, id) } catch { /* Reading still works without storage. */ }
      }
      setItem(data)
      setDraft(data.raw || '')
      setEditing(false)
    }).catch(err => {
      if (stop) return
      report(err)
      setDesk({ atomOpen: null })
    })
    return () => { stop = true }
  }, [id, view])

  const applyLeave = (next) => {
    setLeave(null)
    setEditing(false)
    setDraft(item?.raw || '')
    if (!next || next.kind === 'cancel') return
    leaving.current = true
    dirtyRef.current = false
    if (next.kind === 'close') setDesk({ atomOpen: null })
    else setDesk({ atomOpen: next.id, view: next.view || 'atoms' })
  }
  const requestLeave = (next) => {
    if (dirtyRef.current) setLeave(next)
    else applyLeave(next)
  }
  const save = async () => {
    if (!item || saving.current) return
    saving.current = true
    try {
      const saved = await saveAtom({ id, raw: draft, mtimeMs: item.mtimeMs })
      if (!saved) return
      if (saved.conflict) { setConflict(true); return }
      const data = await loadInboxItem(id)
      setItem(data)
      setDraft(data.raw || '')
      setEditing(false)
    } catch (err) {
      report(err)
    } finally {
      saving.current = false
    }
  }
  saveRef.current = save

  React.useEffect(() => {
    if (view !== 'atoms' || !id) return undefined
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        if (!editing) return
        event.preventDefault()
        if (document.querySelector('.md-dialog')) return
        saveRef.current()
        return
      }
      const typing = event.target?.closest?.('input, textarea, select, [contenteditable="true"]')
      const step = event.key === 'j' || event.key === 'J' || event.key === 'ArrowRight' ? 1 : (event.key === 'k' || event.key === 'K' || event.key === 'ArrowLeft' ? -1 : 0)
      if (step && placeRef.current === 'pending' && !editing && !typing && !ask && !leave && !event.metaKey && !event.ctrlKey && !event.altKey && !document.querySelector('.md-dialog')) {
        event.preventDefault()
        const desk = getDesk()
        const list = orderedPending(desk.inbox?.pending, pendingFilters(desk))
        const index = list.findIndex(row => row.id === id)
        const target = index >= 0 ? list[index + step] : null
        if (target) setDesk({ atomOpen: target.id, atomTab: 'pending' })
        return
      }
      if (event.key !== 'Escape' || ask || leave || document.querySelector('.md-dialog')) return
      requestLeave({ kind: 'close' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ask, editing, id, leave, view])

  if (view !== 'atoms' || !id) return null
  const pendingList = item?.place === 'pending' ? orderedPending(inbox?.pending, pendingFilters()) : []
  const pendingIndex = pendingList.findIndex(row => row.id === id)
  const stepPending = (delta) => {
    const target = pendingList[pendingIndex + delta]
    if (pendingIndex < 0 || !target) return
    setDesk({ atomOpen: target.id, atomTab: 'pending' })
  }
  const nextPending = () => {
    if (pendingIndex < 0) return pendingList[0]?.id ?? null
    return pendingList[pendingIndex + 1]?.id ?? null
  }
  const archivedFav = item?.place === 'fav' && String(item.path || '').startsWith('已处理收藏/')
  const askRename = () => {
    setDesk({
      dialog: {
        title: t('改标题'),
        submitLabel: t('保存'),
        initial: { title: item?.title || '' },
        fields: [{ name: 'title', label: t('标题'), required: true }],
        onSubmit: (values) => {
          const title = String(values.title || '').trim()
          if (!title) return
          renameAtom({ id, title }).then(next => {
            if (!next || next === id) return
            setDesk({ atomOpen: next })
          })
        },
      },
    })
  }
  return (
    <aside className="md-atom-read" role="dialog" aria-label={item?.title || t('阅读')}>
      <header className="md-atom-read-head">
        <h2>{item?.title || t('正在加载')}</h2>
        {item?.place === 'pending' && pendingIndex >= 0 ? <span className="md-atom-pos">{t('第 {n} 条 / 共 {m} 条', { n: pendingIndex + 1, m: pendingList.length })}</span> : null}
        {item?.place === 'pending' ? <button type="button" className="md-btn is-small" disabled={pendingIndex <= 0} onClick={() => stepPending(-1)}>{t('上一条')}</button> : null}
        {item?.place === 'pending' ? <button type="button" className="md-btn is-small" disabled={pendingIndex < 0 || pendingIndex >= pendingList.length - 1} onClick={() => stepPending(1)}>{t('下一条')}</button> : null}
        {item && ['pending', 'atom'].includes(item.place) && !editing ? <IconButton icon="edit" label={t('改标题')} onClick={askRename} /> : null}
        <IconButton icon="close" label={t('关闭')} onClick={() => requestLeave({ kind: 'close' })} />
      </header>
      {archivedFav ? <p className="md-atom-from">{t('已处理')}</p> : null}
      {item?.place === 'bench' && item.meta?.正文完整 === '否' ? <p className="md-atom-from md-bench-source-note is-warning">{tr('全文未取到', 'Full text unavailable')}</p> : null}
      {item?.fromBench ? <p className="md-atom-from">
        <button type="button" className="md-btn is-small" onClick={() => requestLeave({ kind: 'switch', id: `bench:${item.fromBench.path}`, view: 'atoms' })}>
          {tr('来自对标', 'From benchmark')}: @{item.fromBench.handle}《{item.fromBench.title}》
        </button>
      </p> : null}
      {item && item.place !== 'fav' && !editing ? (
        <dl className="md-atom-meta md-atom-meta-bento">
          {META.filter(key => item?.meta?.[key]).map(key => (
            <div key={key} className="md-atom-meta-tile"><dt>{t(key)}</dt><dd>{item.meta[key]}</dd></div>
          ))}
        </dl>
      ) : null}
      {editing ? (
        <div className="md-atom-read-body md-atom-edit">
          <textarea value={draft} aria-label={t('正文')} onChange={event => setDraft(event.target.value)} />
        </div>
      ) : (
        <div className="md-atom-read-body md-prose" dangerouslySetInnerHTML={item ? { __html: renderBody(item) } : undefined} />
      )}
      {editing ? (
        <footer className="md-atom-read-foot">
          <button type="button" className="md-btn is-primary" onClick={save}>{t('保存')}</button>
          <button type="button" className="md-btn" onClick={() => requestLeave({ kind: 'cancel' })}>{t('取消')}</button>
        </footer>
      ) : null}
      {!editing && item?.place === 'pending' ? (
        <footer className="md-atom-read-foot">
          <button type="button" className="md-btn is-primary" onClick={async () => {
            const next = nextPending()
            if (await confirmAtom(id)) setDesk({ atomOpen: next, atomTab: 'pending' })
          }}>{t('确认为知识原子')}</button>
          <button type="button" className="md-btn is-danger" onClick={() => setAsk(true)}>{t('否决')}</button>
          <button type="button" className="md-btn" onClick={() => { setDraft(item.raw || ''); setEditing(true) }}>{t('编辑')}</button>
        </footer>
      ) : null}
      {!editing && item?.place === 'atom' ? (
        <footer className="md-atom-read-foot">
          <LineButton id={id} />
          <button type="button" className="md-btn" onClick={() => { setDraft(item.raw || ''); setEditing(true) }}>{t('编辑')}</button>
        </footer>
      ) : null}
      {!editing && item?.place === 'bench' ? <footer className="md-atom-read-foot">
        {safeUrl(item.url) ? <a className="md-btn" href={safeUrl(item.url)} target="_blank" rel="noreferrer">{tr('原帖', 'Original post')}</a> : null}
        <button type="button" className="md-btn" disabled={wikiBusy} onClick={async () => {
          setWikiBusy(true)
          try { await request('bench/wiki', { path: item.path }); toast(tr('已排入 Wiki 收录队列', 'Queued for Wiki ingestion')) } catch (err) { report(err) } finally { setWikiBusy(false) }
        }}>{tr('收进 Wiki', 'Add to Wiki')}</button>
      </footer> : null}
      {!editing && item?.place === 'fav' && !(archivedFav && !safeUrl(item.url)) ? (
        <footer className="md-atom-read-foot">
          {archivedFav ? null : <button type="button" className="md-btn is-small" onClick={() => confirmBox(t('归档这篇收藏'), t('归档'), t('这篇收藏会移到已处理收藏，并在后台收录进 Wiki。'), async () => { if (await archiveFavorite(id)) setDesk({ atomOpen: null }) })}>{t('归档')}</button>}
          {safeUrl(item.url) ? <a className="md-btn is-small" href={safeUrl(item.url)} target="_blank" rel="noreferrer">{t('原文')}</a> : null}
        </footer>
      ) : null}
      {ask ? (
        <Dialog title={t('否决')} onClose={() => setAsk(false)}>
          <p className="md-atom-note">{t('将把 {path} 移到知识库的回收站（.trash）', { path: item?.path || '' })}</p>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setAsk(false)}>{t('取消')}</button>
            <button type="button" className="md-btn is-danger" onClick={async () => {
              const next = nextPending()
              setAsk(false)
              if (await rejectAtom(id)) setDesk({ atomOpen: next, atomTab: 'pending' })
            }}>{t('否决')}</button>
          </div>
        </Dialog>
      ) : null}
      {leave ? (
        <Dialog title={t('未保存的修改')} onClose={() => setLeave(null)}>
          <p className="md-atom-note">{t('关闭后，这次改动会丢掉。')}</p>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setLeave(null)}>{t('取消')}</button>
            <button type="button" className="md-btn is-primary" onClick={() => applyLeave(leave)}>{t('关闭')}</button>
          </div>
        </Dialog>
      ) : null}
      {conflict ? (
        <Dialog title={t('文件已在别处修改')} onClose={() => setConflict(false)}>
          <p className="md-atom-note">{t('载入最新版本会丢掉输入框里的改动。')}</p>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setConflict(false)}>{t('继续编辑')}</button>
            <button type="button" className="md-btn is-primary" onClick={async () => {
              setConflict(false)
              const data = await loadInboxItem(id).catch(err => { report(err); return null })
              if (!data) return
              setItem(data)
              setDraft(data.raw || '')
            }}>{t('载入最新版本')}</button>
          </div>
        </Dialog>
      ) : null}
    </aside>
  )
}
