import React from 'react'
import { dispatchOps, getDesk, report, request as deskRequest, setDesk, toast } from './desk.js'
import { lang, t } from './i18n.js'
import { AccountAvatar, AreaSparkline, PlatformLogo, platformChartColor, platformColor, readCustomAvatars, saveCustomAvatar } from './platforms.jsx'
import { Dialog, Empty, Icon, Segmented } from './ui.jsx'
import { benchmarkLabel } from './read-status.js'

const EN = {
  '全部': 'All', '全部平台': 'All platforms', '全部赛道': 'All tracks', '核心盯盘': 'Starred',
  '公开快照': 'Public snapshot', '主页': 'Profile', '点赞': 'Likes',
  'AI 与科技': 'AI & Tech', '学习与教育': 'Education', '商业与社科': 'Business & Society',
  '状态': 'Status', '排序': 'Sort', '加载中…': 'Loading…', '重试': 'Retry', '取消': 'Cancel', '保存': 'Save',
  '对标账号': 'Reference accounts', '添加对标': 'Add account', '添加账号': 'Add account', '立即读取': 'Sync', '导入历史清单': 'Import archive',
  '还没有读取': 'No posts synced yet', '历史清单': 'Archive', '近 3 天': '3D', '近 7 天': '7D', '近 30 天': '30D', '不限时间': 'All time',
  '新': 'New', '已存入': 'Saved', '已忽略': 'Ignored',
  '只看相对爆款': '2×+ viral only', '倍数': 'Viral multiple', '曝光': 'Views', '收藏率': 'Save rate', '时间': 'Latest',
  '共 {total} 条，筛出 {filtered} 条': '{filtered} / {total} items', '读取中 {current}/{total} · @{handle}': 'Syncing {current}/{total} · @{handle}',
  '展开全文': 'Show more', '收起': 'Show less', '赞': 'Likes', '回复': 'Replies', '转发': 'Reposts', '收藏': 'Saves',
  '{n}× 爆款': '{n}× viral', '存入素材': 'Save source', '忽略': 'Dismiss', '原帖': 'Source', '微信原文': 'Article', '小红书原文': 'Note',
  '收进 Wiki': 'Add to Wiki', '已收进 Wiki': 'In Wiki', 'Wiki 排队中': 'Queued', 'Wiki 收录中': 'Indexing',
  '查看产出': 'Outputs', '合并存入': 'Merge & save', '只能合并同一账号的帖子': 'Select posts from one X account to merge',
  '已选 {n} 条': '{n} selected', '清除选择': 'Clear', '选择帖子': 'Select post', '日常均曝': 'Baseline views', '样本不足': 'Building',
  '日均发文': 'Posts / day', '最近同步': 'Last sync', '转化产出': 'Pipeline impact',
  '知识原子数': 'Insights', '已确认': 'Confirmed', '已否决': 'Rejected', '短推数': 'Shorts', '已验证短推': 'Validated',
  '爆款规律': 'Viral patterns', '发布时段 (24h)': 'Peak hours (24h)', '爆款字数': 'Post length', '关注理由': 'Why follow',
  '暂停自动读取': 'Pause auto-sync', '对标矩阵排行': 'Benchmark leaderboard', '账号': 'Account', '没有符合筛选的内容': 'No items match current filters',
  '下一页': 'Next', '上一页': 'Prev', '第 {page} / {total} 页': 'Page {page} of {total}', '读取失败': 'Sync failed', '操作完成': 'Done',
  '账号 ID / Handle': 'Handle or ID', '请输入 X 账号名（如 example）': 'Enter X handle without URL',
  '正在读取…': 'Syncing…', '正在读取全文…': 'Fetching verbatim…', '读取已开始': 'Sync started',
  '已存入 {folder}': 'Saved to {folder}', '还没有填写': 'Add a note in Obsidian profile', '打开档案': 'Obsidian profile',
  '全文未取到': 'Partial text',
  '本次读取原文约 {cost} 美元': 'Estimated verbatim read cost: US${cost}',
  '读取原文实际费用：{cost}美元': 'Verbatim read cost: US${cost}',
  '确认读取并存入': 'Read & save',
  '正在估算原文费用…': 'Estimating cost…',
  '原文由 Monid 直接读取并逐字保存。按实际调用结算，读取失败也可能产生费用。': 'Monid fetches and saves verbatim text per API call.',
  '操作未完成，列表预览已保留：{reason}': 'Action incomplete: {reason}',
  '今日已同步': 'Synced today', '自动盯盘中': 'Monitoring active', '阅读全文': 'Read full text', '阅读拆解': 'Read breakdown',
  '记为灵感': 'Save to ideas', '已记入灵感墙': 'Saved to idea wall', '显示名称': 'Display name', '所属赛道': 'Track',
  '自定义头像链接': 'Custom avatar URL', '粘贴头像图片地址（可选）': 'Optional image URL', '主页链接': 'Profile URL',
  '平台': 'Platform', '全部当前账号': 'All in view', '个账号': 'accounts', '条内容': 'items', '篇收录': 'archived',
  '个性化资料': 'Profile display', '已更新显示设置': 'Display preferences saved', '搜索对标内容或博主…': 'Search posts, titles or creators…',
  '自定义赛道名': 'Custom track', '新建赛道': 'New track', '已同步所选对标账号': 'Synced selected accounts',
  '当前筛选下没有可读取的账号': 'No accounts in current filter',
}

export function benchText(key, vars) {
  const text = lang() === 'en' ? EN[key] || t(key) : key
  return vars ? text.replace(/\{(\w+)\}/g, (match, name) => vars[name] === undefined ? match : String(vars[name])) : text
}

const tr = benchText

// 仅保留默认赛道归类，绝不编造 X 账号中文名；X 显示名一律以推特真实昵称（media-index）或 @handle 为准
const X_DEFAULT_TRACK = Object.create(null)

const BASE_TRACKS = [
  { id: 'all', icon: 'grid', label: '全部赛道' },
  { id: 'starred', icon: 'star', label: '核心盯盘' },
  { id: 'ai', icon: 'spark', label: 'AI 与科技' },
  { id: 'study', icon: 'cap', label: '学习与教育' },
  { id: 'biz', icon: 'globe', label: '商业与社科' },
]

const PREFS_KEY = 'media-desk:bench-prefs-v1'

function readLocalPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {} } catch { return {} }
}

function writeLocalPref(accountKey, patch) {
  try {
    const all = readLocalPrefs()
    all[accountKey] = { ...(all[accountKey] || {}), ...patch }
    localStorage.setItem(PREFS_KEY, JSON.stringify(all))
    return all
  } catch {
    return {}
  }
}

const number = value => value == null ? '—' : Number(value).toLocaleString(lang() === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: 1 })
const compactNum = value => {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const n = Number(value)
  if (lang() === 'en') {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return String(Math.round(n))
  }
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
}

const shortTime = value => {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  const d = new Date(value)
  const diffH = (Date.now() - d.getTime()) / 3600000
  if (diffH >= 0 && diffH < 1) return lang() === 'en' ? `${Math.max(1, Math.round(diffH * 60))}m` : `${Math.max(1, Math.round(diffH * 60))} 分钟前`
  if (diffH >= 1 && diffH < 24) return lang() === 'en' ? `${Math.floor(diffH)}h` : `${Math.floor(diffH)} 小时前`
  return `${d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}/`}${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const shortDay = value => {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  if (!Number.isFinite(Date.parse(value))) return ''
  return new Date(value).toISOString().slice(0, 10)
}

const dollars = value => Number(value).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 6, useGrouping: false })

async function request(route = '', body, signal) {
  const data = await deskRequest(`bench${route ? `/${route}` : ''}`, body)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return data
}

