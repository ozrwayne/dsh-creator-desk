import React from 'react'
import { request, setDesk } from './desk.js'
import styles from './monitor.css'

const DAY = 86400000
const METRICS = [['views', '阅读／播放'], ['impressions', '后台展示'], ['likes', '点赞'], ['comments', '评论'], ['saves', '收藏'], ['shares', '转发'], ['quotes', '引用'], ['stars', 'Star'], ['forks', 'Fork']]
const QUALITY = { exact: '精确', rounded: '约数', missing: '缺失', withheld: '未公开', unsupported: '不支持', invalid: '无效' }
const CHANNEL = { monid: 'Monid 公开来源', grok: 'Grok 公开来源', cdp: '已绑定后台', public: '公开页面', import: '导入记录' }
const PURPOSE = { posts: '作品', followers: '粉丝', migration: '历史迁入', 'x-direct': 'X 单帖', 'x-refresh': 'X 指标', 'csv-import': 'CSV 导入', profile: '账号资料' }
const STATUS = { ready: '到龄观测可用', not_due: '尚未到龄', publication_time_unknown: '发布时间精度不足', missing: '缺少到龄前观测', stale_at_age: '到龄前观测超过 6 小时', insufficient_baseline: '基线不足 8 篇', zero_baseline: '基线中位数为零', non_exact_current: '当前阅读值精度不足', content_kind_ineligible: '此内容类型不参与基线', unknown_content_kind: '内容类型未知', non_exact: '观测精度不足', non_exact_views: '阅读值精度不足', legacy: '旧记录不参与定龄', started: '结果待核', committed: '已提交', failed: '采集失败', uncertain: '结果待核', acknowledged: '已人工处理', alias: '复用已有观测' }
const finite = value => typeof value === 'number' && Number.isFinite(value)
const number = value => finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—'
const money = value => finite(value) ? `$${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '未登记'
const qualityLabel = value => QUALITY[value] || '未知精度'
const query = params => new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value != null)).toString()
const message = error => error?.message || '读取失败，请稍后重试'
const sourceLabel = source => `${CHANNEL[source?.channel] || source?.channel || '来源未登记'} · ${source?.collectorId || '采集器未知'} · ${source?.measurementSet || '口径未知'}${source?.legacy ? ' · 旧记录' : ''}`
const metricValue = (value, quality) => finite(value) && !['missing', 'withheld', 'unsupported', 'invalid'].includes(quality) ? value : null
const settingsOf = account => ({ revision: account.revision, enabled: Boolean(account.enabled), allowPaid: Boolean(account.allowPaid), collectFollowers: Boolean(account.collectFollowers), recentHours: account.schedule?.recentHours ?? 24, browserProfileRef: account.browserProfileRef || null })
const sameSettings = (a, b) => ['enabled', 'allowPaid', 'collectFollowers', 'recentHours', 'browserProfileRef'].every(key => a[key] === b[key])

function date(value, timeZone) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false, ...(timeZone ? { timeZone } : {}) })
}

function localDate(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}) }).formatToParts(new Date(value))
  const part = type => parts.find(row => row.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function rangeError(from, to) {
  const valid = day => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day
  if (!valid(from) || !valid(to)) return '请选择完整的起止日期。'
  if (from > to) return '结束日期须晚于或等于起始日期。'
  if (Date.parse(to) - Date.parse(from) > 365 * DAY) return '日期范围最多 366 天，请缩短范围。'
  return ''
}

function daysWithGaps(rows, from, to) {
  if (rangeError(from, to)) return []
  const byDay = new Map(rows.map(row => [row.day, row]))
  const days = []
  for (let at = Date.parse(from); at <= Date.parse(to); at += DAY) {
    const day = new Date(at).toISOString().slice(0, 10)
    days.push(byDay.get(day) || { day })
  }
  return days
}

// Each result belongs to its exact URL. Switching a panel or selector hides the old result
// immediately, including the interval before React cleans up its previous effect.
function useMonitorRead(path, { revision = '', pollMs = 0 } = {}) {
  const [retry, setRetry] = React.useState(0)
  const [state, setState] = React.useState({ path: null, data: null, error: '', loading: false, key: '' })
  const key = JSON.stringify([path, revision, retry])
  const current = React.useRef(key)
  current.current = key
  React.useEffect(() => {
    if (!path) return
    let live = true, timer
    const load = async () => {
      setState(old => ({ path, key, data: old.path === path ? old.data : null, error: '', loading: true }))
      try {
        const data = await request(path)
        if (live && current.current === key) setState({ path, key, data, error: '', loading: false })
      } catch (error) {
        if (live && current.current === key) setState(old => ({ path, key, data: old.path === path ? old.data : null, error: message(error), loading: false }))
      }
      if (live && current.current === key && pollMs) timer = setTimeout(load, pollMs)
    }
    load()
    return () => { live = false; clearTimeout(timer) }
  }, [path, key, pollMs])
  const reload = React.useCallback(() => setRetry(value => value + 1), [])
  const update = React.useCallback(updater => setState(old => old.path === path ? { ...old, data: updater(old.data) } : old), [path])
  if (!path) return { data: null, error: '', loading: false, reload, update }
  return { ...(state.path === path ? state : { data: null, error: '', loading: true }), loading: state.path !== path || state.key !== key || state.loading, reload, update }
}

// Loading another page never refreshes the catalog. A new committed run re-reads the
// already loaded page count, so status polling and settings saves cannot discard it.
function usePostPages(accountId, revision, enabled, selectedKey) {
  const [retry, setRetry] = React.useState(0)
  const [state, setState] = React.useState({ accountId: '', posts: [], total: null, nextCursor: null, pages: 0, loading: false, moreLoading: false, error: '', moreError: '' })
  const stateRef = React.useRef(state), current = React.useRef(''), moreLock = React.useRef(null), selectedRef = React.useRef(selectedKey)
  stateRef.current = state
  selectedRef.current = selectedKey
  const key = JSON.stringify([accountId, revision, retry, enabled])
  current.current = key
  React.useEffect(() => {
    if (!accountId || !enabled) return
    let live = true
    moreLock.current = null
    const previous = stateRef.current
    const wanted = previous.accountId === accountId ? Math.max(previous.pages, 1) : 1
    setState(old => ({ ...(old.accountId === accountId ? old : { accountId, posts: [], total: null, nextCursor: null, pages: 0 }), key, loading: true, moreLoading: false, error: '', moreError: '' }))
    const load = async () => {
      try {
        const posts = new Map(), cursors = new Set()
        let cursor = null, pages = 0, total = null
        do {
          const page = await request(`monitor/posts?${query({ accountId, cursor, limit: 50 })}`)
          if (!live || current.current !== key) return
          if (!Array.isArray(page.posts)) throw new Error('作品列表格式无法识别。')
          for (const row of page.posts) posts.set(row.postKey, row)
          if (page.nextCursor && cursors.has(page.nextCursor)) throw new Error('作品分页游标未前进，请重新读取列表。')
          if (page.nextCursor) cursors.add(page.nextCursor)
          cursor = page.nextCursor || null; total = page.total; pages += 1
        } while (cursor && (pages < wanted || (selectedRef.current && !posts.has(selectedRef.current))))
        setState({ accountId, key, posts: [...posts.values()], total, nextCursor: cursor, pages, loading: false, moreLoading: false, error: '', moreError: '' })
      } catch (error) {
        if (live && current.current === key) setState(old => ({ ...old, key, loading: false, error: message(error) }))
      }
    }
    load()
    return () => { live = false }
  }, [accountId, key, enabled])
  const loadMore = async () => {
    if (!enabled || !state.nextCursor || state.loading || state.key !== key || moreLock.current === key) return
    moreLock.current = key
    const cursor = state.nextCursor
    setState(old => ({ ...old, moreLoading: true, moreError: '' }))
    try {
      const page = await request(`monitor/posts?${query({ accountId, cursor, limit: 50 })}`)
      if (current.current !== key) return
      if (!Array.isArray(page.posts) || page.nextCursor === cursor) throw new Error('作品分页已变化，请重新读取列表。')
      setState(old => ({ ...old, posts: [...new Map([...old.posts, ...page.posts].map(row => [row.postKey, row])).values()], total: page.total, nextCursor: page.nextCursor || null, pages: old.pages + 1, moreLoading: false }))
    } catch (error) {
      if (current.current === key) setState(old => ({ ...old, moreLoading: false, moreError: message(error) }))
    } finally {
      if (moreLock.current === key) moreLock.current = null
    }
  }
  const visible = state.accountId === accountId ? state : { posts: [], total: null, nextCursor: null, loading: enabled, moreLoading: false, error: '', moreError: '' }
  return { ...visible, loading: enabled && (visible.loading || state.key !== key), loadMore, reload: () => setRetry(value => value + 1) }
}

function ReadNotice({ resource, label }) {
  if (resource.error) return <div className="md-monitor-error" role="alert"><span>{label}读取失败：{resource.error}{resource.data && ' 当前保留上次读取结果。'}</span><button type="button" className="md-pill" onClick={resource.reload} disabled={resource.loading}>重试读取</button></div>
  if (resource.loading) return <p className="md-monitor-note" role="status">{resource.data ? `正在更新${label}；当前显示上次读取结果。` : `正在读取${label}…`}</p>
  return null
}

function Point({ value, quality }) {
  const display = metricValue(value, quality)
  return <span title={qualityLabel(quality)}>{display != null && quality === 'rounded' ? '≈' : ''}{number(display)}</span>
}

function HistoryChart({ points, label }) {
  const values = points.filter(point => finite(point.value))
  if (!values.length) return <div className="md-monitor-empty">暂无{label}趋势数据</div>
  const width = 760, height = 210, padX = 34, padY = 26
  const first = Date.parse(points[0].day), last = Date.parse(points.at(-1).day)
  const nums = values.map(point => point.value), min = Math.min(...nums), max = Math.max(...nums)
  const x = point => first === last ? width / 2 : padX + (Date.parse(point.day) - first) / (last - first) * (width - 2 * padX)
  const y = point => min === max ? height / 2 : height - padY - (point.value - min) / (max - min) * (height - 2 * padY)
  const paths = []; let segment = []
  for (const point of points) {
    if (!finite(point.value) || (segment.length && (Date.parse(point.day) - Date.parse(segment.at(-1).day) !== DAY || point.family !== segment.at(-1).family))) {
      if (segment.length) paths.push(segment)
      segment = []
    }
    if (finite(point.value)) segment.push(point)
  }
  if (segment.length) paths.push(segment)
  return <figure className="md-monitor-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}观测走势；${values.length} 个数据点，范围 ${number(min)} 至 ${number(max)}；缺测日断线。明细见下方表格。`}>
      <line x1={padX} x2={width - padX} y1={height - padY} y2={height - padY} className="md-monitor-chart-axis" />
      {paths.map((path, index) => <polyline key={index} points={path.map(point => `${x(point)},${y(point)}`).join(' ')} className="md-monitor-chart-line" />)}
      {values.map((point, index) => <circle key={`${point.day}:${index}`} cx={x(point)} cy={y(point)} r="4" className={point.quality === 'rounded' ? 'md-monitor-chart-rounded' : 'md-monitor-chart-point'}><title>{point.day} · {point.quality === 'rounded' ? '约 ' : ''}{number(point.value)}</title></circle>)}
    </svg>
    <figcaption><span>{points[0].day}</span><span>{label} · {number(min)}—{number(max)} · 空心点为约数</span><span>{points.at(-1).day}</span></figcaption>
  </figure>
}

