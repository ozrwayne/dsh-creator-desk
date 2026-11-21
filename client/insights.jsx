// 复盘：麦田式 Bento 商业数据大屏 + 多平台渠道品牌色趋势矩阵 + 单账号深度详情。
import React from 'react'
import { exposureLabel } from './read-status.js'
import { dispatchOps, fetchInsights, importXMetrics, learnSkills, loadBoard, loadTodo, openItem, openLine, refreshX, report, request, setDesk, setXRefresh, toast, useDesk } from './desk.js'
import { pieceInsights } from '../src/todo.js'
import { ConnectDialog } from './connect.jsx'
import { EN } from './en/index.js'
import { lang, plural, t, useLang } from './i18n.js'
import { MonitorPanel } from './monitor.jsx'
import { OwnMetricValues } from './piece.jsx'
import { AccountAvatar, AreaSparkline, PlatformLogo, platformChartColor, platformColor } from './platforms.jsx'
import { Dialog, Icon, Segmented } from './ui.jsx'
import { PLATFORMS, compact, dayKey, displayItem, fmtDate, platformChoices, posterOf } from './util.js'
import matrix from '../demo/matrix.json'

const tr = (zh, en) => (lang() === 'en' ? en : zh)

const OWN_METRICS = [
  ['views', '播放', 'Views'],
  ['likes', '点赞', 'Likes'],
  ['comments', '评论', 'Comments'],
  ['saves', '收藏', 'Saves'],
  ['shares', '分享', 'Shares'],
  ['stars', 'Star', 'Stars'],
  ['forks', 'Fork', 'Forks'],
]

