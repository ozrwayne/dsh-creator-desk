// 对标原帖默认只进缓存；只有显式存入才写知识库。
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { httpError, localDay } from './vault.js'
import { queueBenchWiki } from './ingest.js'
import { createOriginalReader } from './xoriginal.js'
import { tr } from './i18n.js'

export const BENCH_ACCOUNTS = '对标/账号档案'
export const BENCH_POSTS = '对标/X原文'
export const INITIAL_HANDLES = []
export const HISTORY_FILES = []
const DAY_MS = 86400000
const METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'bookmarks']
const keyOf = handle => String(handle || '').toLowerCase()
const validDate = value => value != null && Number.isFinite(new Date(value).getTime())
const successOf = record => !record ? null : 'lastSuccessAt' in record ? record.lastSuccessAt : record.missed || record.failed?.length ? null : record.lastReadAt || null
const numberOf = value => {
  if (value == null || value === '') return null
  const number = Number(String(value).replaceAll(',', ''))
  return Number.isFinite(number) && number >= 0 ? number : null
}

export function normalizeHandle(value) {
  const handle = String(value || '').trim().replace(/^@/, '')
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw httpError(400, '账号无效')
  return handle
}

export function benchDue(state = {}, now = new Date()) {
  now = new Date(now)
  if (!validDate(now) || now.getHours() < 8 || state.running) return false
  const last = state.lastDailyAt
  return !validDate(last) || localDay(new Date(last)) < localDay(now)
}

export function baselineFor(posts, handle, now = new Date()) {
  const end = new Date(now).getTime()
  const values = posts.filter(post => keyOf(post.handle) === keyOf(handle) && !post.history && !post.expired && (post.kind === '原创' || post.kind === '引用') && validDate(post.createdAt) && new Date(post.createdAt).getTime() >= end - 30 * DAY_MS && new Date(post.createdAt).getTime() <= end)
    .map(post => numberOf(post.views)).filter(value => value !== null).sort((a, b) => a - b)
  const middle = Math.floor(values.length / 2)
  const median = values.length ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null
  return { median, samples: values.length, sufficient: values.length >= 8 }
}

export function postRatios(post, baseline) {
  const views = numberOf(post.views)
  const bookmarks = numberOf(post.bookmarks)
  return {
    multiple: baseline?.sufficient && baseline.median > 0 && views !== null ? views / baseline.median : null,
    bookmarkRate: views > 0 && bookmarks !== null ? bookmarks / views : null,
  }
}

export function prunePosts(posts, now = new Date()) {
  const cutoff = new Date(now).getTime() - 30 * DAY_MS
  return posts.map(post => {
    if (post.expired || post.history || post.savedPath || !validDate(post.createdAt) || new Date(post.createdAt).getTime() >= cutoff) return post
    return { id: post.id, handle: post.handle, status: post.status || '新', createdAt: post.createdAt, expired: true }
  })
}

export function postDistributions(posts) {
  const hours = Array(24).fill(0)
  const lengths = Array(4).fill(0)
  for (const post of posts) {
    if (!(post.multiple >= 2) || post.expired) continue
    if (validDate(post.createdAt)) hours[new Date(post.createdAt).getHours()] += 1
    if (typeof post.text === 'string') {
      const length = Array.from(post.text).length
      lengths[length <= 140 ? 0 : length <= 280 ? 1 : length <= 1000 ? 2 : 3] += 1
    }
  }
  return { hours, lengths }
}

const noteName = path => basename(String(path || '').replace(/^atom:/, '')).replace(/\.md$/i, '')