function AccountSettings({ account, publicCapabilities, onSave, onReload, busy }) {
  const [base, setBase] = React.useState(() => settingsOf(account))
  const [draft, setDraft] = React.useState(() => settingsOf(account))
  const [feedback, setFeedback] = React.useState('')
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const dirty = !sameSettings(draft, base)
  const stale = account.revision !== base.revision
  const profiles = account.browserProfiles || []
  const draftProfile = profiles.find(row => row.profileRef === draft.browserProfileRef)
  const followersAvailable = draft.browserProfileRef ? Boolean(draftProfile?.followers) : Boolean(publicCapabilities?.followers ?? (!account.browserProfileRef && account.capabilities?.followers))
  const invalidSource = Boolean(draft.browserProfileRef && !draftProfile)
  const invalidFollowers = draft.collectFollowers && !followersAvailable
  React.useEffect(() => {
    if (!dirty && account.revision !== base.revision) {
      const next = settingsOf(account)
      setBase(next); setDraft(next)
    }
  }, [account, base.revision, dirty])
  const reset = () => { const next = settingsOf(account); setBase(next); setDraft(next); setFeedback('') }
  const set = (field, value) => { setDraft(old => ({ ...old, [field]: value })); setFeedback('') }
  const submit = async event => {
    event.preventDefault()
    if (busy || stale || !dirty || invalidSource || invalidFollowers) return
    const result = await onSave({ accountId: account.accountId, ...draft, revision: base.revision })
    if (!mounted.current) return
    if (result?.account) {
      const next = settingsOf(result.account)
      setBase(next); setDraft(next); setFeedback('采集设置已保存。')
    } else if (result?.error) setFeedback(result.error)
  }
  return <details className="md-monitor-settings"><summary>账号采集设置{dirty ? ' · 未保存' : ''}</summary>
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <label><input type="checkbox" checked={draft.enabled} onChange={event => set('enabled', event.target.checked)} />启用账号监控</label>
        <label className="md-monitor-source">采集来源<select value={draft.browserProfileRef || ''} onChange={event => set('browserProfileRef', event.target.value || null)}><option value="">公共来源（Monid／Grok）</option>{invalidSource && <option value={draft.browserProfileRef} disabled>原后台绑定已不可用</option>}{profiles.map(profile => <option key={profile.profileRef} value={profile.profileRef}>{profile.label || profile.profileRef} · {profile.posts ? '作品' : '无作品采集'} / {profile.followers ? '粉丝' : '无粉丝采集'}</option>)}</select></label>
        {account.platform !== 'X' && <label><input type="checkbox" checked={draft.allowPaid} onChange={event => set('allowPaid', event.target.checked)} />授权现有 Monid 月预算内的付费采集</label>}
        <label><input type="checkbox" checked={draft.collectFollowers} disabled={!followersAvailable && !draft.collectFollowers} onChange={event => set('collectFollowers', event.target.checked)} />每日粉丝观测{!followersAvailable && '（所选来源未支持）'}</label>
        <label>发布后前 7 天采样间隔<select value={draft.recentHours} onChange={event => set('recentHours', Number(event.target.value))}><option value={24}>24 小时</option><option value={6}>6 小时（增加请求次数）</option></select></label>
      </fieldset>
      {profiles.length === 0 && <p className="md-monitor-note">当前账号没有可选后台绑定。后台来源需先在本地 monitor/browser-bindings.json 配置并通过账号身份校验；此处不接受任意地址或登录信息。</p>}
      {draft.browserProfileRef ? <p className="md-monitor-note">已绑定只读后台，不使用 Monid；会话失效或身份不符时停止，不自动改用付费来源。保存设置不会立即采集。</p> : <p className="md-monitor-note">公共作品请求预记：{account.browserProfileRef ? '切换并保存后读取费用' : account.platform === 'X' ? '沿用现有 Grok，用量单独记账' : money(account.estimate?.postsUsd)}；粉丝请求预记：{!followersAvailable ? '当前不可用' : account.browserProfileRef ? '切换并保存后读取费用' : money(account.estimate?.followersUsd)}。Monid 运行前核价；超价、未知价格或超预算均停止。保存设置不会立即采集。</p>}
      {invalidSource && <p className="md-monitor-error" role="alert">原后台绑定已不可用，请选择公共来源或另一个已绑定后台后保存。</p>}
      {invalidFollowers && <p className="md-monitor-note">所选来源尚未支持粉丝观测，请关闭粉丝选项后保存。</p>}
      {draft.collectFollowers && !draft.browserProfileRef && account.platform !== 'X' && !draft.allowPaid && <p className="md-monitor-note">粉丝任务仍需付费采集授权；未授权期间不发请求。</p>}
      {stale && dirty && <div className="md-monitor-error" role="alert"><span>服务器设置已更新。当前草稿已保留；请载入最新设置后重新编辑。</span><button type="button" className="md-pill" onClick={reset} disabled={busy}>载入最新设置</button></div>}
      {feedback && <p className="md-monitor-note" role="status">{feedback}</p>}
      <div className="md-monitor-actions">
        <button className="md-pill" disabled={busy || stale || !dirty || invalidSource || invalidFollowers}>保存采集设置</button>
        {dirty && <button type="button" className="md-pill" disabled={busy} onClick={reset}>放弃草稿</button>}
        <button type="button" className="md-pill" disabled={busy} onClick={onReload}>读取最新设置</button>
        {account.sourceRef?.kind === 'own' && <button type="button" className="md-pill" onClick={() => setDesk({ ownOpen: account.accountId })}>自有账号资料</button>}
      </div>
    </form>
  </details>
}

