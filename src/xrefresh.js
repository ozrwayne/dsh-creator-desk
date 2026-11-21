// X 日常读取走 Grok；Monid 只在手动指定时调用，共享月度预算。
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { DEFAULT_THRESHOLD, splitDocument } from './pieces.js'
import { daysBetween, localDay, xRow } from './todo.js'
import { fileLock } from './monitor-store.js'

export const X_ENDPOINT = '/api/v1/twitter/web/fetch_user_post_tweet'
// monid inspect -p tikhub -e 上述端点：翻页参数名是 cursor，上一页 JSON 的 next_cursor 原样传回。
export const CURSOR_PARAM = 'cursor'
export const PAGE_COST = 0.001
export const CHECK_DELAY_MS = 60_000
export const CHECK_EVERY_MS = 10 * 60 * 1000
export const XREFRESH_DEFAULTS = {
  enabled: false,
  everyHours: 6,
  accounts: [],
  maxPages: 3,
  lookbackDays: 30,
}
export const DEFAULT_CAP = 0
const CAP_ERROR = '本月花费已达上限'
const SKIP_NOTE = '无需刷新'
const HANDLE = /^[A-Za-z0-9_]{1,15}$/
const STATUS_ID = /\/status\/(\d+)/
const URL_RE = /https?:\/\/\S+|www\.\S+/gi

