// 本人账号：正本只在保存和手动读取填空时改；内容和互动只写工作台数据目录。
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMonidRunner, resolveAccount } from './monid.js'
import { MonidBudget, armRefresh } from './xrefresh.js'
import { localDay } from './todo.js'
import { tr } from './i18n.js'
import { httpError } from './vault.js'
import { KEY_PATTERN, OWN_SOURCE, mutateOwnSource, newOwnKey, parseOwnSource, patchOwnRow, readOwnSource } from './own-source.js'
import { assertUnique, checkFields, identifierFor, platformForm, platformSpec, sameField } from './own-platforms.js'
import { OWN_ENDPOINTS, estimateManual, monidArgs, readResolve, resolveStillFresh } from './own-monid.js'

export { OWN_SOURCE }

const FIELDS = ['displayName', 'handle', 'url']

function reasonFor(row, identifier) {
  const endpoint = OWN_ENDPOINTS[row.platform]
  const readable = Boolean(identifier && (endpoint?.posts || row.platform === 'X'))
  if (readable) return ''
  if (row.platform === '播客') return '未注册'
  if (row.platform === '今日头条') return '已核实 token 转 ID 端点，未找到账号内容列表端点'
  if (row.platform === 'Substack') return '缺 publication 主页链接'
  if (endpoint?.posts || row.platform === 'X') return '缺主页链接'
  return '暂无可用读取端点'
}

function decorate(row) {
  const identifier = identifierFor(row)
  return {
    ...row,
    identifier,
    readable: Boolean(identifier && (OWN_ENDPOINTS[row.platform]?.posts || row.platform === 'X')),
    reason: reasonFor(row, identifier),
    alignable: Boolean(OWN_ENDPOINTS[row.platform]?.profile),
    form: platformForm(row.platform),
  }
}

export function parseOwnAccounts(markdown) {
  return parseOwnSource(markdown).rows.map(decorate)
}

function count(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(String(value).replace(/,/g, ''))
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

function timestamp(value) {
  if (value == null || value === '') return null
  const numeric = typeof value === 'number' ? value : NaN
  const ms = Number.isFinite(numeric) ? numeric * (numeric < 1e12 ? 1000 : 1) : Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function publicUrl(raw) {
  try { const url = new URL(raw); return ['https:', 'http:'].includes(url.protocol) ? url.toString() : '' } catch { return '' }
}

/** 用实测字段；未知形状报错，缺指标保留 null，不把缺值当零。 */
export function normalizeOwnPosts(platform, output) {
  if (!output) throw new Error('平台没有返回内容')
  const data = output.data ?? output
  let rows
  if (platform === '公众号') rows = output.articles
  else if (platform === '视频号') rows = output.videos
  else if (platform === '知乎') rows = Array.isArray(data) ? data : data.data
  else if (platform === 'YouTube') rows = output.videos_results
  else if (platform === 'Substack') rows = output.posts
  else if (platform === 'LinkedIn') rows = output
  else if (platform === 'GitHub') rows = data.repos
  else if (platform === '小红书') rows = data.notes
  else if (platform === '抖音') rows = output.aweme_list
  else if (platform === 'X') rows = output
  if (!Array.isArray(rows)) throw new Error('平台返回的内容格式无法识别')
  return rows.filter(row => row && typeof row === 'object' && !(platform === 'LinkedIn' && row.repostedAt) && !(platform === 'X' && ['转推', '回复'].includes(row.kind))).map(row => {
    const stat = row.statistics || row.engagement || row
    const rawId = row.id ?? row.video_id ?? row.aweme_id ?? row.app_msg_id
    const id = typeof rawId === 'number' && !Number.isSafeInteger(rawId) ? '' : String(rawId ?? '')
    const title = String(row.title ?? row.name ?? row.desc ?? row.content ?? row.text ?? '').split('\n')[0].trim()
    const views = count(stat.read_count ?? stat.view_count ?? stat.play_count ?? stat.extracted_views ?? stat.views)
    return {
      id: platform === '公众号' && id ? `${id}:${row.idx ?? 1}` : id,
      title, url: publicUrl(row.url ?? row.link ?? row.linkedinUrl ?? (platform === '小红书' && id ? `https://www.xiaohongshu.com/explore/${id}` : platform === '抖音' && id ? `https://www.douyin.com/video/${id}` : '')),
      publishedAt: timestamp(row.create_time ?? row.created ?? row.created_time ?? row.published_at ?? row.postedAt?.date ?? row.updatedAt ?? row.createdAt),
      views: platform === '视频号' && views === 0 ? null : views,
      likes: count(stat.like_count ?? stat.likes ?? stat.voteup_count ?? stat.digg_count ?? stat.reaction_count),
      comments: count(stat.comment_count ?? stat.comments_count ?? stat.comments ?? stat.replies),
      saves: count(stat.fav_count ?? stat.collected_count ?? stat.collect_count ?? stat.bookmarks),
      shares: count(stat.forward_count ?? stat.share_count ?? stat.shares ?? stat.reposts),
      stars: count(stat.stars), forks: count(stat.forks),
    }
  }).filter(row => row.id)
}

export function canonicalOwnUrl(raw) {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.protocol = 'https:'
    url.hash = ''
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|scene$|sessionid$|chksm$|source$|feature$|si$)/.test(key)) url.searchParams.delete(key)
    url.searchParams.sort()
    url.pathname = url.pathname.replace(/\/$/, '') || '/'
    return url.toString()
  } catch { return '' }
}