function AddAccount({ platforms, onSave, busy, onClose }) {
  const available = platforms.filter(row => row.posts)
  const [platform, setPlatform] = React.useState(() => available.find(row => row.platform === 'X')?.platform || available[0]?.platform || '')
  const [displayName, setName] = React.useState(''), [handle, setHandle] = React.useState(''), [homeUrl, setUrl] = React.useState('')
  const [enabled, setEnabled] = React.useState(false), [paid, setPaid] = React.useState(false), [followers, setFollowers] = React.useState(false), [error, setError] = React.useState('')
  const capability = available.find(row => row.platform === platform)
  const submit = async event => {
    event.preventDefault()
    if (busy) return
    if (!capability || !displayName.trim() || (!handle.trim() && !homeUrl.trim())) { setError('请填写名称，并提供平台 ID 或完整账号主页。'); return }
    setError('')
    const result = await onSave({ platform, displayName: displayName.trim(), handle: handle.trim(), homeUrl: homeUrl.trim(), enabled, allowPaid: platform !== 'X' && paid, collectFollowers: followers })
    if (result?.error) setError(result.error)
  }
  return <form className="md-monitor-add" onSubmit={submit}>
    <h3>新增对标账号</h3>
    <fieldset disabled={busy || !available.length}>
      <label>平台<select value={platform} onChange={event => { setPlatform(event.target.value); setHandle(''); setUrl(''); setPaid(false); setFollowers(false); setError('') }}>{!available.length && <option value="">暂无可用采集平台</option>}{platforms.map(row => <option key={row.platform} value={row.platform} disabled={!row.posts}>{row.platform}{row.posts ? '' : ' · 作品采集未验证'}</option>)}</select></label>
      <label>名称<input required value={displayName} maxLength={60} onChange={event => setName(event.target.value)} /></label>
      <label>平台 ID<input value={handle} maxLength={120} autoComplete="off" onChange={event => setHandle(event.target.value)} /></label>
      <label>账号主页<input type="url" value={homeUrl} maxLength={600} autoComplete="off" onChange={event => setUrl(event.target.value)} /></label>
      <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用监控与每日采集</label>
      {platform !== 'X' && <label><input type="checkbox" checked={paid} onChange={event => setPaid(event.target.checked)} />授权现有 Monid 月预算内的付费采集</label>}
      <label><input type="checkbox" checked={followers} disabled={!capability?.followers} onChange={event => setFollowers(event.target.checked)} />每日粉丝观测{!capability?.followers && '（当前来源未支持）'}</label>
    </fieldset>
    <p className="md-monitor-note">平台 ID 与主页至少填写一项。小红书、抖音需含内部 ID 的完整主页；X 填用户名，公众号填 gh_ 开头的 ID。服务端校验身份后保存；相同身份合并观测。已存在账号会增加对标角色，沿用原采集设置。</p>
    <p className="md-monitor-note">新账号默认停用，粉丝采集默认关闭。X 沿用现有 Grok，用量单独记账；其他已支持平台沿用共享 Monid 月预算。{capability?.reason}</p>
    {error && <p className="md-monitor-error" role="alert">{error}</p>}
    <div className="md-monitor-actions"><button className="md-pill" disabled={busy || !capability}>添加账号</button><button type="button" className="md-pill" disabled={busy} onClick={onClose}>取消</button></div>
  </form>
}