/** Links and events are append-only evidence; count unique sources, atoms and manuscripts. */
export function sourceEffects({ links = [], events = [], pieces = [], threshold = 3000 } = {}) {
  const groups = new Map()
  const atoms = new Map()
  const group = handle => {
    const key = keyOf(handle)
    if (!groups.has(key)) groups.set(key, { handle, files: new Set(), atoms: new Set(), confirmed: new Set(), rejected: new Set(), shorts: new Set(), verified: new Set() })
    return groups.get(key)
  }
  for (const link of links) {
    if (link.kind !== 'bench' || !link.handle) continue
    const target = group(link.handle)
    if (link.atoms?.length) target.files.add(link.path)
    for (const path of link.atoms || []) {
      const name = noteName(path)
      target.atoms.add(name)
      if (!atoms.has(name)) atoms.set(name, new Set())
      atoms.get(name).add(keyOf(link.handle))
    }
  }
  for (const event of events) {
    if (event.origin !== 'bench' || !event.handle) continue
    const target = group(event.handle)
    const name = noteName(event.path)
    if (event.action === 'confirm') target.confirmed.add(name)
    if (event.action === 'reject') target.rejected.add(name)
  }
  for (const piece of pieces) {
    if (piece.form !== '短推') continue
    const name = noteName(String(piece.source || '').replace(/^\[\[|\]\]$/g, ''))
    for (const key of atoms.get(name) || []) {
      const target = groups.get(key)
      target.shorts.add(piece.note)
      if (piece.distributions?.some(row => row.platform === 'X' && numberOf(row.impressions) > threshold)) target.verified.add(piece.note)
    }
  }
  return Object.fromEntries([...groups.values()].map(row => [row.handle, {
    atoms: row.atoms.size, confirmed: row.confirmed.size,
    rejected: row.rejected.size, shorts: row.shorts.size, verified: row.verified.size,
  }]))
}

/** Table rows use UTC+08:00; detail headings default to UTC+08:00 unless they carry an explicit offset such as +09:00. */
export function parseHistory(text, allowedHandles = INITIAL_HANDLES) {
  const allowed = new Map(allowedHandles.map(handle => [keyOf(handle), handle]))
  const posts = new Map()
  const add = post => {
    const handle = allowed.get(keyOf(post.handle))
    if (!handle) return
    const old = posts.get(post.id)
    posts.set(post.id, { ...old, ...post, handle, history: true, source: '历史清单', status: '新', textComplete: false })
  }
  const urlPattern = /https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/
  for (const line of text.split(/\r?\n/)) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim())
    const url = cells[8]?.match(urlPattern)
    if (!url || cells.length < 10) continue
    const date = `${cells[1].replace(' ', 'T')}:00+08:00`
    add({ id: url[2], url: url[0], handle: url[1], createdAt: validDate(date) ? new Date(date).toISOString() : null,
      views: numberOf(cells[2]), likes: numberOf(cells[3]), replies: numberOf(cells[4]), reposts: numberOf(cells[5]), quotes: numberOf(cells[6]), bookmarks: numberOf(cells[7]),
      text: cells.slice(9).join('|').replace(/<br\s*\/?>/gi, '\n').replaceAll('\\|', '|'), kind: '未知' })
  }
  for (const block of text.split(/^### /m).slice(1)) {
    const url = block.match(/^链接[：:]\s*(https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+))/m)
    if (!url) continue
    const heading = block.split('\n', 1)[0]
    const stamp = heading.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)?.[0]
    const offset = heading.match(/[+-]\d{2}:\d{2}/)?.[0] || '+08:00'
    const date = stamp ? `${stamp.replace(' ', 'T')}:00${offset}` : null
    const metrics = block.split('\n').find(line => /^(?:曝光|互动[：:])/.test(line)) || ''
    const metric = names => numberOf(metrics.match(new RegExp(`(?:${names})\\s+([\\d,]+)`))?.[1])
    const body = block.split(/\r?\n/).filter(line => /^>/.test(line)).map(line => line.replace(/^> ?/, '')).join('\n')
    add({ id: url[3], url: url[1], handle: url[2], createdAt: validDate(date) ? new Date(date).toISOString() : null,
      views: metric('曝光') ?? numberOf(heading.match(/([\d,]+) 曝光/)?.[1]), likes: metric('点赞|赞'), replies: metric('回复|评'), reposts: metric('转发|转'), quotes: metric('引用'), bookmarks: metric('收藏'),
      text: body || posts.get(url[3])?.text || '', kind: metrics.includes('引用推文') ? '引用' : metrics ? '原创' : '未知' })
  }
  return [...posts.values()]
}

export function benchTitle(text) {
  return Array.from(String(text || '').split(/\r?\n/, 1)[0]).slice(0, 30).join('')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '-').replace(/[. ]+$/g, '').replace(/^\.+$/, '').trim() || '推文'
}