/** 只匹配已有分发链接的稿件；标题全等且唯一才可回退，绝不模糊匹配。 */
export function matchOwnMetrics(pieces, posts, at) {
  const metrics = []
  for (const piece of pieces || []) {
    if (piece.status === '进行中') continue
    for (const dist of piece.distributions || []) {
      const link = canonicalOwnUrl(dist.url)
      if (!link) continue
      const platformPosts = posts.filter(post => post.platform === dist.platform)
      const linked = platformPosts.filter(post => canonicalOwnUrl(post.url) === link)
      const titled = linked.length ? linked : platformPosts.filter(post => post.title && post.title === piece.title)
      if (titled.length !== 1) continue
      const post = titled[0]
      metrics.push({ ...post, at, note: piece.note, postId: post.id, matchedBy: linked.length ? 'url' : 'title' })
    }
  }
  return metrics
}

export function ownRefreshDue({ now = new Date(), lastRunAt, enabled = true } = {}) {
  const at = now instanceof Date ? now : new Date(now)
  if (!enabled || !Number.isFinite(at.getTime()) || at.getHours() < 8) return false
  const last = new Date(lastRunAt || NaN)
  return !Number.isFinite(last.getTime()) || localDay(last) < localDay(at)
}

export function armOwnRefresh(own, options) { return armRefresh({ maybeRun: () => own.checkDaily() }, options) }