function collectionBlock(account, purpose, status, busy, acknowledgeUnknown = false) {
  if (busy) return '已有操作正在处理'
  if (!account) return '账号已不可用'
  if (!account.enabled) return '账号监控已关闭'
  if (!account.capabilities?.[purpose]) return '当前来源没有经过验证的采集能力'
  if (account.browserProfileRef && !account.browserProfiles?.some(row => row.profileRef === account.browserProfileRef)) return '后台绑定已不可用，请重新选择来源'
  if (!account.browserProfileRef && !account.identity?.value) return '账号身份待补齐'
  if (!account.browserProfileRef && account.platform !== 'X' && !account.allowPaid) return '尚未授权现有月预算内的付费采集'
  if (purpose === 'followers' && !account.collectFollowers) return '尚未启用每日粉丝观测'
  if (status?.startupError) return '索引或锁等待恢复，请查看采集状态'
  if (status?.running?.some(row => row.accountId === account.accountId && row.purpose === purpose)) return '该采集任务正在运行'
  if (!acknowledgeUnknown && status?.uncertain?.some(row => row.accountId === account.accountId && row.purpose === purpose)) return '上次请求结果待核，请在采集状态中处理'
  return ''
}

function CollectionActions({ account, status, busy, onCollect, onStatus }) {
  const postsBlock = collectionBlock(account, 'posts', status, busy)
  const followersBlock = collectionBlock(account, 'followers', status, busy)
  return <div className="md-monitor-collection">
    <div className="md-monitor-actions"><button type="button" className="md-pill" disabled={Boolean(postsBlock)} title={postsBlock || undefined} onClick={() => onCollect(account, 'posts')}>同步作品</button><button type="button" className="md-pill" disabled={Boolean(followersBlock)} title={followersBlock || undefined} onClick={() => onCollect(account, 'followers')}>同步粉丝</button><button type="button" className="md-pill" onClick={onStatus}>运行与额度</button></div>
  </div>
}

const followerFamily = row => JSON.stringify([row.collectorId, row.measurementSet || '', row.metricKind || 'followers', row.timeZone || ''])

function FollowersView({ account, resource, from, to }) {
  const [selected, setSelected] = React.useState('')
  const data = resource.data
  const rows = data?.daily || []
  const sources = [...new Map([...rows].sort((a, b) => String(b.observedAt || '').localeCompare(String(a.observedAt || ''))).map(row => [followerFamily(row), row])).entries()]
  const active = sources.some(([key]) => key === selected) ? selected : sources[0]?.[0] || ''
  const daily = daysWithGaps(rows.filter(row => followerFamily(row) === active), from, to)
  const identityMismatch = data && data.accountId !== account.accountId
  const observed = daily.some(row => finite(row.total))
  return <>
    <ReadNotice resource={resource} label="粉丝走势" />
    {identityMismatch ? <p className="md-monitor-error" role="alert">粉丝数据与当前账号不一致，已停止展示。请重试读取。</p> : data && <>
      {sources.length > 0 && <label className="md-monitor-source">粉丝来源<select value={active} onChange={event => setSelected(event.target.value)}>{sources.map(([key, row]) => <option key={key} value={key}>{row.collectorId || '采集器未知'} · {row.metricKind === 'subscribers' ? '订阅数' : '粉丝数'} · {row.timeZone || '时区未登记'}</option>)}</select></label>}
      <HistoryChart label="粉丝／订阅" points={daily.map(row => ({ day: row.day, value: metricValue(row.total, row.quality), quality: row.quality, family: active }))} />
      {observed && <div className="md-monitor-scroll" role="region" aria-label="粉丝每日明细" tabIndex={0}><table><thead><tr><th scope="col">日期</th><th scope="col">总数</th><th scope="col">日增减</th><th scope="col">更新时间</th></tr></thead><tbody>{daily.filter(row => row.observedAt).map(row => <tr key={row.day}><th scope="row">{row.day}</th><td><Point value={row.total} quality={row.quality} /></td><td>{number(row.change)}</td><td>{date(row.observedAt, account.timeZone)}</td></tr>)}</tbody></table></div>}
    </>}
  </>
}

function SampleEvidence({ samples, metric, timeZone }) {
  const [limit, setLimit] = React.useState(50)
  const ordered = React.useMemo(() => [...samples].sort((a, b) => String(b.observedAt || '').localeCompare(String(a.observedAt || '')) || String(a.sampleKey).localeCompare(String(b.sampleKey))), [samples])
  return <details className="md-monitor-evidence"><summary>实际样本证据 · {number(ordered.length)} 条</summary>
    {!ordered.length ? <p className="md-monitor-note">当前日期范围没有实际样本。</p> : <>
      <div className="md-monitor-scroll" role="region" aria-label="实际样本证据" tabIndex={0}><table><caption>所选来源与日期范围的原始观测</caption><thead><tr><th scope="col">实际观测</th><th scope="col">指标值</th><th scope="col">质量</th><th scope="col">来源字段</th><th scope="col">记录依据</th></tr></thead><tbody>{ordered.slice(0, limit).map((sample, index) => <tr key={sample.sampleKey || index}><td>{date(sample.observedAt, timeZone)}</td><td><Point value={sample.values?.[metric]} quality={sample.quality?.[metric]} /></td><td>{qualityLabel(sample.quality?.[metric])}{sample.legacy ? ' · 旧记录' : ''}</td><td className="md-monitor-wrap">{sample.sourceFields?.[metric] || '未登记'}</td><td><details><summary>样本与运行依据</summary><pre>{JSON.stringify(sample, null, 2)}</pre></details></td></tr>)}</tbody></table></div>
      {ordered.length > limit && <button type="button" className="md-pill" onClick={() => setLimit(value => value + 50)}>更多样本（已显示 {limit} / {ordered.length}）</button>}
    </>}
  </details>
}

function PostSeries({ account, post, source, resource, from, to }) {
  const [metric, setMetric] = React.useState(() => METRICS.find(([key]) => finite(source.values?.[key]))?.[0] || (account.platform === 'GitHub' ? 'stars' : 'views'))
  const label = METRICS.find(([key]) => key === metric)?.[1]
  const data = resource.data
  const mismatch = data && (data.post?.postKey !== post.postKey || data.post?.accountId !== account.accountId || (data.samples || []).some(row => row.seriesKey !== source.seriesKey || row.accountId !== account.accountId) || (data.daily || []).some(row => row.seriesKey !== source.seriesKey || row.accountId !== account.accountId))
  const daily = data && !mismatch ? daysWithGaps(data.daily || [], from, to) : []
  return <>
    <ReadNotice resource={resource} label="作品走势" />
    {mismatch ? <p className="md-monitor-error" role="alert">数据与当前账号或来源不一致，已停止展示。请重试读取。</p> : data && <>
      <label className="md-monitor-metric">指标<select value={metric} onChange={event => setMetric(event.target.value)}>{METRICS.map(([key, title]) => <option key={key} value={key}>{title}{source.quality?.[key] === 'unsupported' ? ' · 当前来源不支持' : ''}</option>)}</select></label>
      <HistoryChart label={label} points={daily.map(row => ({ day: row.day, value: metricValue(row.values?.[metric], row.quality?.[metric]), quality: row.quality?.[metric], family: source.seriesKey }))} />
      <div className="md-monitor-scroll" role="region" aria-label="作品每日明细" tabIndex={0}><table><caption>{label}每日明细 · — 为缺值</caption><thead><tr><th scope="col">日期</th><th scope="col">累计观测</th><th scope="col">相邻日增量</th><th scope="col">质量</th><th scope="col">实际观测</th></tr></thead><tbody>{daily.map(row => <tr key={row.day}><th scope="row">{row.day}{row.closed === false ? ' · 未封账' : ''}</th><td><Point value={row.values?.[metric]} quality={row.quality?.[metric]} /></td><td>{number(row.deltaValues?.[metric])}{finite(row.deltaValues?.[metric]) && row.deltaValues[metric] < 0 && <span className="md-monitor-cell-note">平台修正／口径变化待核</span>}</td><td>{row.observedAt ? qualityLabel(row.quality?.[metric]) : '缺测'}</td><td>{date(row.observedAt, account.timeZone)}</td></tr>)}</tbody></table></div>
      <p className="md-monitor-note">每日取同源最后一次观测，实际观测时间单列。相邻日且两侧为精确值时计算增量；累计值不相加。X 公开阅读与 CSV 后台展示分开记录。</p>
      <SampleEvidence key={`${source.seriesKey}:${from}:${to}`} samples={data.samples || []} metric={metric} timeZone={account.timeZone} />
    </>}
  </>
}