function XhsCoverTone(seedText = '') {
  let h = 0
  for (const ch of String(seedText)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  const palettes = [
    ['#FFF1F2', '#FFE4E6', '#9F1239', '#FF2442'],
    ['#EFF6FF', '#DBEAFE', '#1E3A8A', '#2563EB'],
    ['#ECFDF5', '#D1FAE5', '#065F46', '#059669'],
    ['#FFFBEB', '#FEF3C7', '#92400E', '#D97706'],
    ['#F5F3FF', '#EDE9FE', '#4C1D95', '#7C3AED'],
  ]
  return palettes[h % palettes.length]
}

function Bars({ values, labels, title, color }) {
  const max = Math.max(1, ...values)
  return (
    <section className="md-bench-chart-card">
      <h3>{tr(title)}</h3>
      <div className={`md-bench-bars ${values.length === 24 ? 'is-hours' : ''}`}>
        {values.map((value, index) => (
          <div key={index} title={`${labels[index]}: ${number(value)}`}>
            <i style={{ height: `${Math.max(3, (value / max) * 58)}px`, background: value ? color : 'var(--line)' }} />
            <small>{values.length === 24 ? (index % 4 === 0 ? `${index}h` : '') : labels[index]}</small>
          </div>
        ))}
      </div>
    </section>
  )
}

/** X（推特）原生推文信息流卡片 */
function XPostCard({ post, account, selected, onSelect, busy, run }) {
  const [expanded, setExpanded] = React.useState(false)
  const bodyRef = React.useRef(null)
  const [overflow, setOverflow] = React.useState(false)

  React.useEffect(() => {
    if (expanded) return undefined
    const el = bodyRef.current
    if (!el) return undefined
    const measure = () => setOverflow(el.scrollHeight > el.clientHeight + 2)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [post.text, expanded])

  const ids = { ids: [post.id] }
  const original = /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(post.url || '') ? post.url : null
  const wikiActive = ['queued', 'running', 'done'].includes(post.wikiStatus)
  const isViral = post.multiple != null && post.multiple >= 2
  const displayName = account?.displayName || `@${post.handle}`
  const showHandleSub = displayName.toLowerCase() !== `@${post.handle}`.toLowerCase()

  return (
    <article className={`md-feed-card md-tweet-card ${selected ? 'is-selected' : ''} ${isViral ? 'is-viral' : ''}`}>
      <div className="md-tweet-left">
        <AccountAvatar
          name={displayName}
          handle={post.handle}
          platform="X"
          src={account?.avatar || ''}
          avatarKey={account?.accountKey || `x-${post.handle.toLowerCase()}`}
          size={42}
        />
        <label className="md-tweet-select" title={tr('选择帖子')}>
          <input type="checkbox" aria-label={tr('选择帖子')} checked={selected} onChange={onSelect} />
        </label>
      </div>
      <div className="md-tweet-main">
        <header className="md-tweet-head">
          <div className="md-tweet-author">
            <strong>{displayName}</strong>
            {showHandleSub ? <span className="md-tweet-handle">@{post.handle}</span> : null}
            <span className="md-tweet-sep">·</span>
            <time dateTime={post.createdAt || undefined}>{shortTime(post.createdAt)}</time>
          </div>
          <div className="md-tweet-badges">
            {post.multiple != null ? (
              <span className={`md-viral-badge ${isViral ? 'is-hot' : ''}`}>
                {isViral ? <Icon name="flame" size={12} /> : null}
                {tr('{n}× 爆款', { n: number(post.multiple) })}
              </span>
            ) : null}
            {post.status && post.status !== '新' ? <span className={`md-state-pill is-${post.status}`}>{tr(post.status)}</span> : null}
            {post.history ? <span className="md-state-pill">{tr('历史清单')}</span> : null}
            <PlatformLogo platform="X" size={18} />
          </div>
        </header>

        <div ref={bodyRef} className={`md-tweet-body ${expanded ? '' : 'is-folded'}`}>{post.text}</div>
        {overflow || expanded ? (
          <button type="button" className="md-feed-more" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>
            {tr(expanded ? '收起' : '展开全文')}
          </button>
        ) : null}

        <div className="md-tweet-stats" aria-label="互动数据">
          <span title={tr('回复')}><Icon name="comment" size={14} /><b>{compactNum(post.replies)}</b></span>
          <span title={tr('转发')}><Icon name="repost" size={14} /><b>{compactNum(post.reposts)}</b></span>
          <span title={tr('赞')}><Icon name="heart" size={14} /><b>{compactNum(post.likes)}</b></span>
          <span title={tr('收藏')}>
            <Icon name="bookmark" size={14} />
            <b>{compactNum(post.bookmarks)}</b>
            {post.bookmarkRate != null ? <em>{number(post.bookmarkRate * 100)}%</em> : null}
          </span>
          <span className="is-views" title={tr('曝光')}><Icon name="chart" size={14} /><b>{compactNum(post.views)}</b></span>
        </div>

        <footer className="md-feed-actions">
          <button type="button" className="md-act-btn" disabled={busy || Boolean(post.savedPath)} onClick={() => run('save', ids)}>
            {tr('存入素材')}
          </button>
          {post.savedPath ? (
            <button type="button" className="md-act-btn" disabled={busy || wikiActive} onClick={() => run('wiki', { path: post.savedPath })}>
              {tr(post.wikiStatus === 'done' ? '已收进 Wiki' : post.wikiStatus === 'queued' ? 'Wiki 排队中' : post.wikiStatus === 'running' ? 'Wiki 收录中' : '收进 Wiki')}
            </button>
          ) : null}
          <span className="md-grow" />
          {original ? <a className="md-act-link" href={original} target="_blank" rel="noopener noreferrer">{tr('原帖')} ↗</a> : null}
          <button type="button" className="md-act-link is-muted" disabled={busy || post.status === '已忽略'} onClick={() => run('ignore', ids)}>
            {tr('忽略')}
          </button>
        </footer>
      </div>
    </article>
  )
}

/** 公众号原生图文卡片（支持真实文章封面图；过往无封面归档自动以清爽无假图版式呈现） */
function WechatArticleCard({ post, account, onRead, onCapture }) {
  const displayName = account?.displayName || post.displayName || '公众号'
  const day = post.publishedDay || shortDay(post.createdAt)
  const [coverErr, setCoverErr] = React.useState(false)
  const hasRealCover = Boolean(post.cover && !coverErr)

  return (
    <article className="md-feed-card md-wx-card">
      <header className="md-wx-card-head">
        <AccountAvatar
          name={displayName}
          handle={post.accountKey || displayName}
          platform="公众号"
          src={account?.avatar || ''}
          avatarKey={account?.accountKey || post.accountKey}
          size={32}
        />
        <strong>{displayName}</strong>
        <span className="md-wx-badge"><PlatformLogo platform="公众号" size={14} />公众号</span>
        {day ? <time>{day}</time> : null}
      </header>
      <div
        className={`md-wx-card-body ${hasRealCover ? 'has-cover' : 'no-cover'}`}
        onClick={() => onRead(post)}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter') onRead(post) }}
      >
        <div className="md-wx-card-copy">
          <h3>{post.title}</h3>
          <p>{post.excerpt || post.text?.slice(0, 140)}</p>
        </div>
        {hasRealCover ? (
          <div className="md-wx-card-photo">
            <img src={post.cover} alt="" loading="lazy" onError={() => setCoverErr(true)} />
          </div>
        ) : null}
      </div>
      <footer className="md-feed-actions">
        <button type="button" className="md-act-btn is-primary" onClick={() => onRead(post)}>
          <Icon name="eye" size={13} />{tr('阅读全文')}
        </button>
        <button type="button" className="md-act-btn" onClick={() => onCapture(post)}>
          <Icon name="plus" size={13} />{tr('记为灵感')}
        </button>
        {post.views != null ? <span className="md-wx-metric"><Icon name="eye" size={13} />{compactNum(post.views)}</span> : null}
        <span className="md-grow" />
        {post.url ? <a className="md-act-link" href={post.url} target="_blank" rel="noopener noreferrer">{tr('微信原文')} ↗</a> : null}
        {post.vaultPath ? (
          <button type="button" className="md-act-link" onClick={() => { window.location.href = `obsidian://open?vault=${encodeURIComponent('知识库')}&file=${encodeURIComponent(post.vaultPath)}` }}>
            Obsidian ↗
          </button>
        ) : null}
      </footer>
    </article>
  )
}

/** 小红书原生笔记瀑布流卡片（优先渲染小红书真实笔记封面图，历史无图拆解自动回退至封面文案卡） */
function XhsNoteCard({ post, account, onRead, onCapture }) {
  const displayName = account?.displayName || post.displayName || '小红书博主'
  const [coverErr, setCoverErr] = React.useState(false)
  const hasRealCover = Boolean(post.cover && !coverErr)
  const [bg1, bg2, inkColor, accent] = XhsCoverTone(post.title || post.id)

  return (
    <article className="md-feed-card md-xhs-card">
      {hasRealCover ? (
        <div
          className="md-xhs-photo-cover"
          onClick={() => onRead(post)}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter') onRead(post) }}
        >
          <img src={post.cover} alt="" loading="lazy" onError={() => setCoverErr(true)} />
          <div className="md-xhs-cover-top is-overlay">
            <span className="md-xhs-kind">{post.kind || '图文'}</span>
            <PlatformLogo platform="小红书" size={20} />
          </div>
          {post.kind === '视频' ? <span className="md-xhs-play"><Icon name="play" size={13} fill /></span> : null}
        </div>
      ) : (
        <div
          className="md-xhs-cover"
          style={{ background: `linear-gradient(155deg, ${bg1}, ${bg2})`, color: inkColor }}
          onClick={() => onRead(post)}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter') onRead(post) }}
        >
          <div className="md-xhs-cover-top">
            <span className="md-xhs-kind">{post.kind || '历史样本'}</span>
            <PlatformLogo platform="小红书" size={20} />
          </div>
          <div className="md-xhs-cover-quote">
            <i style={{ background: accent }} />
            <b>{(post.coverText || post.title || '').slice(0, 34)}</b>
          </div>
          {post.tags?.length ? (
            <div className="md-xhs-cover-tags">
              {post.tags.slice(0, 3).map(tag => <span key={tag}>#{tag}</span>)}
            </div>
          ) : null}
        </div>
      )}

      <div className="md-xhs-body">
        <h3 onClick={() => onRead(post)}>{post.title}</h3>
        {!hasRealCover && post.excerpt ? <p>{post.excerpt}</p> : null}
        <footer className="md-xhs-foot">
          <div className="md-xhs-author">
            <AccountAvatar
              name={displayName}
              handle={post.accountKey || displayName}
              platform="小红书"
              src={account?.avatar || ''}
              avatarKey={account?.accountKey || post.accountKey}
              size={24}
              badge={false}
            />
            <span>{displayName}</span>
          </div>
          <div className="md-xhs-ops">
            {post.url ? <a className="md-act-link" href={post.url} target="_blank" rel="noopener noreferrer">{tr('小红书原文')} ↗</a> : null}
            <button type="button" className="md-xhs-read" onClick={() => onRead(post)}>
              <Icon name="heart" size={13} />{post.likes != null ? compactNum(post.likes) : tr('阅读拆解')}
            </button>
          </div>
        </footer>
      </div>
    </article>
  )
}

/** 通用平台监控内容卡片 */
function GenericPlatformCard({ post, account, onRead, onCapture }) {
  const displayName = account?.displayName || post.displayName || post.platform
  return (
    <article className="md-feed-card md-wx-card">
      <header className="md-wx-card-head">
        <AccountAvatar name={displayName} handle={account?.handle || displayName} platform={post.platform} src={account?.avatar || ''} avatarKey={account?.accountKey} size={30} />
        <strong>{displayName}</strong>
        <span className="md-state-pill">{post.platform}</span>
        {post.publishedDay ? <time>{post.publishedDay}</time> : null}
      </header>
      <div className="md-wx-card-body no-cover" onClick={() => onRead(post)} role="button" tabIndex={0}>
        <div className="md-wx-card-copy">
          <h3>{post.title || post.text?.slice(0, 60)}</h3>
          {post.text ? <p>{post.text.slice(0, 140)}</p> : null}
        </div>
      </div>
      <footer className="md-feed-actions">
        {post.views != null ? <span className="md-wx-metric"><Icon name="chart" size={13} />{compactNum(post.views)}</span> : null}
        {post.likes != null ? <span className="md-wx-metric"><Icon name="heart" size={13} />{compactNum(post.likes)}</span> : null}
        <button type="button" className="md-act-btn" onClick={() => onCapture(post)}><Icon name="plus" size={13} />{tr('记为灵感')}</button>
        <span className="md-grow" />
        {post.url ? <a className="md-act-link" href={post.url} target="_blank" rel="noopener noreferrer">{tr('原帖')} ↗</a> : null}
      </footer>
    </article>
  )
}

const sampleArt = ['hills', 'aurora', 'riso', 'sea', 'topo', 'ink', 'night', 'blush', 'stairs', 'dunes']
function PublicWork({ post, account }) {
  const seed = Array.from(post.id).reduce((n,c) => (31*n + c.codePointAt(0)) >>> 0, 0)
  const art = `media-desk/assets/${sampleArt[seed % sampleArt.length]}.jpg`
  const title = <><img src={art} alt="" loading="lazy" /><span><PlatformLogo platform={post.platform} size={18} />{post.platform}</span><b>{post.title}</b></>
  const metric = post.views != null ? `${compactNum(post.views)} ${tr('曝光')}` : post.likes != null ? `♡ ${compactNum(post.likes)}` : post.stars != null ? `☆ ${compactNum(post.stars)}` : ''
  return <article className="md-public-work">
    {post.url ? <a className="md-public-face" href={post.url} target="_blank" rel="noopener noreferrer" aria-label={`${post.platform}：${post.title}`}>{title}</a> : <div className="md-public-face">{title}</div>}
    <footer><AccountAvatar name={account.displayName} platform={post.platform} src={account.avatar} size={24} badge={false} />
      <strong>{account.displayName}</strong><time dateTime={post.createdAt}>{post.createdAt?.slice(0,10)}</time>{metric && <small>{metric}</small>}
    </footer>
  </article>
}

function AccountSidebarDetail({ account, tracks, busy, run, onPrefChange }) {
  const effects = account.effects || {}
  const [editing, setEditing] = React.useState(false)
  const [nameInput, setNameInput] = React.useState(account.customName || '')
  const [avatarInput, setAvatarInput] = React.useState(() => readCustomAvatars()[account.accountKey] || '')
  const [customTrackInput, setCustomTrackInput] = React.useState('')
  const chartColor = platformChartColor(account.platform)

  React.useEffect(() => {
    setNameInput(account.customName || '')
    setAvatarInput(readCustomAvatars()[account.accountKey] || '')
    setEditing(false)
  }, [account.accountKey, account.customName])

  const saveDisplay = event => {
    event.preventDefault()
    saveCustomAvatar(account.accountKey, avatarInput.trim())
    onPrefChange(account.accountKey, { customName: nameInput.trim() })
    setEditing(false)
    toast(tr('已更新显示设置'))
  }

  const addCustomTrack = event => {
    event.preventDefault()
    const clean = customTrackInput.trim()
    if (!clean) return
    onPrefChange(account.accountKey, { track: clean })
    setCustomTrackInput('')
  }

  return (
    <div className="md-bench-detail">
      <div className="md-bench-profile-top">
        <AccountAvatar
          name={account.displayName}
          handle={account.handle}
          platform={account.platform}
          src={account.avatar || ''}
          avatarKey={account.accountKey}
          size={54}
        />
        <div className="md-bench-profile-meta">
          <div className="md-bench-profile-title">
            <h2>{account.displayName}</h2>
            <button
              type="button"
              className={`md-star-btn ${account.starred ? 'is-on' : ''}`}
              title={tr('核心盯盘')}
              onClick={() => onPrefChange(account.accountKey, { starred: !account.starred })}
            >
              <Icon name="star" size={15} fill={account.starred} />
            </button>
          </div>
          <p>{account.platform === 'X' ? `@${account.handle}` : `${account.platform} · ${account.totalCount ?? account.postCount ?? 0} ${tr('篇收录')}`}</p>
        </div>
        <button type="button" className="md-icon-btn" title={tr('个性化资料')} onClick={() => setEditing(v => !v)}>
          <Icon name="edit" size={15} />
        </button>
      </div>

      {/* 赛道标签选择与自定义打标 */}
      <div className="md-bench-track-section">
        <div className="md-bench-track-pills" role="group" aria-label={tr('所属赛道')}>
          {tracks.filter(item => item.id !== 'all' && item.id !== 'starred').map(item => (
            <button
              type="button"
              key={item.id}
              className={`md-track-chip ${account.track === item.id ? 'is-on' : ''}`}
              onClick={() => onPrefChange(account.accountKey, { track: item.id })}
            >
              <Icon name={item.icon || 'spark'} size={12} />{tr(item.label)}
            </button>
          ))}
        </div>
        <form className="md-custom-track-inline" onSubmit={addCustomTrack}>
          <input value={customTrackInput} onChange={e => setCustomTrackInput(e.target.value)} placeholder={`+ ${tr('自定义赛道名')}`} />
          {customTrackInput.trim() ? <button type="submit" className="md-act-btn is-primary">{tr('保存')}</button> : null}
        </form>
      </div>

      {editing ? (
        <form className="md-bench-pref-form" onSubmit={saveDisplay}>
          <label className="md-field">
            <span>{tr('显示名称')}（留空则使用平台原生昵称）</span>
            <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder={account.nativeName || account.handle} />
          </label>
          <label className="md-field">
            <span>{tr('自定义头像链接')}</span>
            <input value={avatarInput} onChange={e => setAvatarInput(e.target.value)} placeholder={tr('粘贴头像图片地址（可选）')} />
          </label>
          <div className="md-form-foot">
            <button type="submit" className="md-btn is-small is-primary">{tr('保存')}</button>
            <button type="button" className="md-btn is-small" onClick={() => setEditing(false)}>{tr('取消')}</button>
          </div>
        </form>
      ) : null}

      {account.platform === 'X' && !account.monitorOnly && !account.publicSample ? (
        <>
          <div className="md-bench-kpi-grid">
            <div><span>{tr('日常均曝')}</span><strong>{account.baseline?.sufficient ? compactNum(account.baseline.median) : tr('样本不足')}</strong></div>
            <div><span>{tr('日均发文')}</span><strong>{number(account.averagePerDay)}</strong></div>
            <div><span>{tr('知识原子数')}</span><strong>{number(effects.atoms ?? 0)}</strong></div>
            <div><span>{tr('已验证短推')}</span><strong>{number(effects.verified ?? 0)}</strong></div>
          </div>

          <div className="md-bench-mini-stats">
            <span>{tr('已确认')} <b>{number(effects.confirmed ?? 0)}</b></span>
            <span>{tr('短推数')} <b>{number(effects.shorts ?? 0)}</b></span>
          </div>

          <Bars title="发布时段 (24h)" color={chartColor} values={account.distributions?.hours || Array(24).fill(0)} labels={Array.from({ length: 24 }, (_, i) => i)} />
          <Bars title="爆款字数" color={chartColor} values={account.distributions?.lengths || [0, 0, 0, 0]} labels={['≤140', '141–280', '281–1k', '>1k']} />
        </>
      ) : (
        <div className="md-bench-kpi-grid">
          <div><span>{tr('平台')}</span><strong>{account.platform}</strong></div>
          <div><span>{tr('篇收录')}</span><strong>{number(account.totalCount ?? account.postCount ?? 0)}</strong></div>
        </div>
      )}

      <div className="md-bench-reason-box">
        <span>{tr('关注理由')}</span>
        <p>{!account.reason?.trim() || /^待\s*Editor\s*补充[。.]?$/i.test(account.reason.trim()) ? tr('还没有填写') : account.reason}</p>
      </div>

      <div className="md-bench-detail-foot">
        {account.homeUrl ? <a className="md-act-link" href={account.homeUrl} target="_blank" rel="noopener noreferrer">{tr('主页')} ↗</a> : null}
        {account.path ? (
          <button type="button" className="md-btn is-small" onClick={() => { window.location.href = `obsidian://open?vault=${encodeURIComponent('知识库')}&file=${encodeURIComponent(account.path)}` }}>
            <Icon name="upRight" size={13} />{tr('打开档案')}
          </button>
        ) : null}
        {account.platform === 'X' && !account.monitorOnly && !account.publicSample ? (
          <label className="md-bench-check">
            <input type="checkbox" checked={!account.enabled} disabled={busy} onChange={event => run('account/toggle', { handle: account.handle, enabled: !event.target.checked })} />
            {tr('暂停自动读取')}
          </label>
        ) : null}
      </div>
    </div>
  )
}

export function BenchView() {
  const [data, setData] = React.useState(null)
  const [library, setLibrary] = React.useState({ accounts: [], posts: [], media: { accounts: {}, covers: {} }, prefs: {} })
  const [monitorCatalog, setMonitorCatalog] = React.useState(null)
  const [monitorPosts, setMonitorPosts] = React.useState({})
  const [localPrefs, setLocalPrefs] = React.useState(readLocalPrefs)
  const [error, setError] = React.useState('')
  const [actionError, setActionError] = React.useState('')

  const [platformFilter, setPlatformFilter] = React.useState('all')
  const [trackFilter, setTrackFilter] = React.useState('all')
  const [selectedAccountKey, setSelectedAccountKey] = React.useState(() => {
    const initial = getDesk().benchHandle
    return initial && initial !== 'all' ? `x-${String(initial).toLowerCase()}` : 'all'
  })

  const [range, setRange] = React.useState('all')
  const [status, setStatus] = React.useState('all')
  const [viral, setViral] = React.useState(false)
  const [sort, setSort] = React.useState('time')
  const [searchQ, setSearchQ] = React.useState('')
  const [page, setPage] = React.useState(0)
  const [selected, setSelected] = React.useState(new Set())
  const [busy, setBusy] = React.useState(false)
  const [action, setAction] = React.useState('')
  const [adding, setAdding] = React.useState(false)
  const [addForm, setAddForm] = React.useState({ platform: 'X', track: 'ai', displayName: '', handle: '', homeUrl: '', avatarUrl: '' })
  const [confirm, setConfirm] = React.useState(null)
  const [readingPost, setReadingPost] = React.useState(null)

  const mounted = React.useRef(false)
  const actionLock = React.useRef(false)
  const generation = React.useRef(0)

  const load = React.useCallback(async signal => {
    const current = ++generation.current
    const [nextBench, nextLib, nextMon] = await Promise.all([
      request('', undefined, signal),
      deskRequest('bench/library').catch(() => ({ accounts: [], posts: [], media: { accounts: {}, covers: {} }, prefs: {} })),
      deskRequest('monitor/accounts').catch(() => null),
    ])
    if (mounted.current && current === generation.current) {
      setData(nextBench)
      if (nextLib) setLibrary(nextLib)
      if (nextMon) setMonitorCatalog(nextMon)
      setError('')
    }
  }, [])

  React.useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    let timer
    const poll = async () => {
      try { await load(controller.signal) } catch (err) { if (!controller.signal.aborted) setError(err.message) }
      if (!controller.signal.aborted) timer = setTimeout(poll, 8000)
    }
    poll()
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer) }
  }, [load])

  React.useEffect(() => { setPage(0); setSelected(new Set()) }, [platformFilter, trackFilter, selectedAccountKey, range, status, viral, sort, searchQ])

  const mergedPrefs = React.useMemo(() => {
    const server = library?.prefs || {}
    const out = { ...localPrefs }
    for (const [k, v] of Object.entries(server)) out[k] = { ...(out[k] || {}), ...v }
    return out
  }, [localPrefs, library?.prefs])

  const updatePref = async (accountKey, patch) => {
    setLocalPrefs(writeLocalPref(accountKey, patch))
    try {
      const res = await deskRequest('bench/prefs', { accountKey, patch })
      if (mounted.current && res?.prefs) setLibrary(old => ({ ...old, prefs: res.prefs }))
    } catch { /* localStorage already updated */ }
  }

  // 合并所有对标账号（X 使用推特真实昵称与真实头像，公众号/小红书挂载 Monid 真实头像）
  const allAccounts = React.useMemo(() => {
    const map = new Map()
    const xPosts = data?.posts || []
    const mediaAccounts = library?.media?.accounts || {}

    for (const row of data?.accounts || []) {
      const lower = row.handle.toLowerCase()
      const accountKey = `x-${lower}`
      const mInfo = mediaAccounts[accountKey] || {}
      const pref = mergedPrefs[accountKey] || {}
      const ownPosts = xPosts.filter(p => p.handle?.toLowerCase() === lower && !p.history)
      const spark = ownPosts.slice(0, 10).reverse().map(p => Number(p.views) || 0)
      const nativeName = mInfo.displayName || `@${row.handle}`
      map.set(accountKey, {
        ...row,
        periodHours: 24,
        accountKey,
        platform: 'X',
        nativeName,
        customName: pref.customName || '',
        displayName: pref.customName || nativeName,
        avatar: mInfo.avatar || '',
        track: pref.track || X_DEFAULT_TRACK[lower] || 'ai',
        starred: pref.starred ?? false,
        totalCount: ownPosts.length,
        spark,
      })
    }

    for (const row of library?.accounts || []) {
      const pref = mergedPrefs[row.accountKey] || {}
      const mInfo = mediaAccounts[row.accountKey] || {}
      map.set(row.accountKey, {
        ...row,
        nativeName: row.displayName,
        customName: pref.customName || '',
        displayName: pref.customName || row.displayName,
        avatar: row.avatar || mInfo.avatar || '',
        userId: row.userId || mInfo.userId || '',
        username: row.username || mInfo.username || '',
        track: pref.track || row.track || 'biz',
        starred: pref.starred ?? false,
        spark: (library.posts || []).filter(p => p.accountKey === row.accountKey && p.likes != null).sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(-10).map(p => p.likes),
      })
    }

    for (const mon of monitorCatalog?.accounts || []) {
      if (!mon.roles?.includes('bench')) continue
      const xAccount = mon.platform === 'X' && map.get(`x-${String(mon.handle || '').toLowerCase()}`)
      if (xAccount) {
        xAccount.periodHours = mon.postsIntervalHours
        const run = mon.lastPostsRead
        if (run && (run.at || '') > (xAccount.lastAttemptAt || '')) {
          xAccount.error = ['failed', 'uncertain'].includes(run.status)
          xAccount.missed = 0
          xAccount.failed = []
          xAccount.added = run.status === 'committed' && run.count === 0 ? 0 : null
        }
        if (mon.lastPostsSuccessAt > (xAccount.lastSuccessAt || '')) xAccount.lastSuccessAt = mon.lastPostsSuccessAt
        continue
      }
      const accountKey = `mon-${mon.accountId}`
      if (map.has(accountKey)) continue
      const pref = mergedPrefs[accountKey] || {}
      const mInfo = mediaAccounts[accountKey] || {}
      map.set(accountKey, {
        accountKey,
        monitorAccountId: mon.accountId,
        monitorOnly: true,
        handle: mon.handle || mon.displayName,
        nativeName: mon.displayName || mon.handle,
        customName: pref.customName || '',
        displayName: pref.customName || mon.displayName || mon.handle,
        avatar: mInfo.avatar || '',
        platform: mon.platform,
        track: pref.track || 'biz',
        starred: pref.starred ?? false,
        enabled: mon.enabled,
        totalCount: mon.postCount || 0,
        postCount: mon.postCount || 0,
        lastReadAt: mon.lastRun?.observedAt || null,
        lastSuccessAt: mon.lastPostsSuccessAt,
        error: ['failed', 'uncertain'].includes(mon.lastPostsRead?.status),
        added: mon.lastPostsRead?.status === 'committed' && mon.lastPostsRead.count === 0 ? 0 : null,
        periodHours: mon.postsIntervalHours,
        spark: [1, 2, 2, 3, Math.max(1, mon.postCount || 1)],
      })
    }

    return [...map.values()]
  }, [data, library, monitorCatalog, mergedPrefs])

  // 动态汇总内置赛道 + 用户打出来的自定义赛道标签
  const allTracks = React.useMemo(() => {
    const known = new Set(BASE_TRACKS.map(item => item.id))
    const extras = []
    for (const acc of allAccounts) {
      if (acc.track && !known.has(acc.track)) {
        known.add(acc.track)
        extras.push({ id: acc.track, icon: 'spark', label: acc.track })
      }
    }
    return [...BASE_TRACKS, ...extras]
  }, [allAccounts])

  const activeAccount = allAccounts.find(a => a.accountKey === selectedAccountKey) || null
  React.useEffect(() => {
    const monId = activeAccount?.monitorAccountId
    if (!monId || monitorPosts[monId]) return
    deskRequest(`monitor/posts?accountId=${encodeURIComponent(monId)}&limit=50`)
      .then(res => {
        if (mounted.current && Array.isArray(res?.posts)) {
          setMonitorPosts(old => ({ ...old, [monId]: res.posts }))
        }
      })
      .catch(() => {})
  }, [activeAccount?.monitorAccountId, monitorPosts])

  const platforms = React.useMemo(() => {
    const order = ['X', '公众号', '小红书', '抖音', 'B站', '视频号', 'YouTube', '知乎']
    const counts = new Map()
    for (const acc of allAccounts) counts.set(acc.platform, (counts.get(acc.platform) || 0) + 1)
    for (const base of ['X', '公众号', '小红书']) if (!counts.has(base)) counts.set(base, 0)
    return [...counts.entries()].sort(([a], [b]) => {
      const ia = order.indexOf(a)
      const ib = order.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
    })
  }, [allAccounts])

  const accountsAfterPlatform = React.useMemo(
    () => allAccounts.filter(a => platformFilter === 'all' || a.platform === platformFilter),
    [allAccounts, platformFilter]
  )

  const visibleAccounts = React.useMemo(
    () => accountsAfterPlatform.filter(a => {
      if (trackFilter === 'all') return true
      if (trackFilter === 'starred') return Boolean(a.starred)
      return a.track === trackFilter
    }),
    [accountsAfterPlatform, trackFilter]
  )

  React.useEffect(() => {
    if (selectedAccountKey !== 'all' && !visibleAccounts.some(a => a.accountKey === selectedAccountKey)) {
      setSelectedAccountKey('all')
    }
  }, [visibleAccounts, selectedAccountKey])

  const allPosts = React.useMemo(() => {
    const xRows = (data?.posts || []).map(p => ({
      ...p,
      platform: 'X',
      accountKey: `x-${String(p.handle || '').toLowerCase()}`,
    }))
    const libRows = library?.posts || []
    const monRows = Object.entries(monitorPosts).flatMap(([monId, list]) => {
      const acc = allAccounts.find(a => a.monitorAccountId === monId)
      if (!acc) return []
      return list.map(row => {
        const latestSeries = row.series?.[0]?.values || {}
        return {
          id: `mon:${row.postKey}`,
          platform: acc.platform,
          accountKey: acc.accountKey,
          handle: acc.handle,
          displayName: acc.displayName,
          title: row.title || row.postId,
          text: row.title || '',
          url: row.url,
          createdAt: row.publishedAt || (row.publishedDay ? `${row.publishedDay}T12:00:00Z` : null),
          publishedDay: row.publishedDay,
          views: latestSeries.views,
          likes: latestSeries.likes,
          status: '新',
        }
      })
    })
    return [...xRows, ...libRows, ...monRows]
  }, [data, library, monitorPosts, allAccounts])

  const accountByKey = React.useMemo(() => new Map(allAccounts.map(a => [a.accountKey, a])), [allAccounts])
  const visibleKeySet = React.useMemo(() => new Set(visibleAccounts.map(a => a.accountKey)), [visibleAccounts])

  const filteredPosts = React.useMemo(() => {
    const cutoff = range === 'all' || range === 'history' ? 0 : Date.now() - Number(range) * 86400000
    const q = searchQ.trim().toLowerCase()
    return allPosts.filter(post => {
      if (selectedAccountKey !== 'all') {
        if (post.accountKey !== selectedAccountKey) return false
      } else if (!visibleKeySet.has(post.accountKey)) {
        return false
      }
      if (range === 'history') {
        if (!post.history && !post.library) return false
      } else if (range !== 'all' && (post.publicSample || post.platform === 'X')) {
        if (post.history) return false
        if (!post.createdAt || Date.parse(post.createdAt) < cutoff) return false
      }
      if (status !== 'all' && (post.publicSample || post.platform === 'X')) {
        if (post.status !== status) return false
      }
      if (viral && (post.publicSample || post.platform === 'X') && !(post.multiple >= 2)) return false
      if (q) {
        const hay = `${post.title || ''} ${post.text || ''} ${post.handle || ''} ${post.displayName || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      if (sort === 'time') return (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0)
      const val = p => {
        if (p[sort] != null) return Number(p[sort])
        if (sort === 'multiple' && p.views != null) return Number(p.views) / 10000
        if (p.cover) return 1.2
        return p.library ? 0.5 : -1
      }
      return val(b) - val(a) || (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0)
    })
  }, [allPosts, selectedAccountKey, visibleKeySet, range, status, viral, searchQ, sort])

  const perform = async (route, body) => {
    if (actionLock.current) return false
    actionLock.current = true
    setBusy(true)
    setAction(route)
    setActionError('')
    try {
      const result = await request(route, body)
      const notices = [tr(route === 'refresh' ? '读取已开始' : route === 'save' && result.path ? '已存入 {folder}' : '操作完成', { folder: result.path?.split('/').slice(0, -1).join('/') })]
      if (route === 'save') {
        if (result.fulltextunavailable || result.textComplete === false) notices.push(tr('全文未取到'))
        if (result.costUSD != null) notices.push(tr('读取原文实际费用：{cost}美元', { cost: dollars(result.costUSD) }))
      }
      toast(notices.join(' · '))
      if (mounted.current) setSelected(new Set())
      await load()
      return true
    } catch (err) {
      if (mounted.current && route === 'save') setActionError(tr('操作未完成，列表预览已保留：{reason}', { reason: err.message }))
      report(err)
      return false
    } finally {
      actionLock.current = false
      if (mounted.current) { setBusy(false); setAction('') }
    }
  }

  const run = async (route, body) => {
    if (route !== 'save') return perform(route, body)
    if (actionLock.current) return false
    actionLock.current = true
    setBusy(true)
    setAction('estimate')
    setActionError('')
    try {
      const estimate = await request('estimate', body)
      if (mounted.current) setConfirm({ route, body, estimate })
      return true
    } catch (err) {
      if (mounted.current) setActionError(tr('操作未完成，列表预览已保留：{reason}', { reason: err.message }))
      report(err)
      return false
    } finally {
      actionLock.current = false
      if (mounted.current) { setBusy(false); setAction('') }
    }
  }

  const refresh = data?.refresh || {}
  const chosen = allPosts.filter(p => p.platform === 'X' && selected.has(p.id))
  const sameAccount = new Set(chosen.map(p => p.handle)).size === 1
  const canMerge = chosen.length > 1 && sameAccount && !chosen.some(p => p.savedPath)

  // 计算「立即读取」精准作用域（严格跟随当前平台 × 赛道 × 选中账号，绝不误扫无关平台）
  const scopeAccounts = activeAccount ? [activeAccount] : visibleAccounts
  const syncTargets = scopeAccounts.filter(account => !account.publicSample)
  const snapshotOnly = scopeAccounts.length > 0 && syncTargets.length === 0
  const readStatus = snapshotOnly ? { label: tr('公开快照'), warn: false } : benchmarkLabel(syncTargets)
  const syncScopeLabel = React.useMemo(() => {
    if (activeAccount) return `${tr('立即读取')} · ${activeAccount.displayName.slice(0, 10)}`
    const parts = []
    if (platformFilter !== 'all') parts.push(tr(platformFilter))
    if (trackFilter !== 'all') {
      const foundTrack = allTracks.find(item => item.id === trackFilter)
      parts.push(tr(foundTrack?.label || trackFilter))
    }
    if (!parts.length) return tr('立即读取')
    return `${tr('立即读取')} · ${parts.join('·')} (${syncTargets.length})`
  }, [activeAccount, platformFilter, trackFilter, allTracks, syncTargets.length])

  const syncNow = async () => {
    if (!syncTargets.length) {
      toast(tr('当前筛选下没有可读取的账号'))
      return
    }
    const xHandles = syncTargets.filter(a => a.platform === 'X' && !a.monitorOnly && a.enabled !== false).map(a => a.handle)
    const mediaTargets = syncTargets
      .filter(a => a.platform === '小红书' || a.platform === '公众号' || (a.platform === 'X' && !a.avatar))
      .map(a => ({
        accountKey: a.accountKey,
        platform: a.platform,
        handle: a.handle,
        displayName: a.nativeName || a.displayName,
        userId: a.userId || '',
        username: a.username || '',
        sampleArticleUrl: a.sampleArticleUrl || '',
      }))
    const monTargets = syncTargets.filter(a => a.monitorAccountId && a.enabled !== false)

    setBusy(true)
    setAction('refresh')
    try {
      const tasks = []
      if (xHandles.length === 1) tasks.push(request('refresh', { handle: xHandles[0] }))
      else if (xHandles.length > 1) tasks.push(request('refresh', { handles: xHandles }))

      if (mediaTargets.length) {
        tasks.push(
          deskRequest('bench/sync-media', { targets: mediaTargets }).then(res => {
            if (mounted.current && res?.library) setLibrary(res.library)
          })
        )
      }
      for (const m of monTargets) {
        tasks.push(deskRequest('monitor/refresh', { accountId: m.monitorAccountId, purpose: 'posts', requestId: crypto.randomUUID() }).catch(() => {}))
      }
      await Promise.all(tasks)
      toast(xHandles.length ? tr('读取已开始') : tr('已同步所选对标账号'))
      await load()
    } catch (err) {
      report(err)
    } finally {
      if (mounted.current) { setBusy(false); setAction('') }
    }
  }

  const captureToWall = async post => {
    const title = (post.title || post.text?.split(/\r?\n/)[0] || '').slice(0, 48)
    const body = post.text || post.excerpt || ''
    await dispatchOps([{ op: 'add_item', kind: 'note', title, body, source: `${post.platform} · ${post.displayName || post.handle}` }], { label: tr('已记入灵感墙') })
    toast(tr('已记入灵感墙'))
  }

  const submitAddAccount = async event => {
    event.preventDefault()
    if (busy) return
    const plat = addForm.platform
    if (plat === 'X') {
      const clean = addForm.handle.trim().replace(/^@/, '')
      const ok = await run('account', { handle: clean })
      if (ok) {
        const key = `x-${clean.toLowerCase()}`
        await updatePref(key, { track: addForm.track, ...(addForm.displayName.trim() ? { customName: addForm.displayName.trim() } : {}) })
        if (addForm.avatarUrl.trim()) saveCustomAvatar(key, addForm.avatarUrl.trim())
        // 顺手同步一次该 X 账号的真实推特昵称和头像
        deskRequest('bench/sync-media', { targets: [{ accountKey: key, platform: 'X', handle: clean }] }).then(() => load()).catch(() => {})
        setAdding(false)
        setAddForm({ platform: 'X', track: 'ai', displayName: '', handle: '', homeUrl: '', avatarUrl: '' })
      }
      return
    }
    try {
      setBusy(true)
      const res = await deskRequest('monitor/account', {
        platform: plat,
        displayName: addForm.displayName.trim() || addForm.handle.trim(),
        handle: addForm.handle.trim(),
        homeUrl: addForm.homeUrl.trim(),
        enabled: true,
        allowPaid: false,
        collectFollowers: false,
      })
      if (res?.account) {
        const key = `mon-${res.account.accountId}`
        await updatePref(key, { track: addForm.track })
        if (addForm.avatarUrl.trim()) saveCustomAvatar(key, addForm.avatarUrl.trim())
        toast(tr('操作完成'))
        setAdding(false)
        await load()
      }
    } catch (err) {
      report(err)
    } finally {
      setBusy(false)
    }
  }

  const pageSize = platformFilter === '小红书' ? 24 : 40
  const lastPage = Math.max(0, Math.ceil(filteredPosts.length / pageSize) - 1)
  const currentPage = Math.min(page, lastPage)
  const pagedPosts = filteredPosts.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  const isXhsWaterfall = platformFilter === '小红书' || (activeAccount && activeAccount.platform === '小红书')

  return (
    <div className="md-board-page md-bench-v2">
      <div className="md-bento-shell">
        <header className="md-bento-card md-bench-topcard">
          {/* 第一层：平台切换 + 精准作用域同步按钮 */}
          <div className="md-bench-tier1">
            <div className="md-plat-tabs" role="tablist" aria-label={tr('平台')}>
              <button
                type="button"
                role="tab"
                aria-selected={platformFilter === 'all'}
                className={`md-plat-tab ${platformFilter === 'all' ? 'is-on' : ''}`}
                onClick={() => { setPlatformFilter('all'); setSelectedAccountKey('all') }}
              >
                <span>{tr('全部平台')}</span>
                <em>{allAccounts.length}</em>
              </button>
              {platforms.map(([plat, count]) => (
                <button
                  type="button"
                  role="tab"
                  key={plat}
                  aria-selected={platformFilter === plat}
                  className={`md-plat-tab ${platformFilter === plat ? 'is-on' : ''}`}
                  style={{ '--plat-c': platformColor(plat) }}
                  onClick={() => { setPlatformFilter(plat); setSelectedAccountKey('all') }}
                >
                  <PlatformLogo platform={plat} size={18} />
                  <span>{tr(plat)}</span>
                  <em>{count}</em>
                </button>
              ))}
            </div>

            <div className="md-bench-top-right">
              <span className={`md-status-lamp ${refresh.running || action === 'refresh' ? 'is-busy' : readStatus.warn || refresh.error ? 'is-warn' : 'is-ok'}`}>
                <i />
                {refresh.running
                  ? tr('读取中 {current}/{total} · @{handle}', { current: refresh.current || 0, total: refresh.total || 0, handle: refresh.handle || '—' })
                  : action === 'refresh' ? tr('正在读取…') : refresh.error ? `${refresh.error} · ${readStatus.label}` : readStatus.label}
              </span>
              <button type="button" className="md-btn is-small" disabled={busy} onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} />{tr('添加对标')}
              </button>
              {!snapshotOnly && <button type="button" className="md-btn is-small is-primary" disabled={busy || refresh.running} onClick={syncNow}>
                <Icon name="refresh" size={14} />{refresh.running || action === 'refresh' ? tr('正在读取…') : syncScopeLabel}
              </button>}
            </div>
          </div>

          {/* 第二层：平台 × 赛道交叉筛选（支持内置与用户自定义赛道标签） */}
          <div className="md-bench-tier2">
            <div className="md-track-bar" role="group" aria-label={tr('全部赛道')}>
              {allTracks.map(item => {
                const cnt = item.id === 'all'
                  ? accountsAfterPlatform.length
                  : item.id === 'starred'
                    ? accountsAfterPlatform.filter(a => a.starred).length
                    : accountsAfterPlatform.filter(a => a.track === item.id).length
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`md-track-pill ${trackFilter === item.id ? 'is-on' : ''}`}
                    onClick={() => { setTrackFilter(item.id); setSelectedAccountKey('all') }}
                  >
                    <Icon name={item.icon || 'spark'} size={13} fill={item.id === 'starred' && trackFilter === 'starred'} />
                    <span>{tr(item.label)}</span>
                    <small>{cnt}</small>
                  </button>
                )
              })}
            </div>
            <label className="md-bench-search">
              <Icon name="search" size={14} />
              <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder={tr('搜索对标内容或博主…')} />
            </label>
          </div>

          {/* 第三层：带真实头像、平台品牌标与微缩趋势线的账号选择卡片带 */}
          <div className="md-bench-tier3" role="listbox" aria-label={tr('账号')}>
            <button
              type="button"
              role="option"
              aria-selected={selectedAccountKey === 'all'}
              className={`md-acct-chip-card is-all ${selectedAccountKey === 'all' ? 'is-on' : ''}`}
              onClick={() => setSelectedAccountKey('all')}
            >
              <div className="md-acct-chip-all-icon"><Icon name="grid" size={18} /></div>
              <div className="md-acct-chip-info">
                <strong>{tr('全部当前账号')}</strong>
                <small>{visibleAccounts.length} {tr('个账号')} · {filteredPosts.length} {tr('条内容')}</small>
              </div>
            </button>

            {visibleAccounts.map(acc => {
              const active = selectedAccountKey === acc.accountKey
              const subMetric = acc.platform === 'X' && acc.baseline?.sufficient
                ? `${tr('日常均曝')} ${compactNum(acc.baseline.median)}`
                : `${acc.totalCount ?? acc.postCount ?? 0} ${tr('篇收录')}`
              return (
                <button
                  type="button"
                  role="option"
                  key={acc.accountKey}
                  aria-selected={active}
                  className={`md-acct-chip-card ${active ? 'is-on' : ''} ${acc.enabled === false ? 'is-paused' : ''}`}
                  style={{ '--plat-c': platformChartColor(acc.platform) }}
                  onClick={() => setSelectedAccountKey(active ? 'all' : acc.accountKey)}
                >
                  <AccountAvatar
                    name={acc.displayName}
                    handle={acc.handle}
                    platform={acc.platform}
                    src={acc.avatar || ''}
                    avatarKey={acc.accountKey}
                    size={38}
                  />
                  <div className="md-acct-chip-info">
                    <div className="md-acct-chip-name">
                      <strong>{acc.displayName}</strong>
                      {acc.starred ? <Icon name="star" size={11} fill /> : null}
                    </div>
                    <small>{acc.platform === 'X' && acc.displayName !== `@${acc.handle}` ? `@${acc.handle} · ` : ''}{subMetric}</small>
                  </div>
                  <div className="md-acct-chip-spark">
                    {acc.spark?.length > 1 ? <AreaSparkline values={acc.spark} platform={acc.platform} width={54} height={26} /> : <PlatformLogo platform={acc.platform} size={18} />}
                  </div>
                </button>
              )
            })}
          </div>
        </header>

        {action === 'save' ? <div className="md-bento-banner is-info"><span className="md-shimmer">{tr('正在读取全文…')}</span></div> : null}
        {action === 'estimate' ? <div className="md-bento-banner is-info"><span className="md-shimmer">{tr('正在估算原文费用…')}</span></div> : null}
        {actionError ? <div role="alert" className="md-bento-banner is-error"><span>{actionError}</span><button type="button" onClick={() => setActionError('')}>×</button></div> : null}
        {error ? <div role="alert" className="md-bento-banner is-error"><span>{error}</span><button type="button" className="md-btn is-small" onClick={() => load().catch(report)}>{tr('重试')}</button></div> : null}

        <div className="md-bench-filterbar">
          <Segmented
            label={tr('时间')}
            value={range}
            onChange={setRange}
            options={[
              { value: '3', label: tr('近 3 天') },
              { value: '7', label: tr('近 7 天') },
              { value: '30', label: tr('近 30 天') },
              { value: 'all', label: tr('不限时间') },
              { value: 'history', label: tr('历史清单') },
            ]}
          />
          {!snapshotOnly && (platformFilter === 'all' || platformFilter === 'X') ? (
            <>
              <select className="md-clean-select" aria-label={tr('状态')} value={status} onChange={e => setStatus(e.target.value)}>
                {[['all', '全部'], ['新', '新'], ['已存入', '已存入'], ['已忽略', '已忽略']].map(([val, lab]) => (
                  <option key={val} value={val}>{tr('状态')}: {tr(lab)}</option>
                ))}
              </select>
              <label className="md-viral-toggle">
                <input type="checkbox" checked={viral} onChange={e => setViral(e.target.checked)} />
                <Icon name="flame" size={13} />
                <span>{tr('只看相对爆款')}</span>
              </label>
            </>
          ) : null}
          <select className="md-clean-select" aria-label={tr('排序')} value={sort} onChange={e => setSort(e.target.value)}>
            {(snapshotOnly ? [['time','时间'],['likes','点赞'],['views','曝光']] : [['multiple', '倍数'], ['views', '曝光'], ['bookmarkRate', '收藏率'], ['time', '时间']]).map(([val, lab]) => (
              <option key={val} value={val}>{tr('排序')}: {tr(lab)}</option>
            ))}
          </select>
          <span className="md-grow" />
          <span className="md-filter-count">{tr('共 {total} 条，筛出 {filtered} 条', { total: allPosts.length, filtered: filteredPosts.length })}</span>
        </div>

        {chosen.length ? (
          <div className="md-bench-batchbar">
            <strong>{tr('已选 {n} 条', { n: chosen.length })}</strong>
            <button type="button" className="md-act-btn" disabled={busy || !canMerge} onClick={() => run('save', { ids: chosen.map(p => p.id) })}>{tr('合并存入')}</button>
            <button type="button" className="md-act-btn" onClick={() => setSelected(new Set())}>{tr('清除选择')}</button>
            {!sameAccount ? <span className="md-muted">{tr('只能合并同一账号的帖子')}</span> : null}
          </div>
        ) : null}

        <div className="md-bench-grid">
          <section className="md-bench-feed-col">
            {!data ? (
              <div className="md-bento-card md-empty-card"><span className="md-shimmer">{tr('加载中…')}</span></div>
            ) : !filteredPosts.length ? (
              <div className="md-bento-card md-empty-card">
                <Empty
                  title={allPosts.length ? tr('没有符合筛选的内容') : tr('还没有读取')}
                  action={!allPosts.length ? (
                    <div className="md-bench-actions">
                      <button type="button" className="md-btn is-primary" disabled={busy || refresh.running} onClick={syncNow}>{syncScopeLabel}</button>
                      <button type="button" className="md-btn" disabled={busy} onClick={() => run('import-history', {})}>{tr('导入历史清单')}</button>
                    </div>
                  ) : null}
                />
              </div>
            ) : (
              <div className={pagedPosts.every(p => p.publicSample) ? 'md-public-grid' : isXhsWaterfall ? 'md-xhs-waterfall' : 'md-feed-stack'}>
                {pagedPosts.map(post => {
                  const acc = accountByKey.get(post.accountKey)
                  if (post.publicSample) return <PublicWork key={post.id} post={post} account={acc} />
                  if (post.platform === 'X') {
                    return (
                      <XPostCard
                        key={post.id}
                        post={post}
                        account={acc}
                        selected={selected.has(post.id)}
                        busy={busy}
                        run={run}
                        onSelect={() => setSelected(prev => {
                          const next = new Set(prev)
                          if (next.has(post.id)) next.delete(post.id)
                          else next.add(post.id)
                          return next
                        })}
                      />
                    )
                  }
                  if (post.platform === '公众号') {
                    return <WechatArticleCard key={post.id} post={post} account={acc} onRead={setReadingPost} onCapture={captureToWall} />
                  }
                  if (post.platform === '小红书') {
                    return <XhsNoteCard key={post.id} post={post} account={acc} onRead={setReadingPost} onCapture={captureToWall} />
                  }
                  return <GenericPlatformCard key={post.id} post={post} account={acc} onRead={setReadingPost} onCapture={captureToWall} />
                })}
              </div>
            )}

            {filteredPosts.length > pageSize ? (
              <div className="md-bench-pager">
                <button type="button" className="md-btn is-small" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>{tr('上一页')}</button>
                <span>{tr('第 {page} / {total} 页', { page: currentPage + 1, total: lastPage + 1 })}</span>
                <button type="button" className="md-btn is-small" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>{tr('下一页')}</button>
              </div>
            ) : null}
          </section>

          <aside className="md-bento-card md-bench-sidecard">
            {activeAccount ? (
              <AccountSidebarDetail account={activeAccount} tracks={allTracks} busy={busy} run={run} onPrefChange={updatePref} />
            ) : (
              <div className="md-bench-leaderboard">
                <header className="md-bento-head">
                  <h2>{tr('对标矩阵排行')}</h2>
                  <button type="button" className="md-act-link" disabled={busy} onClick={() => run('import-history', {})}>{tr('导入历史清单')}</button>
                </header>
                <div className="md-leader-list">
                  {[...visibleAccounts].sort((a,b) => (b.totalCount || 0) - (a.totalCount || 0)).map(acc => {
                    const metricVal = acc.platform === 'X' && acc.baseline?.sufficient
                      ? compactNum(acc.baseline.median)
                      : `${acc.totalCount ?? acc.postCount ?? 0}`
                    const metricSub = acc.platform === 'X' && !acc.publicSample
                      ? (acc.baseline?.sufficient ? tr('日常均曝') : tr('样本不足'))
                      : tr('篇收录')
                    const verified = acc.effects?.verified || 0
                    return (
                      <button
                        type="button"
                        key={acc.accountKey}
                        className="md-leader-row"
                        onClick={() => setSelectedAccountKey(acc.accountKey)}
                      >
                        <AccountAvatar name={acc.displayName} handle={acc.handle} platform={acc.platform} src={acc.avatar || ''} avatarKey={acc.accountKey} size={36} />
                        <div className="md-leader-info">
                          <strong>{acc.displayName}</strong>
                          <small>
                            {acc.platform === 'X' ? `@${acc.handle}` : acc.platform}
                            {verified ? ` · ${tr('已验证短推')} ${verified}` : ''}
                          </small>
                        </div>
                        <div className="md-leader-metric">
                          <b>{metricVal}</b>
                          <span>{metricSub}</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>

      {adding ? (
        <Dialog title={tr('添加对标')} onClose={() => { if (!busy) setAdding(false) }} width={460}>
          <form className="md-form" onSubmit={submitAddAccount}>
            <div className="md-field-row">
              <label className="md-field">
                <span>{tr('平台')}</span>
                <select value={addForm.platform} onChange={e => setAddForm(f => ({ ...f, platform: e.target.value }))}>
                  {['X', '公众号', '小红书', '抖音', 'B站', '视频号', 'YouTube', '知乎'].map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label className="md-field">
                <span>{tr('所属赛道')}</span>
                <select value={addForm.track} onChange={e => setAddForm(f => ({ ...f, track: e.target.value }))}>
                  {allTracks.filter(item => item.id !== 'all' && item.id !== 'starred').map(item => (
                    <option key={item.id} value={item.id}>{tr(item.label)}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="md-field">
              <span>{tr('显示名称')}</span>
              <input value={addForm.displayName} onChange={e => setAddForm(f => ({ ...f, displayName: e.target.value }))} placeholder={addForm.platform === 'X' ? '留空自动读取推特原昵称' : '如：纸飞机编辑部'} required={addForm.platform !== 'X'} />
            </label>
            <label className="md-field">
              <span>{tr('账号 ID / Handle')}</span>
              <input
                required={addForm.platform === 'X' || !addForm.homeUrl.trim()}
                pattern={addForm.platform === 'X' ? '@?[A-Za-z0-9_]{1,15}' : undefined}
                value={addForm.handle}
                onChange={e => setAddForm(f => ({ ...f, handle: e.target.value }))}
                placeholder={addForm.platform === 'X' ? '@handle' : addForm.platform === '公众号' ? 'gh_xxx 或公众号 ID' : '小红书号或用户 ID'}
              />
              {addForm.platform === 'X' ? <small>{tr('请输入 X 账号名（如 example）')}</small> : null}
            </label>
            {addForm.platform !== 'X' ? (
              <label className="md-field">
                <span>{tr('主页链接')}</span>
                <input type="url" value={addForm.homeUrl} onChange={e => setAddForm(f => ({ ...f, homeUrl: e.target.value }))} placeholder="https://" />
              </label>
            ) : null}
            <label className="md-field">
              <span>{tr('自定义头像链接')}</span>
              <input value={addForm.avatarUrl} onChange={e => setAddForm(f => ({ ...f, avatarUrl: e.target.value }))} placeholder={tr('粘贴头像图片地址（可选）')} />
            </label>
            <div className="md-form-foot">
              <span style={{ flex: 1 }} />
              <button type="button" className="md-btn" disabled={busy} onClick={() => setAdding(false)}>{tr('取消')}</button>
              <button type="submit" className="md-btn is-primary" disabled={busy}>{tr('添加对标')}</button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {readingPost ? (
        <Dialog title={readingPost.title || readingPost.displayName} onClose={() => setReadingPost(null)} width={640}>
          <div className="md-reader-modal">
            <div className="md-reader-meta">
              <PlatformLogo platform={readingPost.platform} size={20} />
              <strong>{readingPost.displayName}</strong>
              {readingPost.publishedDay ? <span>· {readingPost.publishedDay}</span> : null}
              {readingPost.tags?.map(tag => <em key={tag}>#{tag}</em>)}
            </div>
            {readingPost.cover ? <img className="md-reader-cover" src={readingPost.cover} alt="" /> : null}
            <div className="md-reader-content">{readingPost.text}</div>
            <div className="md-form-foot">
              <button type="button" className="md-btn is-primary" onClick={() => { captureToWall(readingPost); setReadingPost(null) }}>
                <Icon name="plus" size={14} />{tr('记为灵感')}
              </button>
              {readingPost.url ? <a className="md-btn" href={readingPost.url} target="_blank" rel="noopener noreferrer">{readingPost.platform === '小红书' ? tr('小红书原文') : tr('微信原文')} ↗</a> : null}
              <span style={{ flex: 1 }} />
              <button type="button" className="md-btn" onClick={() => setReadingPost(null)}>{tr('收起')}</button>
            </div>
          </div>
        </Dialog>
      ) : null}

      {confirm ? (
        <Dialog title={tr('存入素材')} onClose={() => setConfirm(null)}>
          <p className="md-atom-note"><strong>{tr('本次读取原文约 {cost} 美元', { cost: dollars(confirm.estimate.costUSD) })}</strong></p>
          <p className="md-atom-note">{tr('原文由 Monid 直接读取并逐字保存。按实际调用结算，读取失败也可能产生费用。')}</p>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setConfirm(null)}>{tr('取消')}</button>
            <button type="button" className="md-btn is-primary" disabled={busy} onClick={() => { const pending = confirm; setConfirm(null); perform(pending.route, pending.body) }}>
              {tr('确认读取并存入')}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}