function clamp(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

export function normalizeAccounts(raw) {
  if (!Array.isArray(raw)) return []
  const accounts = []
  for (const row of raw) {
    if (!row || typeof row.account !== 'string' || typeof row.handle !== 'string') continue
    const handle = row.handle.trim()
    if (!HANDLE.test(handle)) continue
    accounts.push({ account: row.account.trim().slice(0, 80), handle })
  }
  return accounts
}

export function normalizeXRefresh(raw) {
  const base = structuredClone(XREFRESH_DEFAULTS)
  if (!raw || typeof raw !== 'object') return base
  if (typeof raw.enabled === 'boolean') base.enabled = raw.enabled
  if (raw.everyHours !== undefined) base.everyHours = clamp(raw.everyHours, 1, 168, base.everyHours)
  if (raw.maxPages !== undefined) base.maxPages = clamp(raw.maxPages, 1, 20, base.maxPages)
  if (raw.lookbackDays !== undefined) base.lookbackDays = clamp(raw.lookbackDays, 1, 365, base.lookbackDays)
  const accounts = normalizeAccounts(raw.accounts)
  if (accounts.length) base.accounts = accounts
  return base
}

export function normalizeCap(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CAP
}

export function monthKey(now) {
  const date = now instanceof Date ? now : new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function hoursMs(everyHours) {
  const hours = Number(everyHours)
  return (Number.isFinite(hours) && hours > 0 ? hours : XREFRESH_DEFAULTS.everyHours) * 3600 * 1000
}

/** 到点了才跑。花费上限跨月后允许再试，不必干等 everyHours。 */
export function refreshDue({ enabled, lastRunAt, everyHours, now, lastError, spentMonth } = {}) {
  if (!enabled) return false
  const at = now instanceof Date ? now : new Date(now)
  if (lastError === CAP_ERROR && spentMonth && spentMonth !== monthKey(at)) return true
  const last = lastRunAt ? Date.parse(lastRunAt) : NaN
  if (!Number.isFinite(last)) return true
  return at.getTime() - last >= hoursMs(everyHours)
}

export function nextRunAt({ enabled, lastRunAt, everyHours, now } = {}) {
  if (!enabled) return null
  const at = now instanceof Date ? now : new Date(now)
  const last = lastRunAt ? Date.parse(lastRunAt) : NaN
  if (!Number.isFinite(last)) return at.toISOString()
  return new Date(last + hoursMs(everyHours)).toISOString()
}

function fail(status, message) {
  return Object.assign(new Error(message), { status })
}

export function normalizeMatch(text) {
  return String(text || '').replace(URL_RE, '').replace(/[\s\p{P}]+/gu, '').toLowerCase()
}

/** 去掉标题行和空白。不足 20 个字符返回 null，否则返回用于匹配的前 60 字规范化结果。 */
export function draftProbe(body, title) {
  const lines = String(body || '').replace(/^\uFEFF/, '').split(/\r?\n/)
  let i = 0
  while (i < lines.length && !lines[i].trim()) i += 1
  if (i < lines.length) {
    const first = lines[i].trim().replace(/^#+\s*/, '')
    if (first && first === String(title || '').trim()) i += 1
  }
  const rest = lines.slice(i).join('').replace(/\s+/g, '')
  if ([...rest].length < 20) return null
  const slice = [...rest].slice(0, 60).join('')
  const key = normalizeMatch(slice)
  return key || null
}

function textHits(key, norm) {
  if (!key || !norm) return false
  return norm.includes(key) || key.startsWith(norm)
}

function intOf(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value)) return value
  const raw = String(value ?? '').replace(/,/g, '').trim()
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

function isRetweet(row) {
  return String(row?.text || '').trimStart().startsWith('RT @')
}

function collectTweets(output) {
  const timeline = Array.isArray(output?.timeline) ? output.timeline : []
  const pinned = output?.pinned
  const extra = Array.isArray(pinned) ? pinned : (pinned && typeof pinned === 'object' ? [pinned] : [])
  return [...extra, ...timeline]
}

function parseTweet(row, handle) {
  const id = String(row?.tweet_id || '')
  if (!/^\d+$/.test(id)) return null
  const at = Date.parse(row.created_at)
  const when = Number.isFinite(at) ? new Date(at) : null
  const text = String(row.text || '')
  return {
    id,
    handle,
    text,
    norm: normalizeMatch(text),
    views: intOf(row.views),
    day: when ? localDay(when) : '',
    publishedAt: when?.toISOString() || null,
    url: `https://x.com/${handle}/status/${id}`,
    favorites: intOf(row.favorites),
    replies: intOf(row.replies),
    retweets: intOf(row.retweets),
    quotes: intOf(row.quotes),
    bookmarks: intOf(row.bookmarks),
  }
}

function statusId(url) {
  const match = STATUS_ID.exec(String(url || ''))
  return match ? match[1] : ''
}

function snapshotOf(at, note, tweet) {
  return {
    at: tweet.observedAt || at.toISOString(),
    observedAt: tweet.observedAt || at.toISOString(),
    note,
    tweetId: tweet.id,
    handle: tweet.handle || null,
    url: tweet.url || null,
    publishedAt: tweet.publishedAt || tweet.createdAt || null,
    kind: tweet.kind || null,
    text: tweet.text || '',
    views: tweet.views,
    favorites: tweet.favorites,
    replies: tweet.replies,
    retweets: tweet.retweets,
    quotes: tweet.quotes,
    bookmarks: tweet.bookmarks,
  }
}

function emptyState(now) {
  return {
    lastRunAt: null,
    lastOk: null,
    lastError: null,
    lastNote: null,
    updated: [],
    suggestions: [],
    spentThisMonth: 0,
    spentMonth: monthKey(now),
    dismissed: [],
  }
}


function monidError(data) {
  if (data == null) return '还没有安装 Monid'
  if (data.error) {
    if (data.error.code === 'AUTH_FAILED') return 'Monid 还没配置密钥'
    return `Monid：${String(data.error.message || '').slice(0, 160)}`
  }
  if (data.status === 'BLOCKED') return '本次导入超出 Monid 后台的预算限制，请到 app.monid.ai 调整后再试'
  if (data.status !== 'COMPLETED') {
    const status = String(data.status || '').slice(0, 20) || '未知状态'
    return `Monid 本次运行未完成（${status}）`
  }
  return ''
}

const budgetQueues = new Map()

/** 两个读取器共享账本；旧 x-refresh.json 的本月累计只迁入一次。 */
export class MonidBudget {
  constructor({ dataDir, settings, now = () => new Date() }) {
    this.dataDir = dataDir
    this.settings = settings
    this.now = now
    this.file = join(dataDir, 'monid-budget.json')
  }

  async read(now = this.now()) {
    let saved
    try { saved = JSON.parse(await readFile(this.file, 'utf8')) } catch (err) {
      if (err.code !== 'ENOENT') throw err
      try { saved = JSON.parse(await readFile(join(this.dataDir, 'x-refresh.json'), 'utf8')) } catch (old) {
        if (old.code !== 'ENOENT') throw old
        saved = {}
      }
    }
    const spentMonth = monthKey(now)
    const amount = Number(saved.spentThisMonth)
    const settings = await this.settings.read()
    return { spentMonth, spentThisMonth: saved.spentMonth === spentMonth && Number.isFinite(amount) && amount >= 0 ? amount : 0, cap: normalizeCap(settings.monidMonthlyCapUsd) }
  }

  async save(state) {
    await mkdir(this.dataDir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2))
    await rename(tmp, this.file)
  }

  run(estimate, call, now = this.now()) {
    const key = resolve(this.file)
    const task = () => fileLock(join(this.dataDir, 'monid-budget.lock'), async () => {
      const state = await this.read(now)
      if (state.spentThisMonth + estimate > state.cap + 1e-9) throw fail(402, CAP_ERROR)
      const before = state.spentThisMonth
      state.spentThisMonth = Math.round((before + estimate) * 1e6) / 1e6
      await this.save(state)
      // 超时保留预记费用，避免自动重试穿透预算。
      const result = await call()
      let cost = result?.cost?.value
      const charged = result?.billing?.reportedCost ?? result?.billing?.charged
      if (!Number.isFinite(cost) && Number.isFinite(charged?.value)) cost = charged.unit === 'MICRO_DOLLAR' ? charged.value / 1e6 : charged.value
      if (result == null) cost = 0
      if (!Number.isFinite(cost) || cost < 0) cost = estimate
      state.spentThisMonth = Math.round((before + cost) * 1e6) / 1e6
      await this.save(state)
      return result
    })
    const next = (budgetQueues.get(key) || Promise.resolve()).then(task, task)
    const settled = next.catch(() => {})
    budgetQueues.set(key, settled)
    settled.then(() => { if (budgetQueues.get(key) === settled) budgetQueues.delete(key) })
    return next
  }
}

function grokTweet(row) {
  if (!/^\d+$/.test(String(row?.id || '')) || row.kind === '转推') return null
  const at = Date.parse(row.createdAt)
  return {
    ...row, id: String(row.id), handle: String(row.handle || '').replace(/^@/, ''),
    norm: normalizeMatch(row.text), views: intOf(row.views),
    day: Number.isFinite(at) ? localDay(new Date(at)) : '',
    favorites: intOf(row.likes), replies: intOf(row.replies),
    retweets: intOf(row.reposts), quotes: intOf(row.quotes), bookmarks: intOf(row.bookmarks),
  }
}

/**
 * 启动后先等一会，之后按固定间隔检查。返回清理函数。定时器 unref，不拖住进程退出。
 * @param {{ maybeRun: Function }} refresh
 * @param {{ firstMs?: number, everyMs?: number }} [options]
 */
export function armRefresh(refresh, { firstMs = CHECK_DELAY_MS, everyMs = CHECK_EVERY_MS } = {}) {
  let timer
  const tick = () => {
    Promise.resolve(refresh.maybeRun()).catch(() => {})
    timer = setTimeout(tick, everyMs)
    timer.unref?.()
  }
  timer = setTimeout(tick, firstMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export class XRefresh {
  constructor({ dataDir, settings, pieces, run, grokx, monitor, now = () => new Date() }) {
    this.dataDir = dataDir
    this.settings = settings
    this.pieces = pieces
    this.run = run
    this.now = now
    this.grokx = grokx
    this.monitor = monitor
    this.budget = new MonidBudget({ dataDir, settings, now })
    this.queue = Promise.resolve()
    this.inflight = null
  }

  enqueue(task) {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  stateFile() {
    return join(this.dataDir, 'x-refresh.json')
  }

  metricsFile() {
    return join(this.dataDir, 'x-metrics.jsonl')
  }

  async readState() {
    try {
      const saved = JSON.parse(await readFile(this.stateFile(), 'utf8'))
      if (!saved || typeof saved !== 'object') return emptyState(this.now())
      // Older records only prove a read when the last attempt actually fetched data.
      if (!('lastSuccessAt' in saved)) saved.lastSuccessAt =
        saved.lastOk && !saved.lastNote && (saved.readCount > 0 || saved.updated?.length) ? saved.lastRunAt : null
      return saved
    } catch (err) {
      if (err.code === 'ENOENT') return emptyState(this.now())
      throw err
    }
  }

  async loadState(now) {
    const saved = await this.readState()
    const state = { ...emptyState(now), ...saved, ...await this.budget.read(now) }
    if (!Array.isArray(state.updated)) state.updated = []
    if (!Array.isArray(state.suggestions)) state.suggestions = []
    if (!Array.isArray(state.dismissed)) state.dismissed = []
    return state
  }

  async writeState(state) {
    await mkdir(this.dataDir, { recursive: true })
    const file = this.stateFile()
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2))
    await rename(tmp, file)
  }

  async appendMetrics(rows, options) {
    if (!rows.length) return
    if (this.monitor) return this.monitor.ingestXMetrics(rows, options)
    await mkdir(this.dataDir, { recursive: true })
    await appendFile(this.metricsFile(), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  }

  async latest(note) {
    if (this.monitor) {
      const latest = await this.monitor.latestX(note)
      if (latest) return latest
    }
    let text = ''
    try {
      text = await readFile(this.metricsFile(), 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
    let found = null
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (row.note === note) found = row
      } catch { /* 坏行跳过 */ }
    }
    return found
  }

  async config() {
    const saved = await this.settings.read()
    return { saved, cfg: { ...normalizeXRefresh(saved.xRefresh), cap: normalizeCap(saved.monidMonthlyCapUsd), threshold: Number.isFinite(saved.threshold) ? saved.threshold : DEFAULT_THRESHOLD } }
  }

  present(state, cfg, now) {
    const at = now instanceof Date ? now : new Date(now)
    const spent = state.spentMonth === monthKey(at) ? state.spentThisMonth : 0
    return {
      ...state,
      running: Boolean(this.inflight),
      spentThisMonth: spent,
      nextRunAt: nextRunAt({ enabled: cfg.enabled, lastRunAt: state.lastRunAt, everyHours: cfg.everyHours, now: at }),
      enabled: cfg.enabled,
      cap: cfg.cap,
      everyHours: cfg.everyHours,
      via: state.via || 'grok',
      source: state.via === 'monid' ? '用 Monid 读取' : '用 Grok 读取',
      readCount: state.readCount || 0,
    }
  }

  async status(now = this.now()) {
    const at = now instanceof Date ? now : new Date(now)
    const { cfg } = await this.config()
    return this.present(await this.loadState(at), cfg, at)
  }

  async maybeRun(now = this.now()) {
    if (this.inflight) return null
    const at = now instanceof Date ? now : new Date(now)
    const { cfg } = await this.config()
    const state = await this.loadState(at)
    if (this.inflight || !refreshDue({ enabled: cfg.enabled, lastRunAt: state.lastRunAt, everyHours: cfg.everyHours, now: at, lastError: state.lastError, spentMonth: state.spentMonth })) return null
    return this.runRefresh({ now: at })
  }

  runRefresh(opts = {}) {
    if (this.inflight) return this.inflight
    const job = this.enqueue(async () => {
      try {
        return { ...await this._refresh(opts), running: false }
      } catch (err) {
        const now = opts.now || this.now()
        const at = now instanceof Date ? now : new Date(now)
        const state = await this.readState()
        await this.writeState({ ...state, lastRunAt: at.toISOString(), lastOk: false, lastError: String(err?.message || err).slice(0, 200), lastNote: null, updated: [] })
        throw err
      }
    })
    this.inflight = job
    job.then(() => { if (this.inflight === job) this.inflight = null }, () => { if (this.inflight === job) this.inflight = null })
    return job
  }

  startRefresh(opts = {}) {
    this.runRefresh(opts).catch(() => {}) // runRefresh 已将后台错误写入状态。
    return this.status()
  }

  updateSettings(patch = {}) {
    return this.enqueue(async () => {
      const xRefresh = {}
      if (typeof patch.enabled === 'boolean') xRefresh.enabled = patch.enabled
      if (patch.everyHours !== undefined) xRefresh.everyHours = patch.everyHours
      if (Object.keys(xRefresh).length) await this.settings.update({ xRefresh })
      const at = this.now()
      const { cfg } = await this.config()
      return this.present(await this.loadState(at), cfg, at)
    })
  }

  suggestion(input = {}) {
    return this.enqueue(() => this._suggestion(input))
  }

  async bodyOf(vaultRoot, piece) {
    if (!piece?.path) {
      const full = await this.pieces().readPiece(piece.note)
      return full.body || ''
    }
    const file = join(vaultRoot, ...String(piece.path).split('/'))
    const root = resolve(vaultRoot)
    const abs = resolve(file)
    if (abs !== root && !abs.startsWith(root + sep)) return ''
    return splitDocument(await readFile(abs, 'utf8')).body
  }

  async callPage(query, state, now = this.now()) {
    let data
    try {
      data = await this.budget.run(PAGE_COST, () => this.run(['run', '-p', 'tikhub', '-e', X_ENDPOINT, '--query', JSON.stringify(query), '-w', '120', '-j'], 150), now)
    } catch (err) {
      return { error: String(err?.message || 'Monid 命令运行失败').slice(0, 200) }
    }
    if (data == null) return { error: '还没有安装 Monid' }
    Object.assign(state, await this.budget.read(now))
    const error = monidError(data)
    if (error) return { error }
    return { output: data.output || {} }
  }

  async _refresh({ now = this.now(), via = 'grok' } = {}) {
    const at = now instanceof Date ? now : new Date(now)
    const { saved, cfg } = await this.config()
    const state = await this.loadState(at)
    state.via = via === 'monid' ? 'monid' : 'grok'
    state.readCount = 0
    let board
    try {
      board = await this.pieces().board()
    } catch (err) {
      const next = { ...state, lastRunAt: at.toISOString(), lastOk: false, lastError: String(err?.message || '刷新失败').slice(0, 200), lastNote: null, updated: [] }
      await this.writeState(next)
      return this.present(next, cfg, at)
    }
    const shorts = (board.pieces || []).filter(piece => piece.form === '短推')
    const backfill = []
    const detect = []
    const today = localDay(at)
    for (const piece of shorts) {
      const row = xRow(piece)
      if (row) {
        const age = daysBetween(String(row.date || '').slice(0, 10), today)
        if (age != null && age >= 0 && age <= cfg.lookbackDays) backfill.push(piece)
        continue
      }
      if (piece.status === '定稿' && (piece.platforms || []).includes('X')) detect.push(piece)
    }
    if (!backfill.length && !detect.length) {
      const next = { ...state, lastRunAt: at.toISOString(), lastOk: true, lastError: null, lastNote: SKIP_NOTE, updated: [], suggestions: [] }
      await this.writeState(next)
      return this.present(next, cfg, at)
    }
    const dates = backfill.map(piece => String(xRow(piece)?.date || '').slice(0, 10)).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort()
    const earliest = dates[0] || ''
    const seen = []
    let error = cfg.accounts.length ? null : '没有可刷新的 X 账号'
    let fetched = 0
    let requested = false
    const notes = []
    if (state.via === 'grok') {
      try {
        if (!this.grokx) throw new Error('Grok 读取器尚未就绪')
        const urls = [...new Set(backfill.map(piece => xRow(piece)?.url).filter(url => statusId(url)))]
        requested = urls.length > 0
        const direct = urls.length ? await this.grokx.readPosts(urls, { partial: true }) : { posts: [], failed: [] }
        const observedAt = this.now().toISOString()
        seen.push(...direct.posts.map(row => grokTweet({ ...row, observedAt: row.observedAt || observedAt })).filter(Boolean))
        if (direct.failed.length) notes.push(`${direct.failed.length} 条没读到：${direct.failed.map(item => `${item.url}（${item.reason}）`).join('；')}`)
        fetched += 1
        if (detect.length) for (const account of cfg.accounts) {
          requested = true
          const recent = await this.grokx.listRecent(account.handle, { sinceDays: 3 })
          const observedAt = this.now().toISOString()
          seen.push(...recent.map(row => grokTweet({ ...row, observedAt: row.observedAt || observedAt })).filter(tweet => tweet && tweet.handle.toLowerCase() === account.handle.toLowerCase()))
          if (recent.missed) notes.push(`近期帖子 ${recent.missed} 条没读到`)
        }
      } catch (err) {
        error = String(err?.message || 'Grok 读取失败').slice(0, 200)
      }
    } else for (const account of cfg.accounts) {
      if (error) break
      let cursor = ''
      let covered = false
      for (let page = 0; page < cfg.maxPages && !covered; page += 1) {
        if (state.spentThisMonth >= cfg.cap) {
          error = CAP_ERROR
          break
        }
        const query = { screen_name: account.handle }
        if (cursor) query[CURSOR_PARAM] = cursor
        requested = true
        const result = await this.callPage(query, state, at)
        if (result.error) {
          error = result.error
          break
        }
        fetched += 1
        const observedAt = this.now().toISOString()
        const captured = []
        const timeline = Array.isArray(result.output?.timeline) ? result.output.timeline : []
        let oldest = ''
        for (const row of collectTweets(result.output)) {
          if (isRetweet(row)) continue
          const tweet = parseTweet(row, account.handle)
          if (!tweet) continue
          tweet.observedAt = observedAt
          seen.push(tweet)
          captured.push(snapshotOf(new Date(observedAt), null, tweet))
        }
        if (this.monitor && captured.length) {
          try { await this.appendMetrics(captured, { collectorId: 'legacy.x.monid-refresh.v1', observedAt }) }
          catch (err) { error = `监控留存失败：${String(err?.message || err).slice(0, 160)}` }
        }
        for (const row of timeline) {
          if (isRetweet(row)) continue
          const tweet = parseTweet(row, account.handle)
          if (tweet?.day && (!oldest || tweet.day < oldest)) oldest = tweet.day
        }
        if (earliest && oldest && oldest <= earliest) covered = true
        const nextCursor = typeof result.output.next_cursor === 'string' ? result.output.next_cursor : ''
        if (!nextCursor || nextCursor === cursor) break
        cursor = nextCursor
      }
    }
    const byId = new Map()
    for (const tweet of seen) if (!byId.has(tweet.id)) byId.set(tweet.id, tweet)
    const updated = []
    const snapshots = []
    const pieces = this.pieces()
    for (const piece of backfill) {
      const row = xRow(piece)
      const id = statusId(row?.url)
      const tweet = id ? byId.get(id) : null
      if (!tweet || tweet.views == null) continue
      snapshots.push(snapshotOf(at, piece.note, tweet))
      const from = row.impressions
      if (from != null && tweet.views <= from) continue
      await pieces.setImpressions({ note: piece.note, platform: 'X', impressions: tweet.views })
      updated.push({
        note: piece.note,
        from,
        to: tweet.views,
        validated: tweet.views > cfg.threshold,
      })
    }
    const dismissed = new Set(state.dismissed || [])
    const suggestions = []
    const used = new Set()
    const handlesOf = piece => {
      const names = new Set(piece.accounts || [])
      return cfg.accounts.filter(account => names.has(account.account)).map(account => account.handle)
    }
    for (const piece of detect) {
      let body = ''
      try {
        body = await this.bodyOf(saved.vaultRoot, piece)
      } catch {
        continue
      }
      const key = draftProbe(body, piece.title)
      if (!key) continue
      const handles = handlesOf(piece)
      const pool = handles.length ? seen.filter(tweet => handles.includes(tweet.handle)) : seen
      const tweet = pool.find(item => item.day && !dismissed.has(item.id) && !used.has(item.id) && textHits(key, item.norm))
      if (!tweet) continue
      used.add(tweet.id)
      suggestions.push({
        ...snapshotOf(this.now(), piece.note, tweet),
        url: tweet.url,
        date: tweet.day,
        collectorId: state.via === 'monid' ? 'legacy.x.monid-refresh.v1' : 'legacy.x.grok-refresh.v1',
      })
    }
    try {
      await this.appendMetrics(snapshots, { collectorId: state.via === 'monid' ? 'legacy.x.monid-refresh.v1' : 'legacy.x.grok-refresh.v1' })
    } catch (err) {
      if (!this.monitor) throw err
      error = `监控留存失败：${String(err?.message || err).slice(0, 160)}`
    }
    const next = {
      ...state,
      lastRunAt: at.toISOString(),
      lastSuccessAt: requested && !error && !notes.length ? at.toISOString() : state.lastSuccessAt ?? null,
      lastOk: !error,
      lastError: error,
      lastNote: notes.length ? notes.join('；') : null,
      updated,
      suggestions: fetched ? suggestions : state.suggestions,
      ...await this.budget.read(at),
      readCount: byId.size,
    }
    await this.writeState(next)
    return this.present(next, cfg, at)
  }

  async _suggestion(input) {
    const at = this.now()
    const { cfg } = await this.config()
    const state = await this.loadState(at)
    const note = String(input.note || '')
    const suggestion = (state.suggestions || []).find(item => item.note === note)
    if (input.action === 'dismiss') {
      if (suggestion) {
        state.dismissed = [...new Set([...(state.dismissed || []), suggestion.tweetId])]
        state.suggestions = state.suggestions.filter(item => item.tweetId !== suggestion.tweetId)
        await this.writeState(state)
      }
      return { x: this.present(state, cfg, at) }
    }
    if (input.action !== 'confirm') throw fail(400, '操作无效')
    if (!suggestion) throw fail(404, '这条建议已经不在')
    const pieces = this.pieces()
    await pieces.publish({ note, platform: 'X', url: suggestion.url, date: suggestion.date })
    if (Number.isInteger(suggestion.views) && suggestion.views >= 0) {
      await pieces.setImpressions({ note, platform: 'X', impressions: suggestion.views })
    }
    let monitorError = null
    try {
      await this.appendMetrics([snapshotOf(at, note, {
        ...suggestion,
        id: suggestion.tweetId,
        views: suggestion.views,
        favorites: suggestion.favorites ?? null,
        replies: suggestion.replies ?? null,
        retweets: suggestion.retweets ?? null,
        quotes: suggestion.quotes ?? null,
        bookmarks: suggestion.bookmarks ?? null,
      })], { collectorId: suggestion.collectorId || 'legacy.x.refresh.v1' })
    } catch (error) {
      if (!this.monitor) throw error
      monitorError = `监控留存失败：${String(error?.message || error).slice(0, 160)}`
      state.lastError = monitorError
    }
    state.suggestions = state.suggestions.filter(item => item.note !== note)
    await this.writeState(state)
    return { board: await pieces.board(), x: this.present(state, cfg, at), ...(monitorError ? { monitorError } : {}) }
  }
}