async function jsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (err) { if (err.code === 'ENOENT') return fallback; throw err }
}
async function jsonLines(file) {
  let text
  try { text = await readFile(file, 'utf8') } catch (err) { if (err.code === 'ENOENT') return []; throw err }
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
}
function byPublishedDesc(a, b) {
  const left = String(a.publishedAt || '')
  const right = String(b.publishedAt || '')
  if (Boolean(left) !== Boolean(right)) return left ? -1 : 1
  return right.localeCompare(left)
}
function postsFor(stored, accountId) {
  return stored.filter(post => post.accountId === accountId).sort(byPublishedDesc)
}
const WEEK_MS = 7 * 24 * 3600 * 1000
const ENGAGEMENT_KEYS = ['likes', 'comments', 'saves', 'shares', 'stars', 'forks']
/** 近 12 周每周发布数，按距现在的整周往回数，最后一格是最近 7 天。 */
export function weeklyActivity(posts, now, weeks = 12) {
  const counts = Array(weeks).fill(0)
  for (const post of posts) {
    const time = Date.parse(post.publishedAt || '')
    if (!Number.isFinite(time) || time > now) continue
    const age = Math.floor((now - time) / WEEK_MS)
    if (age < weeks) counts[weeks - 1 - age] += 1
  }
  return counts
}
/** 已读内容的互动合计；没有任何已知互动数时为 null。 */
export function engagementTotal(posts) {
  let total = null
  for (const post of posts) for (const key of ENGAGEMENT_KEYS) if (post[key] != null) total = (total || 0) + Number(post[key])
  return total
}
function clip(err) {
  return String(err?.message || err).slice(0, 200)
}
function blank(row, field) {
  return field === 'url' ? !row.url : !row[field]
}
function usedKeys(source, state, posts) {
  const used = new Set()
  for (const row of source.rows) if (row.key) used.add(row.key)
  for (const key of Object.keys(state.accounts || {})) if (KEY_PATTERN.test(key)) used.add(key)
  for (const post of posts) if (KEY_PATTERN.test(post.accountId)) used.add(post.accountId)
  return used
}
function reuseKey(row, cleaned, source, state) {
  const identifier = identifierFor({ platform: row.platform, ...cleaned })
  if (!identifier) return ''
  const present = new Set(source.rows.map(item => item.key).filter(Boolean))
  const matches = Object.entries(state.accounts || {}).filter(([key, record]) => KEY_PATTERN.test(key) && !present.has(key) && record?.platform === row.platform && record.identifier === identifier).map(([key]) => key)
  return matches.length === 1 ? matches[0] : ''
}
function acceptField(account, field, value) {
  if (!value) return ''
  try {
    const merged = { displayName: account.displayName, handle: account.handle, url: account.url, [field]: value }
    const cleaned = checkFields(account.platform, merged)
    return cleaned[field] || ''
  } catch { return '' }
}

export class OwnAccounts {
  constructor({ vault, settings, dataDir, pieces, monid = createMonidRunner(), grokx, monitor, now = () => new Date() }) {
    this.vault = vault
    this.settings = settings
    this.dataDir = dataDir
    this.dir = join(dataDir, 'own')
    this.pieces = pieces
    this.monid = monid
    this.grokx = grokx
    this.monitor = monitor
    this.now = now
    this.budget = new MonidBudget({ dataDir, settings, now })
    this.inflight = null
  }

  async accounts() {
    const settings = await this.settings.read()
    return parseOwnAccounts(await readOwnSource(settings.vaultRoot))
  }

  async state() { return jsonFile(join(this.dir, 'state.json'), { lastRunAt: null, accounts: {} }) }