const accountTitle = account => account?.displayName || account?.platform || tr('账号', 'Account')
const safeLink = value => (/^https?:\/\//i.test(value || '') ? value : '')
const shortDay = value => (value ? String(value).slice(0, 10) : '—')
const OWN_ACCOUNT_GROUPS = matrix.groups
const groupOf = account => OWN_ACCOUNT_GROUPS.find(group => group.zh === account?.displayName && group.platforms.includes(account.platform))
const ownHomeImage = account => groupOf(account) ? `media-desk/assets/${groupOf(account).avatar}` : ''
const isPending = account => !account.registered
const OWN_VIEW_KEY = 'media-desk:own-view'

function ownStatus(account) {
  if (groupOf(account)) return { tone: 'ok', label: tr('演示数据', 'Demo data'), detail: '' }
  if (isPending(account)) return { tone: 'idle', label: tr('待开通', 'Planned'), detail: '' }
  if (account.lastError) return { tone: 'error', label: tr('待重连', 'Needs sync'), detail: account.lastError }
  if (!account.readable) return { tone: 'warn', label: tr('手动维护', 'Manual'), detail: account.reason }
  if (account.postCount > 0) return { tone: 'ok', label: tr('在线', 'Active'), detail: '' }
  return { tone: 'idle', label: tr('待首发', 'No posts'), detail: '' }
}

function ago(value) {
  const time = Date.parse(value || '')
  if (!Number.isFinite(time)) return '—'
  const days = Math.max(0, Math.floor((Date.now() - time) / 86400000))
  if (days === 0) return tr('今天', 'Today')
  if (days === 1) return tr('昨天', 'Yesterday')
  if (days < 14) return tr(`${days} 天前`, `${days}d ago`)
  if (days < 60) return tr(`${Math.floor(days / 7)} 周前`, `${Math.floor(days / 7)}w ago`)
  return tr(`${Math.floor(days / 30)} 个月前`, `${Math.floor(days / 30)}mo ago`)
}

function OwnDot({ account, withLabel = false }) {
  const status = ownStatus(account)
  const title = status.detail ? `${status.label}：${status.detail}` : status.label
  return (
    <span className={`md-own-status is-${status.tone}`} title={title}>
      <i aria-hidden="true" />
      {withLabel ? status.label : <span className="md-sr">{status.label}</span>}
    </span>
  )
}

function sumMetric(posts, key) {
  const known = posts.filter(post => post[key] != null)
  return known.length ? { value: known.reduce((sum, post) => sum + Number(post[key]), 0), count: known.length } : null
}

function visibleOwnPost(account, post) {
  return account.platform === '视频号' && post.views === 0 ? { ...post, views: null } : post
}

function useOwnAccounts() {
  const [data, setData] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const reading = React.useRef(false)
  React.useEffect(() => {
    if (busy) return undefined
    let active = true
    let timer
    const poll = async () => {
      try {
        const value = await request('own/accounts')
        if (!active) return
        const finished = reading.current && !value.running
        reading.current = Boolean(value.running)
        setData(value)
        setError('')
        if (finished) {
          setDesk({ ownMetricsRevision: Date.now() })
          await Promise.all([loadBoard(), loadTodo()])
        }
      } catch (err) {
        if (active) setError(err.message)
      }
      if (active) timer = setTimeout(poll, reading.current ? 2000 : 15000)
    }
    poll()
    return () => { active = false; clearTimeout(timer) }
  }, [busy])

  const refresh = async id => {
    setBusy(true)
    setError('')
    try {
      const value = await request('own/refresh', id ? { id } : {})
      reading.current = Boolean(value.running)
      setData(value)
      if (!value.running) setDesk({ ownMetricsRevision: Date.now() })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const reload = async () => {
    const value = await request('own/accounts')
    reading.current = Boolean(value.running)
    setData(value)
    return value
  }

  const save = async (id, rowRev, patch) => {
    const value = await request('own/account', { id, rowRev, ...patch })
    setData(value)
    return value
  }

  return { data, busy, error, refresh, reload, save }
}

function useMonitorSummary() {
  const [summary, setSummary] = React.useState({ status: null, accounts: [] })
  React.useEffect(() => {
    let alive = true
    let timer
    const poll = async () => {
      try {
        const [status, catalog] = await Promise.all([
          request('monitor/status').catch(() => null),
          request('monitor/accounts').catch(() => null),
        ])
        if (alive) setSummary({ status, accounts: catalog?.accounts || [] })
      } catch { /* silent */ }
      if (alive) timer = setTimeout(poll, 25000)
    }
    poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [])
  return summary
}

function Metric({ label, value, unit, wide }) {
  return (
    <div className={`md-metric ${wide ? 'is-wide' : ''}`}>
      <dt>{label}</dt>
      <dd>{value}{unit ? <small>{unit}</small> : null}</dd>
    </div>
  )
}

function OwnPoster({ account, post, compact: small = false, home = false }) {
  const [failed, setFailed] = React.useState(false)
  const src = home ? ownHomeImage(account) : safeLink(post?.cover || account?.cover)
  const title = accountTitle(account)
  if (small && !(src && !failed)) return <PlatformLogo platform={account?.platform} size={44} />
  return (
    <span className={`md-own-poster ${small ? 'is-small' : ''} ${src && !failed ? 'has-image' : ''}`}>
      {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : <b>{[...title][0] || '·'}</b>}
    </span>
  )
}

/** 麦田大屏左上卡：主打/最新发布代表作多平台表现卡 */
function FeaturedPieceCard({ board, pieces, items, recentOwnPosts }) {
  const candidates = React.useMemo(() => {
    const stats = pieceInsights(board || { pieces: [], lines: [], threshold: board?.threshold })
    const lineRows = [...stats.lines].sort((a, b) => (b.impressions ?? -1) - (a.impressions ?? -1))
    if (lineRows.length) return lineRows.slice(0, 4).map(line => {
      const linePieces = (pieces || []).filter(p => p.lineKey === line.key || p.title === line.title)
      const dists = linePieces.flatMap(p => p.distributions || [])
      const scheds = linePieces.flatMap(p => p.schedules || [])
      const allPlats = [...new Set([...dists.map(d => d.platform), ...scheds.map(s => s.platform), ...linePieces.flatMap(p => p.platforms || [])])]
      return {
        key: line.key,
        title: line.title,
        impressions: dists.reduce((sum, row) => sum + (Number(row.impressions) || 0), 0),
        verified: line.verified,
        longPublished: line.longPublished,
        platformsCount: new Set(dists.map(row => row.platform)).size,
        totalPlatforms: Math.max(allPlats.length, line.platforms || 1),
        dists,
        allPlats: allPlats.length ? allPlats : ['X'],
        date: dists[0]?.date || linePieces[0]?.date || '',
      }
    })
    return []
  }, [board, pieces])

  const [selectedIdx, setSelectedIdx] = React.useState(0)
  const active = candidates[selectedIdx] || candidates[0] || null
  const second = candidates[selectedIdx === 0 ? 1 : 0] || null
  const totalImpressions = candidates.reduce((s, c) => s + (c.impressions || 0), 0)

  // 尝试匹配灵感墙里的封面图
  const matchedPoster = React.useMemo(() => {
    if (!active) return ''
    const found = (items || []).find(i => i.title && active.title && i.title.includes(active.title.slice(0, 6)))
    return found ? posterOf(displayItem(found)) : recentOwnPosts.some(p => p.sample) ? 'media-desk/assets/hills.jpg' : ''
  }, [active, items, recentOwnPosts])

  if (!active && recentOwnPosts.length) {
    const topOwn = recentOwnPosts[0]
    return (
      <section className="md-bento-card md-mt-featured">
        <div className="md-mt-cover">
          <span className="md-mt-cover-tag">{topOwn.account.platform}</span>
          <div className="md-mt-cover-typo"><b>{(topOwn.title || '').slice(0, 22)}</b></div>
          <span className="md-mt-cover-pill"><i />{tr('近期发布', 'Published')}</span>
        </div>
        <div className="md-mt-feat-body">
          <span className="md-mt-kicker">{tr('最新发布', 'Latest post')}</span>
          <h2>{topOwn.title}</h2>
          <p className="md-mt-sub">{accountTitle(topOwn.account)} · {ago(topOwn.publishedAt)}</p>
        </div>
      </section>
    )
  }

  if (!active) {
    return (
      <section className="md-bento-card md-mt-featured is-empty">
        <div className="md-mt-feat-body">
          <span className="md-mt-kicker">{tr('代表作表现', 'Featured piece')}</span>
          <h2>{tr('等待首篇受管稿件发布', 'Publish a managed piece to track cross-platform reach')}</h2>
        </div>
      </section>
    )
  }

  const sharePct = totalImpressions > 0 ? Math.min(100, Math.round((active.impressions / totalImpressions) * 100)) : 65

  return (
    <section className="md-bento-card md-mt-featured">
      <div className="md-mt-cover" onClick={() => openLine(active.key)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') openLine(active.key) }}>
        {matchedPoster ? <img src={matchedPoster} alt="" /> : null}
        <span className="md-mt-cover-tag">{active.verified ? tr('爆款验证', 'Validated') : tr('重点追踪', 'Tracking')}</span>
        {!matchedPoster ? (
          <div className="md-mt-cover-typo">
            <b>{active.title.slice(0, 24)}</b>
            <small>{active.longPublished ? tr('短推 + 长文全线分发', 'Short + Long-form') : tr('短推验证内容线', 'Short-post validation')}</small>
          </div>
        ) : null}
        <span className="md-mt-cover-pill">
          <i />{tr(`${active.platformsCount}/${active.totalPlatforms} 平台已发`, `${active.platformsCount}/${active.totalPlatforms} live`)}
        </span>
      </div>

      <div className="md-mt-feat-body">
        {candidates.length > 1 ? (
          <div className="md-mt-switch-pills" role="tablist" aria-label={tr('近期稿件', 'Recent pieces')}>
            {candidates.slice(0, 3).map((item, idx) => (
              <button
                type="button"
                role="tab"
                key={item.key}
                aria-selected={idx === selectedIdx}
                className={`md-mt-switch-pill ${idx === selectedIdx ? 'is-on' : ''}`}
                onClick={() => setSelectedIdx(idx)}
              >
                <i className={item.verified ? 'is-green' : 'is-amber'} />
                <span>{item.date ? item.date.slice(5) : `#${idx + 1}`}</span>
              </button>
            ))}
          </div>
        ) : null}

        <span className="md-mt-kicker">{active.verified ? tr('已验证爆款', 'Validated hit') : tr('最新发布', 'Latest release')}</span>
        <h2 onClick={() => openLine(active.key)} title={active.title}>{active.title}</h2>
        <p className="md-mt-sub">
          {active.date ? `${active.date} ${tr('发布', 'published')} · ` : ''}
          {active.longPublished ? tr('长文已发', 'Long-form live') : tr('长文待推进', 'Long-form pending')}
        </p>

        <div className="md-mt-plat-badges">
          {active.allPlats.map(plat => {
            const dist = active.dists.find(d => d.platform === plat)
            const val = dist?.impressions != null ? dist.impressions.toLocaleString() : plat === 'X' && active.impressions ? active.impressions.toLocaleString() : dist ? tr('已发', 'Live') : tr('待发', 'Next')
            return (
              <span key={plat} className="md-mt-plat-chip">
                <PlatformLogo platform={plat} size={18} />
                <b>{val}</b>
              </span>
            )
          })}
        </div>

        <div className="md-mt-feat-kpis">
          <div>
            <span>{tr('全平台曝光', 'Total views')}</span>
            <strong>{active.impressions ? active.impressions.toLocaleString() : '—'}</strong>
          </div>
          <div>
            <span>{tr('分发渠道', 'Channels')}</span>
            <strong>{active.platformsCount}</strong>
          </div>
          <div>
            <span>{tr('爆款份额', 'Share')}</span>
            <strong>{totalImpressions ? `${sharePct}%` : '—'}</strong>
          </div>
        </div>

        <div className="md-mt-compare">
          {second ? (
            <p>
              {tr('对比《', 'vs “')}{second.title.slice(0, 10)}{second.title.length > 10 ? '…' : ''}{tr('》', '” ')}
              <b>{(second.impressions || 0).toLocaleString()}</b> {tr('曝光', 'views')}
            </p>
          ) : (
            <p>{tr('点击卡片直接打开内容线工作区', 'Click to open content line')}</p>
          )}
          <div className="md-mt-progress"><i style={{ width: `${Math.max(12, sharePct)}%` }} /></div>
        </div>
      </div>
    </section>
  )
}

/** 麦田大屏中卡：全域规模大数字 + 多平台品牌色堆叠柱状图 */
function ScaleStackedCard({ registeredAccounts, totalImpressions, manualViews, totalFollowers, verifiedShorts, publishedCount }) {
  const [hoverIdx, setHoverIdx] = React.useState(null)

  // 按平台聚合近 12 周发布频次（使用真实 own/accounts weekly 序列）
  const stacked = React.useMemo(() => {
    const activePlats = []
    const byPlat = new Map()
    for (const acc of registeredAccounts) {
      const w = acc.weekly || []
      if (!w.length) continue
      const prev = byPlat.get(acc.platform) || Array(w.length).fill(0)
      w.forEach((v, i) => { prev[i] = (prev[i] || 0) + (Number(v) || 0) })
      byPlat.set(acc.platform, prev)
    }
    for (const [plat, arr] of byPlat.entries()) {
      const sum = arr.reduce((a, b) => a + b, 0)
      if (sum > 0) activePlats.push({ platform: plat, values: arr, sum, color: platformChartColor(plat) })
    }
    activePlats.sort((a, b) => b.sum - a.sum)
    const length = activePlats[0]?.values.length || 12
    const weeks = Array.from({ length }, (_, idx) => {
      const d = new Date(Date.now() - (length - 1 - idx) * 7 * 86400000)
      const label = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
      const segments = activePlats.map(p => ({ platform: p.platform, value: p.values[idx] || 0, color: p.color })).filter(s => s.value > 0)
      const total = segments.reduce((a, b) => a + b.value, 0)
      return { idx, label, segments, total }
    })
    const maxTotal = Math.max(1, ...weeks.map(w => w.total))
    return { activePlats, weeks, maxTotal }
  }, [registeredAccounts])

  const totalPosts = registeredAccounts.reduce((s, a) => s + Number(a.postCount || 0), 0)
  const last4WeeksPosts = stacked.weeks.slice(-4).reduce((s, w) => s + w.total, 0)
  const lastWeekPosts = stacked.weeks.at(-1)?.total || 0
  const headlineNumber = totalFollowers > 0 ? totalFollowers : Math.max(totalImpressions, manualViews)
  const headlineTitle = totalFollowers > 0
    ? tr('全平台粉丝', 'Total followers')
    : headlineNumber > 0
      ? tr('全域总曝光', 'Total impressions')
      : tr('全网已读内容', 'Total synced posts')
  const displayBig = headlineNumber > 0 ? headlineNumber.toLocaleString() : totalPosts.toLocaleString()

  return (
    <section className="md-bento-card md-mt-scale">
      <header className="md-mt-card-head">
        <h2>{headlineTitle}</h2>
        <span>{tr(`${registeredAccounts.length} 个已开通渠道合计`, `Across ${registeredAccounts.length} active channels`)}</span>
      </header>

      <div className="md-mt-big-num">{displayBig}</div>

      <div className="md-mt-deltas">
        <span className="md-delta-pill is-up">{tr(`本周 +${lastWeekPosts} 篇`, `+${lastWeekPosts} this wk`)}</span>
        <span className="md-delta-pill is-up">{tr(`近 4 周 +${last4WeeksPosts} 篇`, `+${last4WeeksPosts} in 4w`)}</span>
        <span className="md-delta-pill">{tr(`累计内容 ${totalPosts} 条`, `${totalPosts} posts`)}</span>
        {verifiedShorts > 0 ? <span className="md-delta-pill is-up">{tr(`爆款验证 ${verifiedShorts}/${publishedCount}`, `${verifiedShorts} hits`)}</span> : null}
      </div>

      <div className="md-mt-stack-head">
        <span>{tr('多平台产出节奏 · 近 12 周', 'Multi-platform output · 12 weeks')}</span>
        <div className="md-mt-legend">
          {stacked.activePlats.map(p => (
            <span key={p.platform}><i style={{ background: p.color }} />{p.platform}</span>
          ))}
        </div>
      </div>

      <div className="md-mt-stacked-wrap" onMouseLeave={() => setHoverIdx(null)}>
        <div className="md-mt-stacked-bars">
          {stacked.weeks.map((wk, idx) => (
            <div
              key={wk.idx}
              className={`md-mt-bar-col ${hoverIdx === idx ? 'is-hover' : ''}`}
              onMouseEnter={() => setHoverIdx(idx)}
            >
              <div className="md-mt-bar-stack" style={{ height: `${Math.max(8, (wk.total / stacked.maxTotal) * 116)}px` }}>
                {wk.segments.length ? wk.segments.map(seg => (
                  <i
                    key={seg.platform}
                    style={{
                      flexGrow: seg.value,
                      background: seg.color,
                    }}
                  />
                )) : <i className="is-empty" />}
              </div>
              <small>{idx % 2 === 0 || idx === stacked.weeks.length - 1 ? wk.label : ''}</small>
            </div>
          ))}
        </div>

        {hoverIdx != null && stacked.weeks[hoverIdx] ? (
          <div className="md-mt-bar-tip">
            <strong>{stacked.weeks[hoverIdx].label} {tr('当周合计', 'Week total')}: {stacked.weeks[hoverIdx].total}</strong>
            {stacked.weeks[hoverIdx].segments.map(s => (
              <span key={s.platform}><i style={{ background: s.color }} />{s.platform}: {s.value}</span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** 麦田大屏右卡：结构化数据分析与归因洞察块 */
function AutoAnalysisCard({ board, registeredAccounts, readyLines, proposedSkills, onLearn }) {
  const stats = React.useMemo(() => pieceInsights(board || { pieces: [], lines: [], threshold: board?.threshold }), [board])
  const sortedLines = [...stats.lines].sort((a, b) => (b.impressions ?? -1) - (a.impressions ?? -1))
  const topLine = sortedLines[0]
  const topShare = topLine?.impressions && stats.impressions > 0 ? Math.round((topLine.impressions / stats.impressions) * 100) : null

  const byPlatPosts = React.useMemo(() => {
    const m = new Map()
    for (const acc of registeredAccounts) m.set(acc.platform, (m.get(acc.platform) || 0) + (acc.postCount || 0))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [registeredAccounts])

  const topPlat = byPlatPosts[0]
  const totalOwnPosts = byPlatPosts.reduce((s, [, v]) => s + v, 0)

  return (
    <section className="md-bento-card md-mt-analysis">
      <header className="md-mt-card-head">
        <h2>{tr('数据分析', 'Insights')}</h2>
        <button type="button" className="md-act-link" onClick={onLearn}>
          <Icon name="spark" size={12} />{tr('智能归因', 'Refresh')}
        </button>
      </header>

      <div className="md-mt-insight-list">
        <div className="md-mt-insight-item">
          <span className="md-mt-tag is-green">{tr('爆款', 'Top hit')}</span>
          <p>
            {topLine && topLine.impressions != null ? (
              <>
                {tr('表现最强的是《', 'Top line “')}<b>{topLine.title.slice(0, 16)}{topLine.title.length > 16 ? '…' : ''}</b>{tr('》，斩获 ', '” reached ')}
                <b>{topLine.impressions.toLocaleString()}</b> {tr('曝光', 'views')}
                {topShare != null ? <>{tr('，占受管总曝光的 ', ' (')}<b>{topShare}%</b>{tr('。', ').')}</> : '。'}
              </>
            ) : (
              tr('发布短推并同步曝光后，自动识别破基线爆款选题。', 'Publish short posts to automatically detect outlier topics.')
            )}
          </p>
        </div>

        <div className="md-mt-insight-item">
          <span className="md-mt-tag is-blue">{tr('渠道', 'Channels')}</span>
          <p>
            {topPlat && totalOwnPosts > 0 ? (
              <>
                {tr('存量内容最多的是', 'Most active channel is ')}<b>{topPlat[0]}</b>（<b>{topPlat[1]}</b> {tr('篇', 'posts')}），
                {tr('占全矩阵 ', 'accounting for ')}<b>{Math.round((topPlat[1] / totalOwnPosts) * 100)}%</b>{tr('，共覆盖 ', ' across ')}<b>{byPlatPosts.length}</b>{tr(' 个平台。', ' platforms.')}
              </>
            ) : (
              tr(`已登记 ${registeredAccounts.length} 个跨平台账号，点击立即同步即可拉取最新作品。`, `${registeredAccounts.length} accounts registered.`)
            )}
          </p>
        </div>

        {readyLines.length ? (
          <button type="button" className="md-mt-insight-item is-clickable" onClick={() => setDesk({ view: 'flow' })}>
            <span className="md-mt-tag is-purple">{tr('升级', 'Upgrade')}</span>
            <p>
              {tr('《', '“')}<b>{readyLines[0].name.slice(0, 15)}{readyLines[0].name.length > 15 ? '…' : ''}</b>{tr('》等 ', '” & ')}
              <b>{readyLines.length}</b> {tr('条内容线已通过短推爆款验证，点击进入流程扩写长文 ›', 'validated line(s) ready for long-form expansion ›')}
            </p>
          </button>
        ) : (
          <div className="md-mt-insight-item">
            <span className="md-mt-tag is-purple">{tr('验证', 'Hit rate')}</span>
            <p>
              {stats.publishedShorts > 0 ? (
                <>
                  {tr('已发布 ', 'Published ')}<b>{stats.publishedShorts}</b>{tr(' 条测试短推，其中 ', ' short posts; ')}
                  <b>{stats.verifiedShorts}</b>{tr(' 条成功跨过验证线（命中率 ', ' validated (')}
                  <b>{Math.round((stats.verifiedShorts / stats.publishedShorts) * 100)}%</b>{tr('）。', ').')}
                </>
              ) : (
                tr('所有已验证内容线均已进入下一环节生产。', 'All validated lines are progressing on schedule.')
              )}
            </p>
          </div>
        )}

        <div className="md-mt-insight-item">
          <span className="md-mt-tag is-amber">{tr('策略', 'Rule')}</span>
          <p>
            {proposedSkills[0] ? (
              <>
                <b>{proposedSkills[0].name}</b>：{proposedSkills[0].evidence || proposedSkills[0].rule}
              </>
            ) : (
              tr('先在 X 用低成本短推验证选题爆发力，破 3,000 曝光后再投产公众号长文与视频。', 'Validate hooks on X first, then scale winners to WeChat articles and video.')
            )}
          </p>
        </div>
      </div>
    </section>
  )
}

/** 麦田大屏第二排：单渠道品牌色趋势卡片 */
function ChannelBentoCard({ account, monitorAccount, onOpen }) {
  const followers = monitorAccount?.latestFollowers?.total
  const posts = account.posts || []
  const totalViews = posts.reduce((sum, post) => sum + (Number(post.views) || 0), 0)
  const totalStars = posts.reduce((s, p) => s + (Number(p.stars) || 0), 0)
  const totalEngagement = account.engagement != null ? Number(account.engagement) : posts.reduce((s, p) => s + (Number(p.likes) || 0) + (Number(p.comments) || 0) + (Number(p.saves) || 0), 0)

  let primaryNum = account.postCount || 0
  let metricUnit = tr('篇内容', 'posts')
  if (followers != null && followers > 0) {
    primaryNum = followers
    metricUnit = account.platform === 'YouTube' || account.platform === 'Substack' ? tr('订阅', 'subscribers') : tr('粉丝', 'followers')
  } else if (account.platform === 'GitHub' && totalStars > 0) {
    primaryNum = totalStars
    metricUnit = 'Stars'
  } else if (totalViews > 0) {
    primaryNum = totalViews
    metricUnit = tr('播放 / 阅读', 'views')
  } else if (totalEngagement > 0) {
    primaryNum = totalEngagement
    metricUnit = tr('互动', 'engagements')
  }

  const weekly = account.weekly?.length ? account.weekly : [0, 0, 0, 0, 0, 0]
  const recent4w = weekly.slice(-4).reduce((a, b) => a + (Number(b) || 0), 0)
  const recent1w = weekly.at(-1) || 0
  const recentTwo = posts.slice(0, 2)

  return (
    <button
      type="button"
      className="md-bento-card md-channel-card"
      style={{ '--brand-c': platformChartColor(account.platform) }}
      onClick={() => onOpen(account.id)}
    >
      <div className="md-channel-head">
        <PlatformLogo platform={account.platform} size={28} />
        <div className="md-channel-name">
          <strong>{accountTitle(account)}</strong>
          <small>{account.platform}</small>
        </div>
        <span className="md-channel-unit">{metricUnit}</span>
        <OwnDot account={account} />
      </div>

      <div className="md-channel-num">{Number(primaryNum).toLocaleString()}</div>

      <div className="md-channel-pills">
        <span className={`md-delta-pill ${recent1w > 0 ? 'is-up' : ''}`}>
          {tr(`本周 +${recent1w}`, `+${recent1w} wk`)}
        </span>
        <span className={`md-delta-pill ${recent4w > 0 ? 'is-up' : ''}`}>
          {tr(`近 4 周 +${recent4w}`, `+${recent4w} 4w`)}
        </span>
      </div>

      <div className="md-channel-spark">
        <AreaSparkline values={weekly} platform={account.platform} width={220} height={52} />
      </div>

      <div className="md-channel-works">
        {recentTwo.length ? recentTwo.map(item => (
          <div key={item.id} className="md-channel-work">
            <span title={item.title}>{item.title || tr('无标题', 'Untitled')}</span>
            <b>{item.views != null ? compact(item.views) : item.likes != null ? `${compact(item.likes)} 赞` : item.stars != null ? `★ ${item.stars}` : ago(item.publishedAt)}</b>
          </div>
        )) : (
          <div className="md-channel-work is-single">
            <span>{account.latestAt ? `${tr('最近更新', 'Latest')} · ${ago(account.latestAt)}` : tr('点击查看渠道详情与配置', 'View channel details')}</span>
            <b>{account.postCount || 0} {tr('条', '')}</b>
          </div>
        )}
      </div>
    </button>
  )
}

function OwnTable({ accounts, onOpen }) {
  return (
    <div className="md-bento-card md-own-table-wrap">
      <table className="md-own-table">
        <thead>
          <tr>
            <th scope="col">{tr('账号', 'Account')}</th>
            <th scope="col">{tr('矩阵分组', 'Group')}</th>
            <th scope="col">{tr('状态', 'Status')}</th>
            <th scope="col" className="is-num">{tr('内容数', 'Posts')}</th>
            <th scope="col" className="is-num">{tr('互动', 'Engagement')}</th>
            <th scope="col">{tr('最近发布', 'Latest')}</th>
            <th scope="col">{tr('近 12 周趋势', '12W Trend')}</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map(account => {
            const group = groupOf(account)
            return (
              <tr key={account.id} onClick={() => onOpen(account.id)}>
                <td>
                  <button type="button" className="md-own-row-name" onClick={event => { event.stopPropagation(); onOpen(account.id) }}>
                    <PlatformLogo platform={account.platform} size={26} />
                    <span><strong>{accountTitle(account)}</strong><small>{account.platform}</small></span>
                  </button>
                </td>
                <td>{group ? <span className="md-own-chip"><Icon name={group.icon} size={12} />{tr(group.zh, group.en)}</span> : <span className="md-own-faint">—</span>}</td>
                <td><OwnDot account={account} withLabel /></td>
                <td className="is-num">{account.postCount || <span className="md-own-faint">0</span>}</td>
                <td className="is-num">{account.engagement != null ? compact(account.engagement) : <span className="md-own-faint">—</span>}</td>
                <td className="md-own-faint" title={shortDay(account.latestAt)}>{ago(account.latestAt)}</td>
                <td style={{ width: 120 }}><AreaSparkline values={account.weekly || []} platform={account.platform} width={110} height={28} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function sameOwnValue(a, b) {
  const norm = value => String(value ?? '').trim().toLowerCase()
  return norm(a) === norm(b)
}

function fieldsFromAccount(account) {
  return { displayName: account.displayName || '', handle: account.handle || '', url: account.url || '' }
}

function OwnFieldRow({ label, placeholder, value, observedValue, filled, disabled, onChange, onFill }) {
  const hasObserved = observedValue != null && observedValue !== ''
  const matches = hasObserved && sameOwnValue(observedValue, value)
  return (
    <div className="md-own-form-row">
      <label className="md-field">
        <span>{label}</span>
        <input type="text" value={value} placeholder={placeholder || ''} disabled={disabled} onChange={event => onChange(event.target.value)} />
      </label>
      {hasObserved ? (matches ? (
        <p className="md-own-observed">{tr('与公开主页一致', 'Verified')}</p>
      ) : (
        <p className="md-own-observed">
          <span>{tr('检测到：', 'Detected: ')}{observedValue}</span>
          <button type="button" className="md-pill is-small" disabled={disabled} onClick={onFill}>{tr('填入', 'Apply')}</button>
        </p>
      )) : null}
      {filled ? <span className="md-own-tag">{tr('自动补全', 'Auto-filled')}</span> : null}
    </div>
  )
}

function AccountDetail({ account, own, onBack, onSaved, onOpenMonitor }) {
  const [detail, setDetail] = React.useState(null)
  const [error, setError] = React.useState('')
  const [metric, setMetric] = React.useState('')
  const [form, setForm] = React.useState(() => fieldsFromAccount(account))
  const [dirty, setDirty] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [formError, setFormError] = React.useState('')

  React.useEffect(() => {
    let active = true
    setDetail(null)
    setError('')
    request(`own/posts?id=${encodeURIComponent(account.id)}`).then(value => { if (active) setDetail(value) }).catch(err => { if (active) setError(err.message) })
    return () => { active = false }
  }, [account.id, account.lastReadAt])

  React.useEffect(() => {
    if (dirty) return
    setForm(fieldsFromAccount(account))
  }, [account.id, account.rowRev, dirty])

  const confirmLeave = React.useCallback(() => !dirty || window.confirm(tr('有未保存的修改，确定要离开吗？', 'You have unsaved changes. Leave anyway?')), [dirty])
  React.useEffect(() => {
    const onKey = event => { if (event.key === 'Escape' && confirmLeave()) onBack() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, confirmLeave])

  const posts = (detail?.posts || []).map(post => visibleOwnPost(account, post))
  const fields = OWN_METRICS.filter(([key]) => posts.some(post => post[key] != null))
  React.useEffect(() => {
    if (!fields.some(([key]) => key === metric)) setMetric(fields[0]?.[0] || '')
  }, [fields.map(([key]) => key).join(','), metric])

  const max = Math.max(1, ...posts.map(post => Number(post[metric] || 0)))
  const months = Object.entries(posts.reduce((all, post) => {
    if (post.publishedAt) all[post.publishedAt.slice(0, 7)] = (all[post.publishedAt.slice(0, 7)] || 0) + 1
    return all
  }, {})).sort(([a], [b]) => a.localeCompare(b))
  const maxMonth = Math.max(1, ...months.map(([, value]) => value))
  const observed = account.observed || null
  const filledFields = account.filled || []
  const back = () => { if (confirmLeave()) onBack() }
  const restore = () => { setForm(fieldsFromAccount(account)); setDirty(false); setFormError('') }

  const save = async event => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setFormError('')
    try {
      const value = await own.save(account.id, account.rowRev, form)
      setDirty(false)
      toast(tr('已保存', 'Saved'))
      if (value?.saved) onSaved(value.saved)
    } catch (err) {
      setFormError(err.message)
      if (err.status === 409) {
        try { await own.reload() } catch { /* next poll */ }
        setDirty(false)
      }
    } finally {
      setSaving(false)
    }
  }

  const brandColor = platformChartColor(account.platform)

  return (
    <div className="md-board-page md-own-detail-page">
      <div className="md-bento-shell">
        <div className="md-own-detail-tools">
          <button type="button" className="md-btn is-small" onClick={back}>← {tr('返回复盘大屏', 'Back to dashboard')}</button>
          <OwnDot account={account} withLabel />
          <span className="md-grow" />
          <button type="button" className="md-btn is-small" onClick={() => onOpenMonitor(account.id)}>
            <Icon name="sliders" size={14} />{tr('曲线与采集设置', 'Series & settings')}
          </button>
          {safeLink(account.url) ? <a className="md-btn is-small" href={account.url} target="_blank" rel="noreferrer">{tr('打开主页', 'Open profile')} ↗</a> : null}
          <button type="button" className="md-btn is-small is-primary" disabled={own.busy || own.data?.running || !account.readable || !account.registered || saving} onClick={() => own.refresh(account.id)}>
            <Icon name="refresh" size={14} />{own.busy || own.data?.running ? tr('同步中…', 'Syncing…') : tr('立即同步', 'Sync now')}
          </button>
        </div>

        <section className="md-bento-card md-own-detail-hero">
          <OwnPoster account={account} post={posts[0]} home />
          <div>
            <p className="md-own-kicker md-own-kicker-plat"><PlatformLogo platform={account.platform} size={20} />{account.platform}</p>
            <h1>{accountTitle(account)}</h1>
            <p>{tr(`${detail?.postCount ?? account.postCount ?? 0} 条已读内容 · 最近发布 ${shortDay(detail?.latestAt || account.latestAt)}`, `${detail?.postCount ?? account.postCount ?? 0} posts · latest ${shortDay(detail?.latestAt || account.latestAt)}`)}</p>
          </div>
          <dl className="md-own-detail-metrics">
            {fields.slice(0, 4).map(([key, zh, en]) => {
              const total = sumMetric(posts, key)
              return <Metric key={key} label={tr(zh, en)} value={total.value.toLocaleString()} unit={tr(`近 ${total.count} 条`, `${total.count} posts`)} />
            })}
            {!fields.length ? <Metric label={tr('累计内容', 'Posts')} value={posts.length} /> : null}
          </dl>
        </section>

        {error ? <section className="md-bento-card md-own-panel"><p role="alert" className="md-own-state is-error">{error}</p></section> : null}
        {!detail && !error ? <section className="md-bento-card md-own-panel"><p className="md-own-state">{tr('正在加载内容明细…', 'Loading posts…')}</p></section> : null}

        {detail ? (
          <div className="md-own-detail-grid">
            {fields.length ? (
              <section className="md-bento-card md-own-panel md-own-performance">
                <header className="md-tile-head">
                  <h2>{tr('单篇表现排行', 'Post performance')}</h2>
                  <Segmented label={tr('指标', 'Metric')} value={metric} onChange={setMetric} options={fields.map(([key, zh, en]) => ({ value: key, label: tr(zh, en) }))} />
                </header>
                <ol>
                  {posts.filter(post => post[metric] != null).slice(0, 15).map(post => (
                    <li key={post.id}>
                      <span title={post.title || tr('无标题', 'Untitled')}>{post.title || tr('无标题', 'Untitled')}</span>
                      <b>{Number(post[metric]).toLocaleString()}</b>
                      <i style={{ width: `${(Number(post[metric]) / max) * 100}%`, background: brandColor }} />
                    </li>
                  ))}
                </ol>
              </section>
            ) : (
              <section className="md-bento-card md-own-panel md-own-rhythm">
                <header className="md-tile-head"><h2>{tr('近 12 周更新趋势', '12-week activity')}</h2></header>
                <div style={{ padding: '8px 18px 18px' }}>
                  <AreaSparkline values={account.weekly || []} platform={account.platform} width={480} height={110} />
                </div>
              </section>
            )}

            <section className="md-bento-card md-own-panel md-own-rhythm">
              <header className="md-tile-head"><h2>{tr('月度发布节奏', 'Monthly cadence')}</h2><span className="md-tile-meta">{posts.length} {tr('篇', 'posts')}</span></header>
              <ol>{months.map(([month, value]) => <li key={month}><span>{month}</span><i style={{ width: `${(value / maxMonth) * 100}%`, background: brandColor }} /><b>{value}</b></li>)}</ol>
              {!months.length ? <p className="md-own-state">{tr('暂无月度记录', 'No dated posts yet')}</p> : null}
            </section>

            <section className="md-bento-card md-own-panel md-own-all">
              <header className="md-tile-head"><h2>{tr('全部作品列表', 'All posts')}</h2><span className="md-tile-meta">{posts.length}</span></header>
              <ol tabIndex={0} aria-label={tr('全部作品列表', 'All posts')}>
                {posts.map(post => (
                  <li key={post.id}>
                    <OwnPoster account={account} post={post} compact />
                    <span className="md-own-post-title">
                      {safeLink(post.url) ? <a href={post.url} target="_blank" rel="noreferrer">{post.title || tr('无标题', 'Untitled')}</a> : <strong>{post.title || tr('无标题', 'Untitled')}</strong>}
                      <small>{shortDay(post.publishedAt)}</small>
                    </span>
                    <OwnMetricValues metrics={post} />
                  </li>
                ))}
              </ol>
              {!posts.length ? <p className="md-own-state">{tr('暂无已同步作品', 'No posts synced yet')}</p> : null}
            </section>

            <section className="md-bento-card md-own-panel md-own-profile">
              <header className="md-tile-head"><h2>{tr('账号资料与主页绑定', 'Account profile')}</h2></header>
              <form className="md-own-form" onSubmit={save}>
                <OwnFieldRow
                  label={tr('显示名', 'Display name')}
                  value={form.displayName}
                  disabled={saving}
                  observedValue={observed?.displayName}
                  filled={filledFields.includes('displayName')}
                  onChange={value => { setForm(f => ({ ...f, displayName: value })); setDirty(true) }}
                  onFill={() => { setForm(f => ({ ...f, displayName: observed.displayName })); setDirty(true) }}
                />
                <OwnFieldRow
                  label={account.form?.handleLabel || tr('平台 ID', 'Platform ID')}
                  placeholder={account.form?.handleExample}
                  value={form.handle}
                  disabled={saving}
                  observedValue={observed?.handle}
                  filled={filledFields.includes('handle')}
                  onChange={value => { setForm(f => ({ ...f, handle: value })); setDirty(true) }}
                  onFill={() => { setForm(f => ({ ...f, handle: observed.handle })); setDirty(true) }}
                />
                <OwnFieldRow
                  label={tr('主页链接', 'Homepage link')}
                  placeholder={account.form?.linkExample}
                  value={form.url}
                  disabled={saving}
                  observedValue={observed?.url}
                  filled={filledFields.includes('url')}
                  onChange={value => { setForm(f => ({ ...f, url: value })); setDirty(true) }}
                  onFill={() => { setForm(f => ({ ...f, url: observed.url })); setDirty(true) }}
                />
                {formError ? <p className="md-form-error">{formError}</p> : null}
                <div className="md-form-foot">
                  <button type="submit" className="md-btn is-small is-primary" disabled={saving || (account.registered && !dirty)}>{saving ? tr('保存中…', 'Saving…') : tr('保存资料', 'Save')}</button>
                  <button type="button" className="md-btn is-small" disabled={saving || !dirty} onClick={restore}>{tr('还原', 'Reset')}</button>
                </div>
              </form>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function count(n, one, other, vars = {}) {
  return t(plural(n, one, other), { n: Number(n).toLocaleString(), s: n === 1 ? '' : 's', ...vars })
}

function platformOf(name) {
  const value = String(name ?? '').toLowerCase()
  return PLATFORMS.find(p => p.toLowerCase() === value || String(EN[p] ?? '').toLowerCase() === value)
}

/** CSV：日期,平台,阅读,点赞,评论,转发,收藏 */
export function parseCsv(text) {
  const ops = []
  const errors = []
  text.trim().split(/\r?\n/).forEach((line, index) => {
    const cols = line.split(/[,，\t]/).map(c => c.trim())
    if (index === 0 && !/\d/.test(cols[0])) return
    const date = new Date(cols[0])
    const platform = platformOf(cols[1])
    if (Number.isNaN(date.getTime()) || !platform) {
      errors.push(index + 1)
      return
    }
    const [views, likes, comments, shares, saves] = cols.slice(2).map(v => Number(v) || 0)
    ops.push({ op: 'add_metric', platform, date: date.toISOString(), views: views ?? 0, likes: likes ?? 0, comments: comments ?? 0, shares: shares ?? 0, saves: saves ?? 0 })
  })
  return { ops, errors }
}

function addMetric(items) {
  setDesk({
    dialog: {
      title: t('录入一条数据'),
      initial: { platform: '公众号', date: dayKey(new Date()) },
      fields: [
        { name: 'itemId', label: t('对应内容'), type: 'select', options: [{ value: '', label: t('不关联内容') }, ...items.filter(i => !i.parentId).map(i => ({ value: i.id, label: displayItem(i).title.slice(0, 26) }))] },
        { name: 'platform', label: t('平台'), type: 'select', options: platformChoices().map(v => ({ value: v, label: t(v) })) },
        { name: 'date', label: t('日期'), type: 'date', required: true },
        { name: 'views', label: t('播放 / 阅读'), type: 'number', required: true },
        { name: 'likes', label: t('点赞'), type: 'number' },
        { name: 'comments', label: t('评论'), type: 'number' },
        { name: 'saves', label: t('收藏'), type: 'number' },
      ],
      onSubmit: (v) => {
        const n = key => Number(v[key]) || 0
        dispatchOps([{ op: 'add_metric', itemId: v.itemId || null, platform: v.platform, date: new Date(`${v.date}T12:00:00`).toISOString(), views: n('views'), likes: n('likes'), comments: n('comments'), saves: n('saves') }], { label: t('录入数据') })
      },
    },
  })
}

function importCsv() {
  setDesk({
    dialog: {
      title: t('粘贴 CSV 数据'),
      submitLabel: t('导入'),
      fields: [{ name: 'csv', label: t('每行一条：日期,平台,阅读,点赞,评论,转发,收藏'), type: 'textarea', rows: 7, required: true, placeholder: t('2026-10-30,公众号,3200,120,18,40,66') }],
      onSubmit: (values) => {
        const { ops, errors } = parseCsv(values.csv ?? '')
        const done = count(ops.length, '导入 1 条数据', '导入 {n} 条数据')
        if (ops.length) dispatchOps(ops, { label: done, silent: true })
        toast(errors.length ? t('导入 {n} 条，第 {rows} 行格式不对', { n: ops.length, rows: errors.slice(0, 5).join(t('、')) }) : done, { error: errors.length > 0, undo: !errors.length && ops.length > 0 })
      },
    },
  })
}

export function InsightsView() {
  useLang()
  const items = useDesk(s => s.state.items)
  const metrics = useDesk(s => s.state.metrics)
  const skills = useDesk(s => s.state.skills)
  const board = useDesk(s => s.board)
  const xStatus = useDesk(s => s.xStatus)
  const ownOpen = useDesk(s => s.ownOpen)
  const own = useOwnAccounts()
  const monitorSummary = useMonitorSummary()
  const ownScroll = React.useRef(0)

  const [data, setData] = React.useState(null)
  const [groupFilter, setGroupFilter] = React.useState('all')
  const [channelView, setChannelViewState] = React.useState(() => {
    try { return localStorage.getItem(OWN_VIEW_KEY) === 'list' ? 'list' : 'gallery' } catch { return 'gallery' }
  })
  const setChannelView = v => {
    setChannelViewState(v)
    try { localStorage.setItem(OWN_VIEW_KEY, v) } catch { /* ignore */ }
  }

  const [connecting, setConnecting] = React.useState(false)
  const [importHubOpen, setImportHubOpen] = React.useState(false)
  const [xCsvOpen, setXCsvOpen] = React.useState(false)
  const [monitorDrawer, setMonitorDrawer] = React.useState(null) // null | { tab, accountId }
  const [linesTableOpen, setLinesTableOpen] = React.useState(false)
  const [xBusy, setXBusy] = React.useState(false)

  // 轮询 X 状态
  React.useEffect(() => {
    if (xBusy) return undefined
    let active = true
    let timer
    let running = Boolean(xStatus?.running)
    const poll = async () => {
      try {
        const next = await request('x/status')
        if (!active) return
        const finished = running && !next.running
        running = Boolean(next.running)
        setDesk({ xStatus: next })
        if (finished) await Promise.all([loadBoard(), loadTodo()])
      } catch { /* silent */ }
      if (active) timer = setTimeout(poll, running ? 2000 : 15000)
    }
    poll()
    return () => { active = false; clearTimeout(timer) }
  }, [xBusy])

  React.useEffect(() => {
    let alive = true
    fetchInsights().then(next => { if (alive) setData(next) }).catch(err => toast(err.message, { error: true }))
    return () => { alive = false }
  }, [metrics, items])

  const openOwn = React.useCallback(id => {
    ownScroll.current = document.querySelector('.md-content > .md-board-page')?.scrollTop || 0
    setDesk({ ownOpen: id })
  }, [])

  const closeOwn = React.useCallback(() => {
    setDesk({ ownOpen: null })
    requestAnimationFrame(() => {
      const page = document.querySelector('.md-content > .md-board-page')
      if (page) page.scrollTop = ownScroll.current
    })
  }, [])

  const allOwnAccounts = own.data?.accounts || []
  const selectedOwn = allOwnAccounts.find(account => account.id === ownOpen)


  const registered = allOwnAccounts.filter(a => !isPending(a))
  const filteredAccounts = groupFilter === 'all'
    ? registered
    : registered.filter(a => groupOf(a)?.id === groupFilter)

  const pieceStats = React.useMemo(() => pieceInsights(board || { pieces: [], lines: [], threshold: board?.threshold }), [board])
  const lines = board?.lines || []
  const readyLines = lines.filter(line => {
    const nodes = line.nodes.filter(node => node.enabled)
    const index = [...nodes].map(node => node.state).lastIndexOf('validated')
    return index >= 0 && nodes[index + 1] && nodes[index + 1].pieces.length === 0
  })

  const monById = React.useMemo(() => new Map((monitorSummary.accounts || []).map(a => [a.accountId, a])), [monitorSummary.accounts])
  const totalFollowers = React.useMemo(
    () => (monitorSummary.accounts || []).filter(a => a.roles?.includes('own')).reduce((s, a) => s + (Number(a.latestFollowers?.total) || 0), 0),
    [monitorSummary.accounts]
  )

  const recentOwnPosts = React.useMemo(
    () => registered.flatMap(account => (account.posts || []).map(post => ({ ...post, account })))
      .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))).slice(0, 6),
    [registered]
  )

  const proposedSkills = (skills || []).filter(s => s.status === 'proposed' && (data?.hasSample || !s.sample))
  const budget = monitorSummary.status?.budget
  const healthyCount = registered.filter(a => a.postCount > 0 || a.readable).length
  const exposure = exposureLabel(xStatus)

  const triggerXRefresh = async () => {
    setXBusy(true)
    try { await refreshX(); toast(tr('已触发曝光刷新', 'Refreshing X metrics')) } catch (err) { report(err) } finally { setXBusy(false) }
  }
  if (ownOpen && selectedOwn) {
    return (
      <>
        <AccountDetail
          account={selectedOwn}
          own={own}
          onBack={closeOwn}
          onSaved={id => setDesk({ ownOpen: id })}
          onOpenMonitor={id => setMonitorDrawer({ tab: 'account', accountId: id })}
        />
        {monitorDrawer ? (
          <Dialog title={tr('数据采集与曲线明细', 'Sync & series')} onClose={() => setMonitorDrawer(null)} width={880}>
            <MonitorPanel embedded initialTab={monitorDrawer.tab} initialAccountId={monitorDrawer.accountId} />
          </Dialog>
        ) : null}
      </>
    )
  }

  return (
    <div className="md-board-page md-maitian-page">
      <div className="md-bento-shell">
        {/* 麦田式大屏顶栏：矩阵切换 + 静默运行指示灯 + 收纳入口 */}
        <header className="md-maitian-topbar">
          <div className="md-maitian-brand">
            <h1>{tr('全域复盘', 'Analytics')}</h1>
            {registered.some(groupOf) ? <small>{tr('演示数据', 'Demo data')}</small> : null}
            <div className="md-maitian-groups" role="tablist" aria-label={tr('渠道矩阵', 'Channel group')}>
              <button type="button" role="tab" aria-selected={groupFilter === 'all'} className={groupFilter === 'all' ? 'is-on' : ''} onClick={() => setGroupFilter('all')}>
                {tr('大屏总览', 'Overview')}
              </button>
              {OWN_ACCOUNT_GROUPS.map(g => (
                <button key={g.id} type="button" role="tab" aria-selected={groupFilter === g.id} className={groupFilter === g.id ? 'is-on' : ''} onClick={() => setGroupFilter(g.id)}>
                  {tr(g.zh, g.en)}
                </button>
              ))}
            </div>
          </div>

          <div className="md-maitian-lamps">
            <button type="button" className="md-status-lamp is-ok" onClick={() => own.refresh()} disabled={own.busy || own.data?.running} title={tr('点击同步全部本人账号', 'Click to sync accounts')}>
              <i className={own.busy || own.data?.running ? 'is-pulse' : ''} />
              {own.busy || own.data?.running ? tr('账号同步中…', 'Syncing…') : tr(`矩阵在线 ${healthyCount}/${registered.length}`, `${healthyCount}/${registered.length} online`)}
            </button>

            <button type="button" className={`md-status-lamp ${exposure.warn ? 'is-warn' : 'is-ok'}`} onClick={triggerXRefresh} disabled={xBusy || xStatus?.running} title={xStatus?.lastError || xStatus?.lastNote || tr('点击立即刷新 X 曝光', 'Click to refresh X views')}>
              <i className={xBusy || xStatus?.running ? 'is-pulse' : ''} />
              {xBusy || xStatus?.running ? tr('X 曝光同步中…', 'Updating X…') : `${tr('X 曝光', 'X views')} · ${exposure.label}`}
            </button>

            {budget?.cap != null ? (
              <button type="button" className="md-status-lamp is-ok" onClick={() => setMonitorDrawer({ tab: 'status', accountId: '' })}>
                <i />
                {tr(`额度 $${Number(budget.spentThisMonth || 0).toFixed(2)} / $${budget.cap}`, `Quota $${Number(budget.spentThisMonth || 0).toFixed(2)}/$${budget.cap}`)}
              </button>
            ) : null}

            <button type="button" className="md-btn is-small" onClick={() => setImportHubOpen(true)}>
              <Icon name="upload" size={13} />{tr('录入 / 导入', 'Import')}
            </button>
            <button type="button" className="md-btn is-small" onClick={() => setMonitorDrawer({ tab: 'status', accountId: '' })}>
              <Icon name="sliders" size={13} />{tr('采集与账单', 'Sync & billing')}
            </button>
          </div>
        </header>

        {/* 第一排 Bento 三大核心卡（代表作表现 + 全域规模与堆叠柱图 + 智能数据分析） */}
        <div className="md-maitian-hero-grid">
          <FeaturedPieceCard
            board={board}
            pieces={board?.pieces || []}
            items={items}
            recentOwnPosts={recentOwnPosts}
          />
          <ScaleStackedCard
            registeredAccounts={registered}
            totalImpressions={pieceStats.impressions || 0}
            manualViews={data?.hasSample ? 0 : (data?.views || 0)}
            totalFollowers={totalFollowers}
            verifiedShorts={pieceStats.verifiedShorts || 0}
            publishedCount={pieceStats.publishedShorts || pieceStats.published || 0}
          />
          <AutoAnalysisCard
            board={board}
            registeredAccounts={registered}
            readyLines={readyLines}
            proposedSkills={proposedSkills}
            onLearn={learnSkills}
          />
        </div>

        {/* 第二排：各平台渠道品牌色趋势卡片矩阵 */}
        <section className="md-maitian-channels">
          <div className="md-maitian-sec-head">
            <h2>{tr('各渠道实时表现', 'Channel performance')}</h2>
            <span>{tr(`${filteredAccounts.length} 个账号 · 点击任意卡片下钻作品与曲线`, `${filteredAccounts.length} channels · click any card for details`)}</span>
            <span className="md-grow" />
            <Segmented
              label={tr('视图', 'View')}
              value={channelView}
              onChange={setChannelView}
              options={[
                { value: 'gallery', icon: 'grid', title: tr('卡片矩阵', 'Bento cards') },
                { value: 'list', icon: 'list', title: tr('表格明细', 'Table') },
              ]}
            />
          </div>

          {!own.data ? (
            <div className="md-bento-card md-empty-card"><span className="md-shimmer">{tr('正在载入渠道数据…', 'Loading channels…')}</span></div>
          ) : channelView === 'list' ? (
            <OwnTable accounts={filteredAccounts} onOpen={openOwn} />
          ) : (
            <div className="md-channel-grid">
              {filteredAccounts.map(account => (
                <ChannelBentoCard
                  key={account.id}
                  account={account}
                  monitorAccount={monById.get(account.id)}
                  onOpen={openOwn}
                />
              ))}
            </div>
          )}
        </section>

        {/* 底部通栏转化与内容线汇总条 */}
        <footer className="md-bento-card md-maitian-footbar">
          <div className="md-footbar-metrics">
            <strong>{tr('内容线漏斗', 'Content pipeline')}</strong>
            <span>{t('已发布稿件')} <b>{pieceStats.published}</b></span>
            <span>{t('总曝光')} <b>{(pieceStats.impressions || 0).toLocaleString()}</b></span>
            <span>{t('已验证短推')} <b>{pieceStats.verifiedShorts}</b><small>/{pieceStats.publishedShorts || 0}</small></span>
            {readyLines.length ? <span className="is-highlight">{t('可升级')} <b>{readyLines.length}</b></span> : null}
          </div>
          <div className="md-footbar-right">
            {xStatus ? (
              <label className="md-xrefresh-auto">
                {tr('X 自动回填', 'Auto X sync')}
                <button
                  type="button"
                  className="md-switch"
                  role="switch"
                  aria-checked={Boolean(xStatus.enabled)}
                  aria-label={tr('X 自动回填', 'Auto X sync')}
                  onClick={() => setXRefresh({ enabled: !xStatus.enabled }).catch(report)}
                />
              </label>
            ) : null}
            <button type="button" className="md-act-link" onClick={() => setLinesTableOpen(v => !v)}>
              {linesTableOpen ? tr('收起内容线排行 ▴', 'Hide lines ▴') : tr('展开内容线排行 ›', 'Content line leaderboard ›')}
            </button>
          </div>
        </footer>

        {/* 按需展开的内容线明细排行榜 */}
        {linesTableOpen && pieceStats.lines.length ? (
          <section className="md-bento-card md-lines-drawer">
            <table className="md-table">
              <thead>
                <tr>
                  <th>{t('内容线')}</th>
                  <th className="is-num">{t('短推曝光')}</th>
                  <th>{t('是否验证')}</th>
                  <th>{t('长文')}</th>
                  <th className="is-num">{t('已分发平台')}</th>
                </tr>
              </thead>
              <tbody>
                {[...pieceStats.lines].sort((a, b) => (b.impressions ?? -1) - (a.impressions ?? -1)).map(line => (
                  <tr key={line.key} onClick={() => openLine(line.key)}>
                    <td><strong>{line.title}</strong></td>
                    <td className="is-num">{line.impressions == null ? '—' : line.impressions.toLocaleString()}</td>
                    <td><span className={`md-state-pill ${line.verified ? 'is-已验证' : ''}`}>{line.verified ? t('已验证 ✓') : t('未验证')}</span></td>
                    <td>{line.longPublished ? t('已发') : t('未发')}</td>
                    <td className="is-num">{line.platforms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </div>

      {/* 录入与数据导入中心弹窗 */}
      {importHubOpen ? (
        <Dialog title={tr('数据录入与导入', 'Import & log metrics')} onClose={() => setImportHubOpen(false)} width={480}>
          <div className="md-import-hub">
            <button type="button" className="md-import-choice" onClick={() => { setImportHubOpen(false); setConnecting(true) }}>
              <Icon name="user" size={18} />
              <div><strong>{t('导入账号数据')}</strong><small>{tr('连接并导入公开主页历史表现并提炼风格', 'Import profile posts & style')}</small></div>
            </button>
            <button type="button" className="md-import-choice" onClick={() => { setImportHubOpen(false); setXCsvOpen(true) }}>
              <PlatformLogo platform="X" size={20} />
              <div><strong>{t('导入 X 数据')}</strong><small>{tr('上传或粘贴 X Analytics 导出的 CSV 报表', 'Import X Analytics CSV')}</small></div>
            </button>
            <button type="button" className="md-import-choice" onClick={() => { setImportHubOpen(false); addMetric(items) }}>
              <Icon name="plus" size={18} />
              <div><strong>{t('录入数据')}</strong><small>{tr('手动登记单篇播放、点赞、评论与收藏', 'Log metrics for a single post')}</small></div>
            </button>
            <button type="button" className="md-import-choice" onClick={() => { setImportHubOpen(false); importCsv() }}>
              <Icon name="upload" size={18} />
              <div><strong>{t('粘贴 CSV')}</strong><small>{tr('批量粘贴多平台每日阅读与互动记录', 'Batch paste CSV rows')}</small></div>
            </button>
          </div>
        </Dialog>
      ) : null}

      {xCsvOpen ? (
        <Dialog title={t('导入 X 数据')} onClose={() => setXCsvOpen(false)} width={520}>
          <form
            className="md-form"
            onSubmit={async event => {
              event.preventDefault()
              const text = new FormData(event.currentTarget).get('csv')
              try {
                const res = await importXMetrics(String(text || ''))
                toast(t('匹配 {n} 条，未匹配 {m} 行', { n: res.matched?.length || 0, m: res.unmatched || 0 }))
                setXCsvOpen(false)
              } catch (err) { report(err) }
            }}
          >
            <label className="md-field">
              <span>{t('粘贴 X Analytics 导出的 CSV')}</span>
              <textarea name="csv" rows={6} placeholder="Post id, Date, Post text, Impressions..." />
            </label>
            <div className="md-form-foot">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={async event => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  try {
                    const res = await importXMetrics(await file.text())
                    toast(t('匹配 {n} 条，未匹配 {m} 行', { n: res.matched?.length || 0, m: res.unmatched || 0 }))
                    setXCsvOpen(false)
                  } catch (err) { report(err) }
                }}
              />
              <span style={{ flex: 1 }} />
              <button type="button" className="md-btn" onClick={() => setXCsvOpen(false)}>{t('取消')}</button>
              <button type="submit" className="md-btn is-primary">{t('导入')}</button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {connecting ? <ConnectDialog onClose={() => setConnecting(false)} /> : null}

      {monitorDrawer ? (
        <Dialog title={tr('采集状态、单篇曲线与月度账单', 'Sync status, series & monthly budget')} onClose={() => setMonitorDrawer(null)} width={900}>
          <MonitorPanel embedded initialTab={monitorDrawer.tab} initialAccountId={monitorDrawer.accountId} />
        </Dialog>
      ) : null}
    </div>
  )
}