function CohortView({ account, post, source, resource, age }) {
  const data = resource.data
  const mismatch = data && (data.accountId !== account.accountId || data.postKey !== post.postKey || data.seriesKey !== source.seriesKey || data.ageDays !== age)
  const baseline = data?.baseline || {}, relative = data?.relative || {}, selected = data?.selected
  const typeKnown = Boolean(post.contentKind && !['unknown', 'reply', 'repost'].includes(post.contentKind))
  const multiple = typeKnown && data?.status === 'ready' && baseline.sufficient ? relative.multiple : null
  const reason = STATUS[relative.multipleReason] || (!typeKnown ? '此内容类型不参与基线' : data?.status !== 'ready' ? STATUS[data?.status] : null) || (baseline.sufficient === false ? '基线不足 8 篇' : '当前口径不可计算')
  return <>
    <ReadNotice resource={resource} label={`D${age} 同龄对照`} />
    <p className="md-monitor-policy">对照范围：当前账号、同类型、同来源、同龄期。跨账号、跨平台及跨口径排名均已禁用。</p>
    {mismatch ? <p className="md-monitor-error" role="alert">对照结果与当前账号、来源或龄期不一致，已停止展示。请重试读取。</p> : data && <div className="md-monitor-cohort">
      <div className="md-monitor-heading"><h3>D{age} 同龄观测</h3><span className="md-monitor-badge">{STATUS[data.status] || data.status || '状态未知'}</span></div>
      {data.status === 'not_due' && <p className="md-monitor-note">目标时刻尚未到达。届时根据真实观测计算；当前不展示预估成绩。</p>}
      {data.status === 'stale_at_age' && <p className="md-monitor-note">下面列出最近的到龄前证据，其时间间隔已超限，无法作为 D{age} 成绩。</p>}
      {source.legacy && <p className="md-monitor-note">旧记录可查看历史走势；其时刻或精度不满足严格定龄要求。</p>}
      <dl><dt>目标时刻</dt><dd>{date(data.targetAt, account.timeZone)}</dd><dt>采用观测</dt><dd>{date(selected?.observedAt, account.timeZone)}</dd><dt>距目标</dt><dd>{finite(selected?.lagSeconds) ? `${number(selected.lagSeconds / 3600)} 小时` : '—'}</dd><dt>当前阅读／播放</dt><dd>{data.status === 'ready' ? <Point value={selected?.values?.views} quality={selected?.quality?.views} /> : '—'}</dd><dt>基线样本</dt><dd>{number(baseline.samples)} / 至少 {number(baseline.minimumSamples)} 篇</dd><dt>基线中位数</dt><dd>{typeKnown ? number(baseline.median) : '—'}</dd><dt>相对自身基线</dt><dd>{finite(multiple) ? `${number(multiple)} 倍` : reason}</dd><dt>收藏／阅读</dt><dd>{data.status === 'ready' && finite(relative.saveRate) ? `${number(relative.saveRate * 100)}%` : '—'}</dd><dt>基线窗口</dt><dd>{date(baseline.windowStart, account.timeZone)} 至 {date(baseline.windowEndExclusive, account.timeZone)}（不含终点）</dd><dt>覆盖范围</dt><dd>{baseline.coverage === 'complete' ? '完整覆盖（来源声明）' : '仅已观测作品'}</dd></dl>
      <p className="md-monitor-note">基线取当前作品发布前 30 天的同账号、同类型、同来源作品；至少 8 篇。D1／D3／D7 分别为发布后满 24／72／168 小时，只采用目标时刻之前 6 小时内的观测。旧记录、未来样本与约数不参与。</p>
      {!relative.comparisonEligible && <p className="md-monitor-note">当前证据不足以形成完整覆盖的对照。已观测样本的结果保留覆盖限制。</p>}
      <details className="md-monitor-evidence"><summary>基线成员与排除原因</summary>
        {baseline.members?.length ? <div className="md-monitor-scroll" role="region" aria-label="基线成员" tabIndex={0}><table><caption>当前账号的基线成员</caption><thead><tr><th scope="col">作品 ID</th><th scope="col">阅读／播放</th><th scope="col">实际观测</th><th scope="col">样本键</th></tr></thead><tbody>{baseline.members.map(member => <tr key={member.postKey}><td>{member.postId}</td><td>{number(member.views)}</td><td>{date(member.observedAt, account.timeZone)}</td><td className="md-monitor-wrap">{member.sampleKey || '未登记'}</td></tr>)}</tbody></table></div> : <p className="md-monitor-note">暂无合格基线成员。</p>}
        <p className="md-monitor-note">缺测或过期：{number(baseline.excludedCounts?.missingOrStale)}；非精确值：{number(baseline.excludedCounts?.nonExact)}。</p>
        <details><summary>完整计算依据</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>
      </details>
    </div>}
  </>
}