  async save(name, value) {
    await mkdir(this.dir, { recursive: true })
    const file = join(this.dir, name)
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, value)
    await rename(tmp, file)
  }

  present(account, state, stored, limit) {
    const sorted = postsFor(stored, account.id)
    const record = state.accounts?.[account.id]
    const derived = account.platform === '抖音' && account.handle && !account.identifier ? { state: 'unsupported', count: 0, handle: account.handle } : null
    return {
      ...account,
      reason: tr(account.reason),
      lastReadAt: record?.lastReadAt || null,
      lastError: record?.lastError ? tr(record.lastError) : null,
      profileError: record?.profileError ? tr(record.profileError) : null,
      resolve: record?.resolve || derived,
      observed: record?.observed || null,
      filled: Array.isArray(record?.filled) ? record.filled : [],
      posts: limit == null ? sorted : sorted.slice(0, limit),
      postCount: sorted.length,
      latestAt: sorted.find(post => post.publishedAt)?.publishedAt || null,
      weekly: weeklyActivity(sorted, this.now().getTime()),
      engagement: engagementTotal(sorted),
    }
  }

  async storedPosts() {
    const posts = await jsonLines(join(this.dir, 'posts.jsonl'))
    if (!this.monitor) return posts
    const merged = new Map(posts.map(row => [`${row.accountId}:${row.id}`, row]))
    for (const account of await this.accounts()) for (const row of await this.monitor.ownRows(account.id)) {
      const key = `${row.accountId}:${row.id}`
      merged.set(key, { ...merged.get(key), ...row })
    }
    return [...merged.values()]
  }

  async read() {
    const [accounts, state, posts, budget] = await Promise.all([this.accounts(), this.state(), this.storedPosts(), this.budget.read()])
    return {
      ...budget,
      running: Boolean(this.inflight),
      lastRunAt: state.lastRunAt || null,
      lastError: state.lastError ? tr(state.lastError) : null,
      manualEstimateUsd: estimateManual(accounts),
      lastManual: state.lastManual || null,
      accounts: accounts.map(account => this.present(account, state, posts, 5)),
    }
  }

  async posts(id) {
    const [accounts, state, stored] = await Promise.all([this.accounts(), this.state(), this.storedPosts()])
    const account = accounts.find(row => row.id === id)
    if (!account) throw httpError(404, '账号不存在')
    return this.present(account, state, stored)
  }

  async latest(note) {
    const latest = new Map()
    for (const row of await jsonLines(join(this.dir, 'metrics.jsonl'))) if (row.note === note) latest.set(`${row.platform}:${row.accountId}`, row)
    if (this.monitor) for (const row of await this.monitor.latestOwn(note)) latest.set(`${row.platform}:${row.accountId}`, row)
    return [...latest.values()]
  }

  async callMonid(spec, input, at) {
    const response = await this.budget.run(spec.cost, () => this.monid(monidArgs(spec, input), 150), new Date(at))
    if (!response) throw new Error('还没有安装 Monid')
    if (response.error || response.status !== 'COMPLETED' || response.providerResponse?.httpStatus >= 400) {
      throw new Error(response.error?.message || response.providerResponse?.error?.error || `Monid 读取失败（${response.providerResponse?.httpStatus || response.status}）`)
    }
    return response.output
  }

  async fetchPosts(account, identifier, at) {
    if (this.monitor) {
      const result = await this.monitor.collect(account.id, {
        purpose: 'posts', sinceDays: account.platform === 'X' ? 3 : 30,
        ...(identifier && identifier !== account.identifier ? { identifierOverride: identifier } : {}),
      })
      const posts = new Map(result.posts.map(post => [post.postKey, post]))
      return result.samples.flatMap(sample => {
        const post = posts.get(sample.postKey)
        return post ? [{ id: post.postId, title: post.title, url: post.url, publishedAt: post.publishedAt, fetchedAt: sample.observedAt, ...sample.values }] : []
      })
    }
    if (account.platform === 'X') {
      if (!this.grokx) throw new Error('Grok 读取器尚未就绪')
      return normalizeOwnPosts('X', await this.grokx.listRecent(identifier, { sinceDays: 3 }))
    }
    const endpoint = OWN_ENDPOINTS[account.platform]?.posts
    if (!endpoint) return []
    return normalizeOwnPosts(account.platform, await this.callMonid(endpoint, identifier, at))
  }

  async fetchProfile(account, identifier, at) {
    const spec = OWN_ENDPOINTS[account.platform]?.profile
    if (!spec) return { ok: false, error: '平台返回的内容格式无法识别' }
    let output, profile
    if (spec.steps) {
      const userId = spec.steps[0].read(await this.callMonid(spec.steps[0], account.url, at))
      if (!userId) return { ok: false, error: '平台返回的内容格式无法识别' }
      identifier = userId
      output = await this.callMonid(spec.steps[1], identifier, at)
      profile = spec.steps[1].read(output, identifier)
    } else {
      if (!identifier) return { ok: false, error: '平台返回的内容格式无法识别' }
      output = await this.callMonid(spec, identifier, at)
      profile = spec.read(output, identifier)
    }
    if (profile.ok && this.monitor) await this.monitor.ingestProfile(account.id, account.platform, identifier, output, this.now().toISOString())
    return profile
  }

  async saveAccount(body = {}) {
    if (!body || typeof body !== 'object' || typeof body.id !== 'string' || !body.id || typeof body.rowRev !== 'string' || !body.rowRev) throw httpError(400, '账号资料无效')
    if (!Object.hasOwn(body, 'displayName') || !Object.hasOwn(body, 'handle') || !Object.hasOwn(body, 'url')) throw httpError(400, '账号资料无效')
    const settings = await this.settings.read()
    const before = parseOwnSource(await readOwnSource(settings.vaultRoot))
    const row = before.rows.find(item => item.id === body.id)
    if (!row) throw httpError(404, '账号不存在')
    if (row.rowRev !== body.rowRev) throw httpError(409, '账号资料已在别处修改，已载入最新内容')
    let url = body.url
    const spec = platformSpec(row.platform)
    if (spec?.link?.resolvable && typeof url === 'string' && url.trim() && !spec.link.parse(url)) {
      const resolved = await resolveAccount(url)
      if (resolved.platform !== row.platform) throw httpError(400, '请填这个平台的账号主页链接')
      url = resolved.url
    }
    const cleaned = checkFields(row.platform, { displayName: body.displayName, handle: body.handle, url })
    assertUnique(before.rows, { id: row.id, platform: row.platform, ...cleaned })
    const state = await this.state()
    const stored = await jsonLines(join(this.dir, 'posts.jsonl'))
    const taken = usedKeys(before, state, stored)
    let key = row.registered ? row.key : reuseKey(row, cleaned, before, state) || newOwnKey(taken)
    await mutateOwnSource(settings.vaultRoot, markdown => {
      const current = parseOwnSource(markdown)
      const currentRow = current.rows.find(item => item.id === body.id)
      if (!currentRow) throw httpError(body.id.startsWith('row:') ? 409 : 404, body.id.startsWith('row:') ? '账号资料已在别处修改，已载入最新内容' : '账号不存在')
      assertUnique(current.rows, { id: currentRow.id, platform: currentRow.platform, ...cleaned })
      let useKey = key
      if (!currentRow.registered && current.rows.some(item => item.key === useKey)) useKey = newOwnKey([...taken, ...current.rows.map(item => item.key)])
      key = currentRow.registered ? currentRow.key : useKey
      return patchOwnRow(markdown, {
        id: body.id,
        rowRev: body.rowRev,
        set: { displayName: cleaned.displayName, handle: cleaned.handle, url: cleaned.url, ...(currentRow.registered ? {} : { key: useKey }) },
      })
    })
    if (key !== body.id) await this.retarget(body.id, key)
    const record = { ...(state.accounts?.[key] || state.accounts?.[body.id] || {}) }
    if (cleaned.handle !== row.handle || cleaned.url !== row.url) delete record.resolve
    record.filled = (record.filled || []).filter(field => cleaned[field] === row[field])
    record.platform = row.platform
    record.identifier = identifierFor({ platform: row.platform, ...cleaned })
    state.accounts = { ...(state.accounts || {}), [key]: record }
    if (key !== body.id) delete state.accounts[body.id]
    await this.save('state.json', JSON.stringify(state, null, 2))
    return { ...await this.read(), saved: key }
  }

  async retarget(fromId, toId) {
    if (this.monitor || !toId || fromId === toId) return
    for (const name of ['posts.jsonl', 'metrics.jsonl']) {
      const rows = await jsonLines(join(this.dir, name))
      let changed = false
      for (const row of rows) if (row.accountId === fromId) { row.accountId = toId; changed = true }
      if (changed) await this.save(name, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    }
  }

  async applyFills(fills) {
    if (!fills.length) return []
    const settings = await this.settings.read()
    const applied = []
    await mutateOwnSource(settings.vaultRoot, markdown => {
      let next = markdown
      for (const fill of fills) {
        try {
          const current = parseOwnSource(next)
          const row = current.rows.find(item => item.id === fill.id)
          if (!row || row.rowRev !== fill.rowRev) continue
          const set = {}
          for (const field of FIELDS) if (fill.set[field] && blank(row, field)) set[field] = fill.set[field]
          if (!Object.keys(set).length) continue
          const checked = checkFields(row.platform, { displayName: row.displayName, handle: row.handle, url: row.url, ...set })
          const safe = {}
          for (const field of Object.keys(set)) if (checked[field] && sameField(row.platform, field, checked[field], set[field])) safe[field] = checked[field]
          if (!Object.keys(safe).length) continue
          assertUnique(current.rows, { id: row.id, platform: row.platform, displayName: checked.displayName, handle: checked.handle, url: checked.url })
          const patched = patchOwnRow(next, { id: row.id, rowRev: row.rowRev, set: safe })
          if (patched === next) continue
          next = patched
          applied.push({ id: row.id, fields: Object.keys(safe) })
        } catch { /* 这一行这次不填 */ }
      }
      return next === markdown ? null : next
    })
    return applied
  }

  shouldTouch(account, manual) {
    if (!account.registered) return false
    if (!manual) return account.readable
    if (account.readable) return true
    if (OWN_ENDPOINTS[account.platform]?.resolve && account.handle && !account.identifier) return true
    if (account.platform === '抖音' && account.handle && !account.identifier) return true
    if (account.platform === '今日头条' && account.url) return true
    return Boolean(OWN_ENDPOINTS[account.platform]?.profile && account.identifier)
  }

  async alignAccount(account, status, { manual, at, atDate }) {
    const endpoint = OWN_ENDPOINTS[account.platform]
    let identifier = account.identifier
    let searchName = ''
    let searchUrl = ''
    let profile = null
    const contentErrors = []
    if (manual && account.platform === '抖音' && !identifier && account.handle) {
      status.resolve = { handle: account.handle, state: 'unsupported', count: 0, at }
    }
    if (manual && endpoint?.resolve && !identifier && account.handle && !resolveStillFresh(status.resolve, account.handle, atDate)) {
      const found = readResolve(account.platform, await this.callMonid(endpoint.resolve, account.handle, at), account.handle)
      status.resolve = { handle: account.handle, state: found.state, count: found.count || 0, at }
      if (found.state === 'exact') {
        identifier = found.id
        searchName = found.name || ''
        searchUrl = found.url || ''
      }
    }
    const known = Boolean(account.identifier)
    let rows = []
    if (known && (endpoint?.posts || account.platform === 'X')) {
      try { rows = await this.fetchPosts(account, identifier, at) } catch (err) { contentErrors.push(err) }
    }
    if (manual && endpoint?.profile && (identifier || (account.platform === '今日头条' && account.url))) {
      try {
        profile = await this.fetchProfile(account, identifier, at)
        status.profileError = profile.ok ? null : profile.error
        if (!profile.ok && !known) identifier = ''
      } catch (err) {
        status.profileError = clip(err)
        profile = { ok: false, error: status.profileError }
        if (!known) identifier = ''
        if (account.platform === '今日头条') contentErrors.push(err)
      }
    }
    if (!known && identifier && profile?.ok && endpoint?.posts) {
      try { rows = await this.fetchPosts(account, identifier, at) } catch (err) { contentErrors.push(err) }
    }
    if (contentErrors.length) status.lastError = clip(contentErrors[0])
    else status.lastError = null
    if (profile?.ok) {
      const raw = {
        displayName: profile.displayName || searchName,
        handle: profile.handle || '',
        url: profile.url || searchUrl,
      }
      status.observed = { at, displayName: acceptField(account, 'displayName', raw.displayName), handle: acceptField(account, 'handle', raw.handle), url: acceptField(account, 'url', raw.url) }
      status.identifier = identifier || account.identifier
    } else if (profile && profile.error === 'Monid 返回的不是这个账号') {
      status.observed = null
      status.identifier = account.identifier
    }
    const set = {}
    if (manual && profile?.ok && status.observed) {
      try {
        const cleaned = checkFields(account.platform, {
          displayName: status.observed.displayName || account.displayName,
          handle: status.observed.handle || account.handle,
          url: status.observed.url || account.url,
        })
        for (const field of FIELDS) if (blank(account, field) && cleaned[field]) set[field] = cleaned[field]
      } catch { /* 不合规的值不填 */ }
    }
    const contentTried = (known && (endpoint?.posts || account.platform === 'X')) || (!known && profile?.ok && Boolean(endpoint?.posts))
    const toutiaoOk = account.platform === '今日头条' && Boolean(profile?.ok)
    return {
      rows, set,
      failed: contentErrors.length > 0 || (account.platform === '今日头条' && account.url && !profile?.ok),
      read: (!contentErrors.length && contentTried) || toutiaoOk,
    }
  }

  async checkDaily(now = this.now()) {
    if (this.monitor || this.inflight) return null
    const state = await this.state()
    if (!ownRefreshDue({ now, lastRunAt: state.lastRunAt })) return null
    return this.refresh({ manual: false, now })
  }

  refresh(input = {}) {
    if (this.inflight) return this.inflight
    const job = Promise.resolve().then(() => this._refresh(input)).catch(async err => {
      const now = input.now || this.now()
      const at = (now instanceof Date ? now : new Date(now)).toISOString()
      const state = await this.state()
      await this.save('state.json', JSON.stringify({ ...state, lastRunAt: at, lastError: clip(err) }, null, 2))
      throw err
    })
    this.inflight = job
    job.then(() => { if (this.inflight === job) this.inflight = null }, () => { if (this.inflight === job) this.inflight = null })
    return job
  }

  async startRefresh(input = {}) {
    if (input.id) {
      const accounts = await this.accounts()
      const account = accounts.find(row => row.id === input.id)
      if (!account) throw httpError(404, '账号不存在')
      if (input.manual && !account.registered) throw httpError(409, '保存一次后可读取')
    }
    this.refresh(input).catch(() => {})
    return this.read()
  }

  async _refresh({ id, manual = false, now = this.now() } = {}) {
    const atDate = now instanceof Date ? now : new Date(now)
    const at = atDate.toISOString()
    const accounts = await this.accounts()
    if (id && !accounts.some(account => account.id === id)) throw httpError(404, '账号不存在')
    if (manual && id && !accounts.find(account => account.id === id)?.registered) throw httpError(409, '保存一次后可读取')
    const state = await this.state()
    state.lastError = null
    const posts = new Map((await jsonLines(join(this.dir, 'posts.jsonl'))).map(post => [`${post.accountId}:${post.id}`, post]))
    const fresh = []
    const fills = []
    const failed = []
    let readCount = 0
    for (const account of accounts) {
      if (id && account.id !== id) continue
      if (!this.shouldTouch(account, manual)) continue
      const previous = state.accounts?.[account.id] || {}
      const status = { ...previous, platform: account.platform, identifier: account.identifier, lastReadAt: at, lastError: null }
      if (manual) status.profileError = null
      state.accounts[account.id] = status
      try {
        const result = await this.alignAccount(account, status, { manual, at, atDate })
        for (const row of result.rows) {
          const post = { ...row, accountId: account.id, platform: account.platform, fetchedAt: row.fetchedAt || at }
          posts.set(`${account.id}:${post.id}`, post)
          fresh.push(post)
        }
        if (Object.keys(result.set).length) fills.push({ id: account.id, rowRev: account.rowRev, set: result.set })
        if (result.failed) failed.push(account.id)
        else if (result.read) readCount += 1
      } catch (err) {
        status.lastError = clip(err)
        failed.push(account.id)
      }
    }
    const applied = manual ? await this.applyFills(fills) : []
    let filledCount = 0
    for (const item of applied) {
      const status = state.accounts[item.id]
      if (status) status.filled = item.fields
      filledCount += item.fields.length
    }
    if (!id) state.lastRunAt = at
    if (manual) state.lastManual = { at, read: readCount, failed, filled: filledCount }
    if (!this.monitor) await this.save('posts.jsonl', [...posts.values()].map(post => JSON.stringify(post)).join('\n') + (posts.size ? '\n' : ''))
    await this.save('state.json', JSON.stringify(state, null, 2))
    const pieces = typeof this.pieces === 'function' ? this.pieces() : this.pieces
    if (pieces && !this.monitor) {
      const board = await pieces.board()
      const metrics = matchOwnMetrics(board.pieces, fresh, at)
      if (metrics.length) await appendFile(join(this.dir, 'metrics.jsonl'), metrics.map(row => JSON.stringify(row)).join('\n') + '\n')
    }
    return { ...await this.read(), running: false }
  }
}