export function renderBenchPost(posts, { fetchedAt, complete, continuations = false }) {
  const first = posts[0]
  const sources = posts.map(post => `来源: [@${post.handle}](${post.url})`).join('\n')
  const body = posts.length === 1 ? first.text : posts.map(post => `## ${post.createdAt}\n\n${post.text}`).join('\n\n')
  return `${sources}\n日期: ${localDay(new Date(first.createdAt))}\n作者: @${first.handle}\n平台: X\n推文ID: ${posts.map(post => post.id).join(', ')}\n抓取时间: ${fetchedAt}\n曝光: ${posts.map(post => post.views ?? '未知').join(', ')}\n正文来源: Monid\n预览来源: Grok 转述，非正式原文\n正文完整: ${complete ? '是' : '否'}${continuations ? '\n连续帖: 是（取自读取结果，可能不全）' : ''}\n\n${body}\n`
}

async function readOptional(file, fallback) {
  try { return await readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}
async function jsonLines(file) {
  const text = await readOptional(file, '')
  return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
}
async function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, file)
}

export class Bench {
  constructor({ vault, settings, dataDir, grokx, monid, monitor, originalReader, ingest, pieces, now = () => new Date() }) {
    Object.assign(this, { vault, settings, dataDir, grokx, monitor, ingest, pieces, now })
    this.originalReader = originalReader || createOriginalReader({ dataDir, settings, monid, now })
    this.vaultSource = vault
    this.piecesSource = pieces
    this.dir = join(dataDir, 'bench')
    this.posts = new Map()
    this.state = { lastDailyAt: null, lastRunAt: null, accounts: {}, historyImports: [], wikiFiles: {} }
    this.progress = { running: false, current: 0, total: 0, handle: null, results: [] }
    this.chain = Promise.resolve()
    this.initializing = null
    this.refreshing = null
  }