function AccountWorkspace({ account, publicCapabilities, panel, from, to, invalidRange, revision, status, busy, onSave, onReloadAccounts, onCollect, onStatus }) {
  const [postKey, setPostKey] = React.useState(''), [seriesKey, setSeriesKey] = React.useState(''), [age, setAge] = React.useState(3)
  const dataRevision = JSON.stringify([revision, account.revision, account.postCount, account.lastRun?.runKey, account.lastRun?.status, account.latestFollowers?.followerKey])
  const postsPanel = panel === 'posts' || panel === 'cohort'
  const pages = usePostPages(account.accountId, dataRevision, postsPanel, postKey)
  const post = pages.posts.find(row => row.postKey === postKey) || pages.posts[0]
  const sources = [...(post?.series || [])].sort((a, b) => Number(Boolean(a.legacy)) - Number(Boolean(b.legacy)) || String(b.observedAt || '').localeCompare(String(a.observedAt || '')) || a.seriesKey.localeCompare(b.seriesKey))
  const source = sources.find(row => row.seriesKey === seriesKey) || sources[0]
  const params = { postKey: post?.postKey, seriesKey: source?.seriesKey, from, to }
  const series = useMonitorRead(panel === 'posts' && post && source && !invalidRange ? `monitor/series?${query(params)}` : null, { revision: dataRevision })
  const comparison = useMonitorRead(panel === 'cohort' && post && source ? `monitor/cohort?${query({ postKey: post.postKey, seriesKey: source.seriesKey, ageDays: age })}` : null, { revision: dataRevision })
  const followers = useMonitorRead(panel === 'account' && !invalidRange ? `monitor/followers?${query({ accountId: account.accountId, from, to })}` : null, { revision: dataRevision })
  if (panel === 'status') return null
  return <div className="md-monitor-workspace">
    {account.lastRun?.error && <div className="md-monitor-error" role="alert"><span>最近一次{PURPOSE[account.lastRun.purpose] || '采集'}失败：{account.lastRun.error}。已有观测保留；最近一次运行时间：{date(account.lastRun.at, account.timeZone)}。</span><button type="button" className="md-pill" onClick={onStatus}>查看运行证据</button></div>}
    {panel === 'account' && <>
      <div className="md-monitor-heading"><h3>{account.displayName}</h3><span>{account.platform} · {number(account.postCount)} 篇作品 · {account.enabled ? '自动同步中' : '已暂停'}</span></div>
      {!invalidRange && <FollowersView account={account} resource={followers} from={from} to={to} />}
      <CollectionActions account={account} status={status} busy={busy} onCollect={onCollect} onStatus={onStatus} />
      <AccountSettings account={account} publicCapabilities={publicCapabilities} onSave={onSave} onReload={onReloadAccounts} busy={busy} />
    </>}
    {postsPanel && <>
      <ReadNotice resource={{ ...pages, data: pages.posts.length ? pages.posts : null }} label="作品列表" />
      <div className="md-monitor-filters">
        <label className="md-monitor-account">作品<select value={post?.postKey || ''} disabled={!pages.posts.length} onChange={event => { setPostKey(event.target.value); setSeriesKey('') }}>{!pages.posts.length && <option value="">{pages.loading ? '读取中' : '暂无作品'}</option>}{pages.posts.map(row => <option key={row.postKey} value={row.postKey}>{row.title || row.postId}{row.publishedDay ? ` · ${row.publishedDay}` : ''}</option>)}</select></label>
        <label className="md-monitor-source">来源<select value={source?.seriesKey || ''} disabled={!sources.length} onChange={event => setSeriesKey(event.target.value)}>{!sources.length && <option value="">暂无观测来源</option>}{sources.map(row => <option key={row.seriesKey} value={row.seriesKey}>{sourceLabel(row)}</option>)}</select></label>
      </div>
      <div className="md-monitor-actions"><span className="md-monitor-note">已载入 {number(pages.posts.length)} / {number(pages.total)} 篇</span>{pages.nextCursor && <button type="button" className="md-pill" disabled={pages.loading || pages.moreLoading} onClick={pages.loadMore}>{pages.moreLoading ? '正在读取更多作品…' : '更多作品'}</button>}<button type="button" className="md-pill" disabled={pages.loading || pages.moreLoading} onClick={pages.reload}>重新读取作品列表</button></div>
      {pages.moreError && <div className="md-monitor-error" role="alert"><span>更多作品读取失败：{pages.moreError}。已载入的作品保留。</span><button type="button" className="md-pill" onClick={pages.reload} disabled={pages.loading}>重载已载入分页</button></div>}
      {!post && !pages.loading && !pages.error && <p className="md-monitor-empty">此账号尚无作品观测。采集成功后显示；作品无需关联本地稿件。</p>}
      {post && <>
        <p className="md-monitor-note">{post.publishedPrecision === 'second' ? `发布：${date(post.publishedAt, account.timeZone)}` : `发布时间：${post.publishedDay || '未知'}（精度不足）`} · 类型：{post.contentKind === 'unknown' || !post.contentKind ? '未知' : post.contentKind}{/^https?:\/\//i.test(post.url || '') && <> · <a href={post.url} target="_blank" rel="noopener noreferrer">原作品</a></>}</p>
        {source ? <>
          <p className="md-monitor-source-note">{sourceLabel(source)} · 最新实际观测：{date(source.observedAt, account.timeZone)}</p>
          {panel === 'posts' && !invalidRange && <PostSeries key={`${post.postKey}:${source.seriesKey}`} account={account} post={post} source={source} resource={series} from={from} to={to} />}
          {panel === 'cohort' && <>
            <div className="md-monitor-tabs" role="group" aria-label="发布龄期">{[1, 3, 7].map(value => <button key={value} type="button" aria-pressed={age === value} onClick={() => setAge(value)}>D{value} · {value * 24} 小时</button>)}</div>
            <CohortView account={account} post={post} source={source} resource={comparison} age={age} />
          </>}
        </> : <p className="md-monitor-empty">作品已登记，但没有可用的观测来源。当前不绘图或计算定龄。</p>}
      </>}
      {!pages.loading && <CollectionActions account={account} status={status} busy={busy} onCollect={onCollect} onStatus={onStatus} />}
    </>}
  </div>
}

function UnknownRun({ run, account, status, busy, onCollect }) {
  const [acknowledged, setAcknowledged] = React.useState(false)
  const supported = ['posts', 'followers'].includes(run.purpose)
  const block = supported ? collectionBlock(account, run.purpose, status, busy, true) : '此类请求需核对原入口，不提供自动重试'
  return <div className="md-monitor-recovery">
    <p>{account?.displayName || run.accountId || '未关联账号'} · {PURPOSE[run.purpose] || run.purpose || '任务未知'} · {date(run.at, account?.timeZone)}</p>
    <p className="md-monitor-note">上次请求可能已经收费。请先核对运行记录与账单；恢复索引不会重新采集。</p>
    <label><input type="checkbox" checked={acknowledged} disabled={busy || Boolean(block)} onChange={event => setAcknowledged(event.target.checked)} />已了解可能重复收费，仍要重新采集</label>
    <button type="button" className="md-pill" disabled={!acknowledged || Boolean(block)} onClick={async () => { setAcknowledged(false); await onCollect(account, run.purpose, true) }}>确认重试{PURPOSE[run.purpose] || ''}</button>
    {block && <p className="md-monitor-note">{block}。</p>}
  </div>
}

function StatusPanel({ resource, accounts, platforms, activeId, busy, onRecover, onCollect }) {
  const status = resource.data
  const [onlyCurrent, setOnlyCurrent] = React.useState(false), [showAll, setShowAll] = React.useState(false)
  const filterCurrent = onlyCurrent && Boolean(activeId)
  const runs = (status?.runs || []).filter(run => !filterCurrent || run.accountId === activeId)
  const running = status?.running || []
  const unresolved = (status?.uncertain || []).filter(run => !running.some(row => row.accountId === run.accountId && row.purpose === run.purpose) && (!filterCurrent || run.accountId === activeId))
  const currentAccount = id => accounts.find(row => row.accountId === id)
  const nameOf = run => currentAccount(run.accountId)?.displayName || run.accountId || (run.purpose === 'migration' ? '历史迁入' : '未关联账号')
  return <div className="md-monitor-workspace">
    <ReadNotice resource={resource} label="采集状态" />
    <div className="md-monitor-heading"><h3>采集状态与预算</h3><button type="button" className="md-pill" disabled={resource.loading} onClick={resource.reload}>刷新状态</button></div>
    {status ? <>
      <div className="md-monitor-stats"><div><span>已观测作品</span><strong>{number(status.postCount)}</strong></div><div><span>实际样本</span><strong>{number(status.sampleCount)}</strong></div><div><span>Monid 本月预记／支出</span><strong>{money(status.budget?.spentThisMonth)}</strong></div><div><span>共享月上限</span><strong>{money(status.budget?.cap)}</strong></div></div>
      <p className="md-monitor-note">账期：{status.budget?.spentMonth || '未登记'}。Monid 沿用工作台共享预算；超时预记可能保留。Grok 用量单独记账。此处不调整月上限。</p>
      {finite(status.budget?.spentThisMonth) && finite(status.budget?.cap) && status.budget.spentThisMonth >= status.budget.cap && <p className="md-monitor-error" role="status">共享 Monid 预算已达上限，新付费请求将被拒绝。已有历史仍可读取。</p>}
      <p className="md-monitor-note">历史迁入：{status.migration?.complete ? `已完成 · ${number(status.migration.samples)} 条样本 · ${number(status.migration.skipped)} 条跳过` : '尚未完成'}。身份或时刻不足的记录保留在原文件；失败不清除已有观测。</p>
      {running.length > 0 && <p className="md-monitor-note" role="status">正在运行：{running.map(row => `${nameOf(row)} · ${PURPOSE[row.purpose] || row.purpose}`).join('；')}。请勿重复提交。</p>}
      {status.startupError && <div className="md-monitor-error" role="alert"><span>{status.startupError}</span></div>}
      <div className="md-monitor-actions"><button type="button" className="md-pill" disabled={busy || running.length > 0} onClick={onRecover}>恢复索引／遗留锁</button><span className="md-monitor-note">从已提交事件重建；不发起外部采集，不重试待核请求。</span></div>
      <label><input type="checkbox" checked={filterCurrent} disabled={!activeId} onChange={event => setOnlyCurrent(event.target.checked)} />仅当前账号的运行记录与待核请求</label>
      {unresolved.length > 0 && <section className="md-monitor-uncertain" aria-label="待核请求"><h3>待核请求</h3><p className="md-monitor-note">存在结果未知的采集。自动任务会保守暂停；每项重试均需单独确认费用风险。</p>{unresolved.map(run => <UnknownRun key={`${run.runKey}:${run.accountId}`} run={run} account={currentAccount(run.accountId)} status={status} busy={busy} onCollect={onCollect} />)}</section>}
      {runs.length ? <div className="md-monitor-scroll" role="region" aria-label="采集运行记录" tabIndex={0}><table><caption>最近运行记录 · 服务端最多返回 100 条</caption><thead><tr><th scope="col">时间</th><th scope="col">账号</th><th scope="col">任务</th><th scope="col">结果</th><th scope="col">说明与证据</th></tr></thead><tbody>{runs.slice(0, showAll ? runs.length : 20).map(run => <tr key={run.runKey}><td>{date(run.at, currentAccount(run.accountId)?.timeZone)}</td><td className="md-monitor-wrap">{nameOf(run)}</td><td>{PURPOSE[run.purpose] || run.purpose || '未登记'}</td><td>{run.status === 'started' && running.some(row => row.accountId === run.accountId && row.purpose === run.purpose) ? '运行中' : STATUS[run.status] || run.status || '未知'}</td><td className="md-monitor-wrap">{run.error || (run.status === 'committed' ? `${number(run.count)} 条作品观测` : '详见运行证据')}<details><summary>运行证据</summary><pre>{JSON.stringify(run, null, 2)}</pre></details></td></tr>)}</tbody></table></div> : <p className="md-monitor-empty">当前范围暂无运行记录。</p>}
      {runs.length > 20 && <button type="button" className="md-pill md-monitor-self-start" onClick={() => setShowAll(value => !value)}>{showAll ? '收起较早记录' : `显示已返回的全部 ${runs.length} 条记录`}</button>}
    </> : !resource.loading && <p className="md-monitor-note">采集状态不可用，预算与运行数量保留未知。</p>}
    <details className="md-monitor-evidence"><summary>平台覆盖与采集边界</summary><ul className="md-monitor-platforms">{(status?.platforms || platforms).map(row => <li key={row.platform}><strong>{row.platform} · {row.tier || '未分级'}</strong><span>作品：{row.posts ? '已登记采集链' : '暂不可用'} · 粉丝：{row.followers ? '已登记字段' : '暂不可用'}</span><p>{row.reason || '暂无进一步能力说明'}</p></li>)}</ul><p className="md-monitor-note">已登记端点在实际调用时仍需通过价格、身份与响应字段校验。单页和搜索结果不保证完整历史。后台采集需服务器侧已绑定会话与身份验证；此面板不登录、绑定或操作发布页。</p></details>
  </div>
}

export function MonitorPanel({ embedded = false, initialTab = 'status', initialAccountId = '' } = {}) {
  const catalog = useMonitorRead('monitor/accounts', { pollMs: 30000 })
  const status = useMonitorRead('monitor/status', { pollMs: 30000 })
  const [role, setRole] = React.useState(''), [platform, setPlatform] = React.useState(''), [accountId, setAccountId] = React.useState(initialAccountId)
  const [panel, setPanel] = React.useState(embedded ? initialTab : 'account'), [adding, setAdding] = React.useState(false), [busy, setBusy] = React.useState(false)
  const [feedback, setFeedback] = React.useState(null), [dataVersions, setDataVersions] = React.useState({}), [range, setRange] = React.useState(null)
  const alive = React.useRef(true), actionLock = React.useRef(false), view = React.useRef('')
  React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const allAccounts = catalog.data?.accounts || [], platforms = catalog.data?.platforms || status.data?.platforms || []
  const accounts = allAccounts.filter(row => (!role || row.roles?.includes(role)) && (!platform || row.platform === platform))
  const account = accounts.find(row => row.accountId === accountId) || accounts[0]
  const activeId = account?.accountId || ''
  const today = localDate(Date.now(), account?.timeZone)
  const from = range?.from ?? new Date(Date.parse(today) - 29 * DAY).toISOString().slice(0, 10), to = range?.to ?? today
  const invalidRange = rangeError(from, to)
  const viewKey = JSON.stringify([role, platform, activeId, panel])
  view.current = viewKey
  const refreshMetadata = () => { catalog.reload(); status.reload() }
  const invalidate = id => setDataVersions(old => ({ ...old, [id]: (old[id] || 0) + 1 }))
  const mutate = async (operation, successMessage) => {
    if (actionLock.current) return null
    actionLock.current = true; setBusy(true); setFeedback(null)
    try {
      const result = await operation()
      if (alive.current) { setFeedback({ text: successMessage(result), error: false }); refreshMetadata() }
      return result
    } catch (error) {
      if (alive.current) { setFeedback({ text: message(error), error: true }); refreshMetadata() }
      return { error: message(error) }
    } finally {
      actionLock.current = false
      if (alive.current) setBusy(false)
    }
  }
  const save = async body => {
    const origin = view.current
    const result = await mutate(() => request('monitor/account', body), output => `${output.account?.displayName || '账号'}的监控设置已保存；未发起即时采集。`)
    if (!alive.current || !result?.account) return result
    catalog.update(old => {
      const rows = old?.accounts || []
      const existing = rows.some(row => row.accountId === result.account.accountId)
      return { ...(old || {}), platforms: old?.platforms || platforms, accounts: existing ? rows.map(row => row.accountId === result.account.accountId ? result.account : row) : [...rows, result.account] }
    })
    if (!body.accountId && view.current === origin) { setAdding(false); setRole(''); setPlatform(''); setAccountId(result.account.accountId); setPanel('account') }
    return result
  }
  const collect = async (target, purpose, acknowledgeUnknown = false) => {
    if (collectionBlock(target, purpose, status.data, actionLock.current, acknowledgeUnknown)) return null
    const result = await mutate(() => request('monitor/refresh', { accountId: target.accountId, purpose, requestId: crypto.randomUUID(), acknowledgeUnknown }), output => `${target.displayName} · ${PURPOSE[purpose]}：${STATUS[output.status] || output.status || '请求已处理'}${output.observedAt ? ` · 实际观测 ${date(output.observedAt, target.timeZone)}` : ''}。请以运行证据和实际样本为准。`)
    if (alive.current && result && !result.error) invalidate(target.accountId)
    if (alive.current && result?.error) setFeedback({ text: `${target.displayName} · ${PURPOSE[purpose]}：${result.error}。请先查看采集状态与费用记录，勿直接重复提交。`, error: true })
    return result
  }
  const recover = async () => {
    const result = await mutate(() => request('monitor/refresh', { purpose: 'recover' }), () => '索引／遗留锁恢复已完成；未发起外部采集。')
    if (alive.current && result && !result.error) for (const row of allAccounts) invalidate(row.accountId)
  }
  return <section className={`${embedded ? '' : 'md-tile '}md-monitor`} aria-label="采集与账单"><style>{styles}</style>
    {!embedded && <header className="md-tile-head"><h2>采集与账单</h2><span className="md-tile-meta">多平台自动同步</span><button type="button" className="md-pill" aria-expanded={adding} disabled={busy || !catalog.data} onClick={() => setAdding(value => !value)}>{adding ? '收起' : '+ 添加对标'}</button></header>}
    <div className="md-monitor-body">
      {feedback && <div className={feedback.error ? 'md-monitor-error' : 'md-monitor-feedback'} role={feedback.error ? 'alert' : 'status'}><span>{feedback.text}</span><button type="button" aria-label="关闭操作提示" onClick={() => setFeedback(null)}>×</button></div>}
      <ReadNotice resource={catalog} label="监控账号" />
      {status.error && panel !== 'status' && <div className="md-monitor-error" role="alert"><span>状态与预算读取失败：{status.error}</span><button type="button" className="md-pill" onClick={() => setPanel('status')}>查看状态</button></div>}
      {adding && catalog.data && <AddAccount platforms={platforms} onSave={save} busy={busy} onClose={() => setAdding(false)} />}
      <div className="md-monitor-filters">
        <label>范围<select value={role} onChange={event => { setRole(event.target.value); setAccountId('') }}><option value="">全部账号</option><option value="own">自有账号</option><option value="bench">对标账号</option></select></label>
        <label>平台<select value={platform} onChange={event => { setPlatform(event.target.value); setAccountId('') }}><option value="">全部平台</option>{[...new Set([...platforms.map(row => row.platform), ...allAccounts.map(row => row.platform)])].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="md-monitor-account">账号<select value={activeId} disabled={!accounts.length} onChange={event => setAccountId(event.target.value)}>{!accounts.length && <option value="">{catalog.loading && !catalog.data ? '读取中' : '暂无账号'}</option>}{accounts.map(row => <option key={row.accountId} value={row.accountId}>{row.displayName} · {row.platform}{row.enabled ? '' : ' · 已停用'}</option>)}</select></label>
        {embedded && <button type="button" className="md-pill" aria-expanded={adding} disabled={busy || !catalog.data} onClick={() => setAdding(value => !value)}>{adding ? '收起添加' : '+ 添加对标'}</button>}
      </div>
      <nav className="md-monitor-tabs" aria-label="监控视图">{[['status', '额度与运行'], ['account', '采集配置'], ['posts', '单篇曲线'], ['cohort', 'D1/D3/D7 对照']].map(([key, label]) => <button key={key} type="button" aria-pressed={panel === key} onClick={() => setPanel(key)}>{label}</button>)}</nav>
      {account && ['account', 'posts'].includes(panel) && <>
        <div className="md-monitor-filters"><label>起始<input type="date" value={from} max={to || undefined} aria-invalid={Boolean(invalidRange)} onChange={event => setRange({ from: event.target.value, to })} /></label><label>结束<input type="date" value={to} min={from || undefined} aria-invalid={Boolean(invalidRange)} onChange={event => setRange({ from, to: event.target.value })} /></label><button type="button" className="md-pill" onClick={() => setRange(null)}>近 30 天</button></div>
        {invalidRange && <p className="md-monitor-error" role="alert">{invalidRange}</p>}
      </>}
      {account && <AccountWorkspace key={activeId} account={account} publicCapabilities={platforms.find(row => row.platform === account.platform)} panel={panel} from={from} to={to} invalidRange={invalidRange} revision={dataVersions[activeId] || 0} status={status.data} busy={busy} onSave={save} onReloadAccounts={catalog.reload} onCollect={collect} onStatus={() => setPanel('status')} />}
      {!account && catalog.data && panel !== 'status' && <div className="md-monitor-empty"><p>{allAccounts.length ? '此筛选下暂无账号。可切换平台或范围查看已有观测。' : '尚无监控账号。自有账号沿用原账号档案；对标账号可在这里添加。'}</p>{(role || platform) && <button type="button" className="md-pill" onClick={() => { setRole(''); setPlatform(''); setAccountId('') }}>清除筛选</button>}</div>}
      {panel === 'status' && <StatusPanel resource={status} accounts={allAccounts} platforms={platforms} activeId={activeId} busy={busy} onRecover={recover} onCollect={collect} />}
    </div>
  </section>
}