  mutate(task) {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => {})
    return next
  }

  async init() {
    this.vault = typeof this.vaultSource === 'function' ? await this.vaultSource() : this.vaultSource
    this.pieces = typeof this.piecesSource === 'function' ? await this.piecesSource() : this.piecesSource
    if (!this.initializing) this.initializing = (async () => {
      if (!this.monitor) await mkdir(this.dir, { recursive: true })
      for (const row of await jsonLines(join(this.dir, 'posts.jsonl'))) this.posts.set(row.id, row)
      Object.assign(this.state, JSON.parse(await readOptional(join(this.dir, 'state.json'), '{}')))
      this.posts = new Map(prunePosts([...this.posts.values()], this.now()).map(post => [post.id, post]))
      if (!this.monitor) await this.persist()
      return this
    })().catch(error => { this.initializing = null; throw error })
    await this.initializing
    if (this.monitor) await this.mergeMonitorRows()
    return this
  }

  async mergeMonitorRows() {
    for (const raw of await this.monitor.benchRows()) {
      const id = String(raw.id || '')
      if (!/^\d+$/.test(id) || !/^[A-Za-z0-9_]{1,15}$/.test(raw.handle || '')) continue
      const old = this.posts.get(id)
      if (old?.expired || (old?.fetchedAt && raw.fetchedAt && old.fetchedAt > raw.fetchedAt)) continue
      const row = { ...old, ...raw, id, status: old?.status || '新', history: old?.history || false, source: old?.history ? '历史清单' : 'Grok' }
      for (const key of ['savedPath', 'bodyMonid', 'originalTextComplete', 'originalSourceField', 'originalFetchedAt', 'originalReadError', 'fulltextunavailable']) {
        if (old && Object.hasOwn(old, key)) row[key] = old[key]
      }
      for (const key of METRICS) row[key] = numberOf(raw[key])
      this.posts.set(id, row)
    }
  }

  async checkDaily(now = this.now()) {
    if (this.monitor) return null
    await this.init()
    if (!benchDue({ ...this.state, running: Boolean(this.refreshing) }, now)) return null
    return this.refresh({ daily: true, now })
  }

  async persist() {
    await atomicWrite(join(this.dir, 'posts.jsonl'), [...this.posts.values()].map(post => JSON.stringify(post)).join('\n') + (this.posts.size ? '\n' : ''))
    await atomicWrite(join(this.dir, 'state.json'), JSON.stringify(this.state))
  }

  // Check every existing segment before creating descendants; never follow a symlink out of the vault.
  async safePath(rel, { createParents = false, missing = false } = {}) {
    if (typeof rel !== 'string' || rel.includes('\\') || rel.includes('\0') || rel.startsWith('/') || rel.split('/').some(part => !part || part === '.' || part === '..')) throw httpError(400, '路径无效')
    const root = await realpath(this.vault.root)
    const parts = rel.split('/')
    let current = root
    for (let i = 0; i < parts.length; i += 1) {
      current = join(current, parts[i])
      try {
        if ((await lstat(current)).isSymbolicLink()) throw httpError(400, '路径无效')
        const actual = await realpath(current)
        const child = relative(root, actual)
        if (child === '..' || child.startsWith(`..${sep}`) || resolve(root, child) !== actual) throw httpError(400, '路径无效')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        if (i < parts.length - 1 && createParents) await mkdir(current)
        else if (missing) return join(root, ...parts)
        else throw error
      }
    }
    return current
  }
  async accounts() {
    this.vault = typeof this.vaultSource === 'function' ? await this.vaultSource() : this.vaultSource
    const dir = await this.safePath(BENCH_ACCOUNTS, { missing: true })
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const rows = []
    for (const entry of entries) {
      const match = /^X-([A-Za-z0-9_]{1,15})\.md$/.exec(entry.name)
      if (!match || !entry.isFile() || entry.name.includes('sync-conflict')) continue
      const path = `${BENCH_ACCOUNTS}/${entry.name}`
      const text = await readFile(await this.safePath(path), 'utf8')
      const header = text.split(/\r?\n\s*\r?\n/, 1)[0]
      const enabled = /^监控[：:]\s*启用\s*$/m.test(header)
      const reason = text.match(/^##\s+关注理由\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1]?.trim() || ''
      rows.push({ handle: match[1], enabled, reason, path })
    }
    return rows.sort((a, b) => a.handle.localeCompare(b.handle))
  }

  async addAccount(input = {}) {
    await this.init()
    return this.mutate(async () => {
      const handle = normalizeHandle(typeof input === 'string' ? input : input.handle)
      if ((await this.accounts()).some(row => keyOf(row.handle) === keyOf(handle))) throw httpError(409, '账号档案已存在')
      const path = `${BENCH_ACCOUNTS}/X-${handle}.md`
      const file = await this.safePath(path, { createParents: true, missing: true })
      const text = `来源: https://x.com/${handle}\n日期: ${localDay(this.now())}\n账号: X-${handle}\n平台: X\n监控: 启用\n\n# @${handle}\n\n## 关注理由\n\n待 Editor 补充\n`
      try { await writeFile(file, text, { flag: 'wx' }) } catch (error) { if (error.code === 'EEXIST') throw httpError(409, '账号档案已存在'); throw error }
      return { handle, enabled: true, path }
    })
  }

  async toggleAccount({ handle, enabled } = {}) {
    await this.init()
    if (typeof enabled !== 'boolean') throw httpError(400, '监控状态无效')
    handle = normalizeHandle(handle)
    return this.mutate(async () => {
      const row = (await this.accounts()).find(row => keyOf(row.handle) === keyOf(handle))
      if (!row) throw httpError(404, '找不到账号档案')
      const file = await this.safePath(row.path)
      const text = await readFile(file, 'utf8')
      const end = text.search(/\r?\n\s*\r?\n/)
      const header = end < 0 ? text : text.slice(0, end)
      const match = /^(监控[：:][ \t]*)(启用|停用)([ \t]*\r?)$/m.exec(header)
      if (!match) throw httpError(400, '账号档案缺少监控标签')
      const valueAt = match.index + match[1].length
      await atomicWrite(file, text.slice(0, valueAt) + (enabled ? '启用' : '停用') + text.slice(valueAt + match[2].length))
      return { ...row, enabled }
    })
  }

  async startRefresh(input = {}) {
    const snapshot = await this.read()
    this.refresh(input).catch(error => console.error('[bench] refresh failed:', error.message))
    return { ...snapshot, refresh: { ...snapshot.refresh, ...this.progress, results: [...this.progress.results] } }
  }

  refresh(input = {}) {
    if (this.refreshing) return this.refreshing
    this.progress = { running: true, startedAt: new Date(input.now ?? this.now()).toISOString(), current: 0, total: 0, handle: null, results: [], error: null }
    this.refreshing = this.performRefresh(input).catch(async error => {
      this.progress.error = error.message
      this.state.error = error.message
      this.state.lastRunAt = this.progress.startedAt
      this.state.results = this.progress.results
      if (this.initializing) {
        try { await this.mutate(() => this.persist()) } catch { /* Keep the original failure visible even if storage failed. */ }
      }
      throw error
    }).finally(() => {
      this.progress.running = false
      this.progress.handle = null
      this.refreshing = null
    })
    return this.refreshing
  }

  async performRefresh({ handle, handles, daily = false, now = this.now() } = {}) {
    await this.init()
    if (daily && !benchDue(this.state, now)) {
      this.progress.running = false
      return this.read()
    }
    const wanted = handle == null ? null : normalizeHandle(handle)
    const wantedSet = Array.isArray(handles) ? new Set(handles.map(item => keyOf(normalizeHandle(item)))) : null
    const accounts = (await this.accounts()).filter(row => wanted ? keyOf(row.handle) === keyOf(wanted) : wantedSet ? wantedSet.has(keyOf(row.handle)) : row.enabled)
    if (wanted && !accounts.length) throw httpError(404, '找不到账号档案')
    const at = new Date(now).toISOString()
    this.state.error = null
    this.progress = { running: true, startedAt: at, current: 0, total: accounts.length, handle: null, results: [], error: null }
    try {
      if (daily) await this.mutate(async () => { this.state.lastDailyAt = at; await this.persist() })
      for (const account of accounts) {
        this.progress.current += 1
        this.progress.handle = account.handle
        const key = keyOf(account.handle)
        try {
          const options = { sinceDays: this.state.accounts[key]?.lastReadAt ? 3 : 14 }
          const incoming = await (this.monitor ? this.monitor.recentX(account.handle, options) : this.grokx.listRecent(account.handle, options))
          if (!Array.isArray(incoming)) throw new Error('读取结果无效')
          const rows = [...new Map(incoming.filter(row => /^\d+$/.test(String(row.id)) && keyOf(row.handle) === key).map(row => [String(row.id), row])).values()]
          const missed = Number.isInteger(incoming.missed) && incoming.missed >= 0 ? incoming.missed : 0
          const failed = Array.isArray(incoming.failed) ? incoming.failed : []
          await this.mutate(async () => {
            const snapshots = []
            let added = 0
            for (const raw of rows) {
              const id = String(raw.id)
              const old = this.posts.get(id)
              if (old?.expired) continue
              if (!old) added++
              const row = { ...old, ...raw, id, handle: account.handle, status: old?.status || '新', history: old?.history || false, source: old?.history ? '历史清单' : 'Grok', fetchedAt: raw.observedAt || raw.fetchedAt || at }
              for (const name of METRICS) row[name] = numberOf(raw[name])
              this.posts.set(id, row)
              snapshots.push({ at, id, handle: account.handle, ...Object.fromEntries(METRICS.map(name => [name, row[name]])) })
            }
            if (snapshots.length && !this.monitor) await appendFile(join(this.dir, 'metrics.jsonl'), snapshots.map(row => JSON.stringify(row)).join('\n') + '\n')
            const lastSuccessAt = missed || failed.length ? successOf(this.state.accounts[key]) : at
            this.state.accounts[key] = { lastReadAt: at, lastSuccessAt, count: rows.length, added, missed, failed, error: null }
            this.posts = new Map(prunePosts([...this.posts.values()], now).map(row => [row.id, row]))
            await this.persist()
          })
          this.progress.results.push({ handle: account.handle, count: rows.length, missed, failed, error: null, at })
        } catch (error) {
          await this.mutate(async () => {
            this.state.accounts[key] = { ...this.state.accounts[key], lastSuccessAt: successOf(this.state.accounts[key]), count: 0, missed: 0, failed: [], error: error.message, attemptedAt: at }
            await this.persist()
          })
          this.progress.results.push({ handle: account.handle, count: 0, missed: 0, failed: [], error: error.message, at })
        }
      }
    } finally {
      this.progress.running = false
      this.progress.handle = null
      await this.mutate(async () => {
        this.state.lastRunAt = at
        this.state.results = this.progress.results
        this.posts = new Map(prunePosts([...this.posts.values()], now).map(row => [row.id, row]))
        await this.persist()
      })
    }
    return this.read()
  }

  async importHistory() {
    await this.init()
    return this.mutate(async () => {
      const results = []
      for (const path of HISTORY_FILES) {
        const rows = parseHistory(await readFile(await this.safePath(path), 'utf8'))
        let added = 0
        for (const row of rows) {
          const old = this.posts.get(row.id)
          if (!old) { this.posts.set(row.id, row); added += 1 }
          else if (!old.history) this.posts.set(row.id, { ...row, ...old, history: true, source: '历史清单', expired: false })
        }
        results.push({ path, parsed: rows.length, added, at: this.now().toISOString() })
      }
      this.state.historyImports = results
      await this.persist()
      return { files: results, added: results.reduce((sum, row) => sum + row.added, 0) }
    })
  }

  selected(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw httpError(400, '请选择推文')
    return [...new Set(ids)].map(id => {
      const row = this.posts.get(id)
      if (!row || row.expired) throw httpError(404, '找不到推文')
      return row
    })
  }

  savePlan(ids) {
    const selected = this.selected(ids)
    if (new Set(selected.map(row => keyOf(row.handle))).size !== 1) throw httpError(400, '只能合并同一账号的帖子')
    const handle = normalizeHandle(selected[0].handle)
    const roots = new Set(selected.map(row => row.id))
    const requested = new Map(selected.map(row => [row.id, row]))
    for (const root of selected) {
      for (const row of Array.isArray(root.threadPosts) ? root.threadPosts : []) {
        if (keyOf(row.handle) !== keyOf(handle)) continue
        if (!/^\d+$/.test(String(row.id))) throw httpError(502, '连续帖 ID 无效')
        if (!requested.has(String(row.id))) requested.set(String(row.id), row)
      }
    }
    return { selected, handle, requested: [...requested.values()], continuations: [...requested.keys()].some(id => !roots.has(id)),
      urls: [...requested.keys()].map(id => `https://x.com/${handle}/status/${id}`) }
  }

  async estimateSave({ ids } = {}) {
    await this.init()
    const plan = this.savePlan(ids)
    const savedPaths = new Set(plan.selected.map(row => row.savedPath).filter(Boolean))
    if (savedPaths.size === 1 && plan.selected.every(row => row.savedPath)) {
      return { ...this.originalReader.estimate([]), postCount: 0, alreadySaved: true }
    }
    if (plan.requested.some(row => row.savedPath || this.posts.get(String(row.id))?.savedPath)) throw httpError(409, '推文已存入')
    return this.originalReader.estimate(plan.urls)
  }

  async save(input = {}) {
    await this.init()
    return this.mutate(() => this.saveSelected(input.ids))
  }

  async saveSelected(ids) {
    const { handle, requested, urls, continuations } = this.savePlan(ids)
    if (requested.some(row => row.savedPath || this.posts.get(String(row.id))?.savedPath)) throw httpError(409, '推文已存入')
    let fresh
    try {
      fresh = await this.originalReader.readPosts(urls)
      if (!Array.isArray(fresh)) throw httpError(502, '未能读取推文全文')
      for (const request of requested) {
        const row = fresh.find(post => String(post.id) === String(request.id) && keyOf(post.handle) === keyOf(handle))
        if (!row || typeof row.text !== 'string' || !row.text.trim() || !validDate(row.createdAt)) throw httpError(502, tr('未能读取推文全文：{id}', { id: request.id }))
      }
    } catch (error) {
      for (const request of requested) {
        const cached = this.posts.get(String(request.id))
        if (cached) Object.assign(cached, { originalReadError: error.message, fulltextunavailable: true })
      }
      await this.persist()
      throw error
    }
    const posts = requested.map(request => {
      const row = fresh.find(post => String(post.id) === String(request.id) && keyOf(post.handle) === keyOf(handle))
      return { ...row, id: String(row.id), handle, url: `https://x.com/${handle}/status/${row.id}`,
        textComplete: row.textComplete === true && row.truncated !== true && !/(?:…|\.{3})\s*$/u.test(row.text) }
    }).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id.localeCompare(b.id))
    const complete = posts.every(row => row.textComplete)
    const path = `${BENCH_POSTS}/${handle}/${localDay(new Date(posts[0].createdAt))}-${benchTitle(posts[0].text)}.md`
    const file = await this.safePath(path, { createParents: true, missing: true })
    const fetchedAt = this.now().toISOString()
    try { await writeFile(file, renderBenchPost(posts, { fetchedAt, complete, continuations }), { flag: 'wx' }) } catch (error) { if (error.code === 'EEXIST') throw httpError(409, '原文文件已存在'); throw error }
    for (const post of posts) {
      const cached = this.posts.get(post.id) || requested.find(row => String(row.id) === post.id)
      this.posts.set(post.id, { ...cached, id: post.id, handle, url: post.url, status: '已存入', savedPath: path,
        bodyMonid: post.text, originalTextComplete: post.textComplete, originalSourceField: post.sourceField,
        originalFetchedAt: fetchedAt, originalReadError: null, fulltextunavailable: !post.textComplete })
    }
    await this.persist()
    return { path, ids: posts.map(post => post.id), complete, textComplete: complete, fulltextunavailable: !complete, costUSD: fresh.costUSD ?? null }
  }

  async ignore({ ids } = {}) {
    await this.init()
    return this.mutate(async () => {
      const selected = this.selected(ids)
      for (const row of selected) {
        if (row.savedPath) throw httpError(409, '已存入的推文不能忽略')
      }
      for (const row of selected) row.status = '已忽略'
      await this.persist()
      return { ids: selected.map(row => row.id) }
    })
  }

  async wiki({ path } = {}) {
    await this.init()
    if (typeof path !== 'string' || !path.startsWith(`${BENCH_POSTS}/`) || !path.endsWith('.md')) throw httpError(400, '路径无效')
    await this.safePath(path)
    return queueBenchWiki(this.ingest, this.vault, path)
  }

  async read() {
    await this.init()
    const [accounts, links, events, wikiJobs, wikiFiles, board, settings] = await Promise.all([
      this.accounts(), jsonLines(join(this.dataDir, 'links.jsonl')), jsonLines(join(this.dataDir, 'atom-events.jsonl')),
      this.ingest?.list() || [], this.ingest?.benchWikiFiles?.() || [],
      this.pieces?.board() || { pieces: [] }, this.settings?.read ? this.settings.read() : this.settings || {},
    ])
    const effects = sourceEffects({ links, events, pieces: board.pieces, threshold: settings.threshold ?? 3000 })
    const now = this.now()
    const cached = prunePosts([...this.posts.values()], now).filter(row => !row.expired)
    const baselines = new Map(accounts.map(account => [keyOf(account.handle), baselineFor(cached, account.handle, now)]))
    const posts = cached.map(row => {
      const link = links.filter(link => link.kind === 'bench' && link.path === row.savedPath)
      const latest = list => list.reduce((found, item) => !found || String(item.createdAt || '') > String(found.createdAt || '') ? item : found, null)
      const wikiJob = latest(wikiJobs.filter(job => row.savedPath && (job.path === row.savedPath || job.file === join(this.vault.root, row.savedPath))))
      const wikiDone = wikiFiles.some(file => file.path === row.savedPath)
      const outputs = [...new Set(link.flatMap(link => link.atoms || []))]
      const status = row.savedPath ? '已存入' : row.status
      return { ...row, textComplete: row.savedPath ? row.originalTextComplete === true : row.textComplete, status, ...postRatios(row, baselines.get(keyOf(row.handle))), outputs, wikiStatus: wikiDone ? 'done' : wikiJob?.status || null }
    }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    return {
      accounts: accounts.map(account => {
        const own = posts.filter(row => keyOf(row.handle) === keyOf(account.handle))
        const recent = own.filter(row => !row.history && validDate(row.createdAt) && new Date(row.createdAt).getTime() >= now.getTime() - 30 * DAY_MS && new Date(row.createdAt) <= now)
        const record = this.state.accounts[keyOf(account.handle)] || {}
        const latest = own.map(row => row.fetchedAt).filter(Boolean).sort().at(-1)
        const newer = latest && (!record.lastReadAt || latest > record.lastReadAt)
        return { ...account, baseline: baselines.get(keyOf(account.handle)), averagePerDay: recent.length / 30, lastReadAt: newer ? latest : record.lastReadAt || null, count: newer ? own.filter(row => row.fetchedAt === latest).length : record.count ?? 0, missed: record.missed ?? 0, failed: record.failed || [], error: record.error || null,
          lastSuccessAt: successOf(record), lastAttemptAt: record.attemptedAt || record.lastReadAt || null,
          added: record.added ?? (record.lastReadAt && !record.error && record.count === 0 ? 0 : null),
          effects: Object.entries(effects).find(([handle]) => keyOf(handle) === keyOf(account.handle))?.[1] || { atoms: 0, confirmed: 0, rejected: 0, shorts: 0, verified: 0 }, distributions: postDistributions(own) }
      }),
      posts, refresh: { lastRunAt: this.state.lastRunAt, lastDailyAt: this.state.lastDailyAt, error: this.state.error || null, ...this.progress, results: this.progress.running ? this.progress.results : this.state.results || [] }, historyImports: this.state.historyImports,
    }
  }
}
