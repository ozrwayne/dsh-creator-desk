import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { checkFields, identifierFor } from './own-platforms.js'
import { MonidBudget, normalizeXRefresh } from './xrefresh.js'
import { localDay } from './todo.js'
import { readMetrics } from './metrics.js'
import { MonitorCollectors, PLATFORM_COVERAGE, collectorSpec, normalizedLegacy, normalizeMonitorPosts, followerValue } from './monitor-collectors.js'
import { MonitorStore, atomicLines, readLines, readJson, fileLock, recoverLock } from './monitor-store.js'
import { MonitorBrowser, BROWSER_PLATFORMS } from './monitor-browser.js'
import { DAY, hash, zone, errorOf, observation, dailySeries, followerObservation, followerDaily, reconstructFollowers, countValue, cohort } from './monitor-model.js'

const identityKey = (platform, value) => JSON.stringify([platform, ['X', 'GitHub', '知乎'].includes(platform) ? String(value).toLowerCase() : value])
const publicRun = run => run && ({ runKey: run.runKey, accountId: run.accountId, purpose: run.purpose, at: run.at, observedAt: run.observedAt, status: run.status, error: run.error, code: run.code, count: run.samples?.length || 0, price: run.price, requestId: run.requestId, coverage: run.coverage })

function accountOf(row, role, at) {
  const platform = row.platform || 'X', handle = row.handle || ''
  const homeUrl = row.url || (platform === 'X' ? `https://x.com/${handle}` : '')
  const identifier = row.identifier || identifierFor({ platform, handle, url: homeUrl })
  return {
    schemaVersion: 1, accountId: row.id || `bench-${hash([platform, handle.toLowerCase()]).slice(0, 12)}`,
    roles: [role], platform, displayName: row.displayName || row.name || handle || platform, handle, homeUrl,
    identity: { kind: 'platform_identifier', value: identifier, status: identifier ? 'request_bound' : 'missing', verifiedAt: null },
    sourceRef: { kind: role, path: row.path || null, key: row.id || handle },
    enabled: role === 'own' ? Boolean(row.registered && row.readable) : Boolean(row.enabled),
    contentKinds: [], collectors: { postIds: collectorSpec(platform)?.collectorId ? [collectorSpec(platform).collectorId] : [], followerIds: [], allowPaidFallback: false },
    schedule: { recentHours: 24, recentDays: 7, regularHours: 24, lookbackDays: 30, maxPages: 1 },
    collectFollowers: false, allowPaid: role === 'own', browserProfileRef: null, timeZone: zone(),
    createdAt: at, updatedAt: at, revision: 1,
  }
}

export class Monitor {
  constructor({ dataDir, settings, ownAccounts, benchAccounts, monid, grokx, now = () => new Date() }) {
    this.dataDir = dataDir; this.settings = settings; this.ownAccounts = ownAccounts; this.benchAccounts = benchAccounts; this.now = now
    this.store = new MonitorStore(dataDir)
    this.budget = new MonidBudget({ dataDir, settings, now })
    this.collectors = new MonitorCollectors({ monid, grokx, budget: this.budget, now })
    this.chain = Promise.resolve(); this.inflight = new Map(); this.bootstrapPromise = null; this.startupError = null
    this.lastTick = null
  }

  mutate(task) { const pending = this.chain.then(task, task); this.chain = pending.catch(() => {}); return pending }

  async browserBindings() {
    const bindings = await readJson(join(this.store.root, 'browser-bindings.json'), [])
    if (!Array.isArray(bindings)) throw errorOf(500, '后台浏览器本地绑定格式无效', 'browser_bindings_invalid')
    return bindings
  }

  specFor(account, purpose) {
    if (!account.browserProfileRef) return collectorSpec(account.platform, purpose)
    const profile = account.browserProfiles?.find(row => row.profileRef === account.browserProfileRef)
    return profile?.[purpose] ? { collectorId: `cdp.${account.platform}.${purpose}.v1`, channel: 'cdp', cost: 0 } : null
  }

  async collectBound(account, purpose, options) {
    if (!account.browserProfileRef) return this.collectors.collect(account, purpose, options)
    const bindings = await this.browserBindings(), binding = bindings.find(row => row.profileRef === account.browserProfileRef && row.accountId === account.accountId && row.platform === account.platform && row.enabled)
    if (!binding || binding.identity?.value !== account.identity.value) throw errorOf(409, '后台会话绑定与账号不符', 'identity_mismatch')
    return new MonitorBrowser({ bindings, now: this.now }).collect({ ...account, identity: binding.identity }, purpose, options)
  }

  async accounts() {
    await this.store.load()
    const [own, bench, stored, settings, bindings] = await Promise.all([this.ownAccounts(), this.benchAccounts(), readLines(join(this.store.root, 'accounts.jsonl')), this.settings.read(), this.browserBindings()])
    const at = this.now().toISOString(), rows = new Map(), identities = new Map()
    const nowMs = Date.parse(at)
    const xConfig = normalizeXRefresh(settings.xRefresh)
    const xOwn = xConfig.accounts.map(row => ({ ...accountOf({ id: `own-x-${hash(row.handle.toLowerCase()).slice(0, 12)}`, platform: 'X', displayName: row.account, handle: row.handle, registered: true, readable: xConfig.enabled }, 'own', at), sourceRef: { kind: 'x-refresh', path: 'settings.json', key: row.handle } }))
    for (const source of [...own.map(row => accountOf(row, 'own', at)), ...xOwn, ...bench.map(row => accountOf(row, 'bench', at))]) {
      const key = source.identity.value ? identityKey(source.platform, source.identity.value) : source.accountId
      const existing = identities.get(key)
      if (existing) { existing.roles = [...new Set([...existing.roles, ...source.roles])]; existing.enabled ||= source.enabled; continue }
      rows.set(source.accountId, source); identities.set(key, source)
    }
    for (const saved of stored) {
      const current = rows.get(saved.accountId) || identities.get(identityKey(saved.platform, saved.identity.value))
      if (current) {
        // 账号身份以原档案为准。历史观察保留旧绑定；资料变化时停止沿用旧采集缓存。
        Object.assign(current, {
          roles: [...new Set([...current.roles, ...saved.roles])], enabled: saved.enabled,
          schedule: saved.schedule, collectFollowers: saved.collectFollowers, allowPaid: saved.allowPaid,
          createdAt: saved.createdAt, updatedAt: saved.updatedAt, revision: saved.revision,
          browserProfileRef: saved.browserProfileRef || null,
        })
      } else if (saved.sourceRef.kind === 'monitor') { rows.set(saved.accountId, saved); identities.set(identityKey(saved.platform, saved.identity.value), saved) }
    }
    return [...rows.values()].map(row => {
      const browserProfiles = row.roles.includes('own') ? bindings.filter(binding => binding.enabled && binding.accountId === row.accountId && binding.platform === row.platform && binding.identity?.value && binding.identity.value === (row.identity.value || row.handle)).map(binding => ({ profileRef: binding.profileRef, label: binding.label || `${binding.platform} · ${binding.profileRef}`, platform: binding.platform, posts: Boolean(BROWSER_PLATFORMS.find(p => p.platform === binding.platform)?.posts), followers: Boolean(BROWSER_PLATFORMS.find(p => p.platform === binding.platform)?.followers) })) : []
      const selectedProfile = browserProfiles.find(profile => profile.profileRef === row.browserProfileRef)
      if (selectedProfile && !row.identity.value) row.identity = { ...row.identity, value: bindings.find(binding => binding.profileRef === selectedProfile.profileRef).identity.value, status: 'request_bound' }
      const posts = this.store.accountPosts(row.accountId)
      const runs = [...this.store.runs.values()].filter(run => run.accountId === row.accountId)
      const lastRun = runs.at(-1), latest = followerDaily(this.store.followers.filter(item => item.accountId === row.accountId)).at(-1)
      const lastPosts = runs.findLast(run => run.purpose === 'posts')
      const successfulPosts = runs.findLast(run => run.purpose === 'posts' && run.status === 'committed')
      const recentPosts = posts.some(p => { const age = nowMs - Date.parse(p.publishedAt); return age >= 0 && age <= 7 * DAY })
      return { ...row, collectors: { ...row.collectors, followerIds: row.collectFollowers && collectorSpec(row.platform, 'followers') ? [collectorSpec(row.platform, 'followers').collectorId] : [] }, postCount: posts.length, lastRun: publicRun(lastRun), latestFollowers: latest || null,
        lastPostsRead: publicRun(lastPosts), lastPostsSuccessAt: successfulPosts?.observedAt || successfulPosts?.at || null,
        postsIntervalHours: recentPosts ? row.schedule.recentHours : 24,
        browserProfiles,
        capabilities: row.browserProfileRef ? { posts: Boolean(selectedProfile?.posts), followers: Boolean(selectedProfile?.followers) } : { posts: Boolean(collectorSpec(row.platform)), followers: Boolean(PLATFORM_COVERAGE.find(p => p.platform === row.platform)?.followers) },
        estimate: { postsUsd: row.browserProfileRef ? 0 : collectorSpec(row.platform)?.cost ?? null, followersUsd: row.browserProfileRef ? 0 : collectorSpec(row.platform, 'followers')?.cost ?? null },
      }
    })
  }

  async requireAccount(id) {
    const account = (await this.accounts()).find(row => row.accountId === id)
    if (!account) throw errorOf(404, '找不到这个监控账号', 'account_missing')
    return account
  }

  async saveAccount(body) {
    return this.mutate(() => fileLock(join(this.store.root, 'collector.lock'), async () => {
      const accounts = await this.accounts(), at = this.now().toISOString()
      let account = body.accountId ? accounts.find(row => row.accountId === body.accountId) : null
      if (body.accountId && !account) throw errorOf(404, '找不到这个监控账号')
      if (account && body.revision !== account.revision) throw errorOf(409, '账号设置已变化，请重新载入', 'revision_conflict')
      if (!account) {
        if (!PLATFORM_COVERAGE.some(row => row.platform === body.platform)) throw errorOf(400, '不认识的平台')
        const fields = checkFields(body.platform, { displayName: body.displayName, handle: body.handle, url: body.homeUrl })
        const value = identifierFor({ platform: body.platform, ...fields })
        if (!value) throw errorOf(400, '需要可验证的账号 ID 或主页链接')
        account = accounts.find(row => identityKey(row.platform, row.identity.value) === identityKey(body.platform, value))
        if (account) {
          account = { ...account, roles: [...new Set([...account.roles, 'bench'])] }
          // 新建表单命中已有身份只添加角色，不能绕过 revision 覆盖已有授权。
          body = { accountId: account.accountId, revision: account.revision }
        }
        else account = { ...accountOf({ id: `bench-${randomUUID()}`, platform: body.platform, ...fields, registered: true, readable: true, enabled: true }, 'bench', at), sourceRef: { kind: 'monitor', path: 'monitor/accounts.jsonl', key: value }, allowPaid: false }
      } else if (body.platform || body.handle || body.homeUrl || body.displayName) {
        throw errorOf(400, account.roles.includes('own') ? '自有账号资料请在原账号编辑器修改' : '账号身份不能覆盖；新身份请添加新账号')
      }
      if (body.enabled != null && typeof body.enabled !== 'boolean') throw errorOf(400, '启用状态无效')
      if (body.collectFollowers != null && typeof body.collectFollowers !== 'boolean') throw errorOf(400, '粉丝采集设置无效')
      const nextProfile = body.browserProfileRef === undefined ? account.browserProfileRef : body.browserProfileRef
      if (nextProfile !== null && (typeof nextProfile !== 'string' || !account.browserProfiles?.some(row => row.profileRef === nextProfile))) throw errorOf(400, '请选择本地已绑定的后台会话')
      const followerSupported = nextProfile ? account.browserProfiles.find(row => row.profileRef === nextProfile).followers : PLATFORM_COVERAGE.find(p => p.platform === account.platform)?.followers
      if ((body.collectFollowers ?? account.collectFollowers) && !followerSupported) throw errorOf(409, '此来源尚无经过校验的粉丝采集器')
      if (body.recentHours != null && ![6, 24].includes(body.recentHours)) throw errorOf(400, '采样间隔只支持 6 或 24 小时')
      if (body.allowPaid != null && typeof body.allowPaid !== 'boolean') throw errorOf(400, '付费设置无效')
      const saved = {
        ...account, enabled: body.enabled ?? account.enabled, collectFollowers: body.collectFollowers ?? account.collectFollowers,
        allowPaid: body.allowPaid ?? account.allowPaid,
        browserProfileRef: nextProfile,
        schedule: { ...account.schedule, recentHours: body.recentHours ?? account.schedule.recentHours },
        revision: account.revision + 1, updatedAt: at,
      }
      for (const key of ['capabilities', 'postCount', 'lastRun', 'latestFollowers', 'estimate', 'browserProfiles']) delete saved[key]
      const stored = await readLines(join(this.store.root, 'accounts.jsonl'))
      await atomicLines(join(this.store.root, 'accounts.jsonl'), [...stored.filter(row => row.accountId !== saved.accountId), saved])
      return { account: (await this.accounts()).find(row => row.accountId === saved.accountId) }
    }))
  }

  bootstrap() {
    if (!this.bootstrapPromise) this.bootstrapPromise = this.mutate(() => fileLock(join(this.store.root, 'collector.lock'), async () => {
      await this.store.load()
      if (!this.store.runs.has('legacy-migration-v1')) await this.migrate()
      const state = await readJson(join(this.store.root, 'state.json'), {})
      if (state.eventCount !== this.store.events.length) await this.store.project(dailySeries)
      this.startupError = null
    })).catch(error => { this.startupError = error.message; throw error })
    return this.bootstrapPromise
  }

  async migrate() {
    const accounts = await this.accounts(), at = this.now().toISOString(), runKey = 'legacy-migration-v1'
    const summary = { schemaVersion: 1, runKey, at, status: 'committed', purpose: 'migration', posts: [], samples: [], followers: [], migratedSamples: 0, skipped: 0 }
    summary.sourceDigests = []
    for (const path of ['own/posts.jsonl', 'own/metrics.jsonl', 'bench/posts.jsonl', 'bench/metrics.jsonl', 'x-metrics.jsonl']) {
      let bytes = null
      try { bytes = await readFile(join(this.dataDir, path)) } catch (error) { if (error.code !== 'ENOENT') throw error }
      summary.sourceDigests.push({ path, sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null, inputRows: bytes ? bytes.toString('utf8').split('\n').filter(line => line.trim()).length : 0 })
    }
    summary.inputRows = summary.sourceDigests.reduce((sum, source) => sum + source.inputRows, 0)
    summary.duplicateRows = 0
    const pending = [], posts = new Map(), seen = new Set(), groups = new Map()
    const add = (account, raw, observedAt, source) => {
      if (!account || !Number.isFinite(Date.parse(observedAt)) || !String(raw.id ?? raw.tweetId ?? raw.postId ?? '')) { summary.skipped++; return }
      pending.push({ account, raw, observedAt, source })
    }
    const ownPosts = await readLines(join(this.dataDir, 'own/posts.jsonl'))
    for (const row of ownPosts) add(accounts.find(a => a.accountId === row.accountId), row, row.fetchedAt, 'legacy.own.posts')
    for (const row of await readLines(join(this.dataDir, 'own/metrics.jsonl'))) add(accounts.find(a => a.accountId === row.accountId), { ...ownPosts.find(p => p.accountId === row.accountId && p.id === row.postId), ...row, id: row.postId }, row.at, 'legacy.own.metrics')
    const benchPosts = await readLines(join(this.dataDir, 'bench/posts.jsonl'))
    const benchFor = handle => accounts.find(a => a.platform === 'X' && a.handle.toLowerCase() === String(handle).toLowerCase())
    for (const row of benchPosts) if (!row.expired && !row.history) add(benchFor(row.handle), row, row.fetchedAt, 'legacy.bench.posts')
    for (const row of await readLines(join(this.dataDir, 'bench/metrics.jsonl'))) add(benchFor(row.handle), { ...benchPosts.find(p => p.id === row.id), ...row }, row.at, 'legacy.bench.metrics')
    for (const row of await readLines(join(this.dataDir, 'x-metrics.jsonl'))) {
      const matches = ownPosts.filter(p => p.platform === 'X' && p.id === String(row.tweetId))
      add(matches.length === 1 ? accounts.find(a => a.accountId === matches[0].accountId) : null, { ...matches[0], ...row, id: row.tweetId }, row.at, 'legacy.x.metrics')
    }
    for (const { account, raw, observedAt, source } of pending.sort((a, b) => a.observedAt.localeCompare(b.observedAt))) {
      const row = normalizedLegacy(account.platform, raw), key = JSON.stringify([account.accountId, row.id])
      const groupKey = hash([runKey, account.accountId, observedAt, source]), dedupe = hash([groupKey, key])
      if (seen.has(dedupe)) { summary.duplicateRows++; continue }
      seen.add(dedupe)
      const result = observation(account, row, { runKey: groupKey, observedAt, collectorId: source, channel: 'legacy', measurementSet: `${account.platform}.legacy-counts.v1`, coverage: { complete: false, reason: 'legacy_latest_or_snapshot' }, legacy: true }, posts.get(key))
      posts.set(key, result.post)
      if (!groups.has(groupKey)) groups.set(groupKey, { schemaVersion: 1, runKey: groupKey, accountId: account.accountId, purpose: 'migration', at, observedAt, status: 'committed', posts: [], samples: [], followers: [] })
      groups.get(groupKey).posts.push(result.post); groups.get(groupKey).samples.push(result.sample)
      summary.migratedSamples++
    }
    for (const source of summary.sourceDigests) {
      let bytes = null
      try { bytes = await readFile(join(this.dataDir, source.path)) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if ((bytes ? createHash('sha256').update(bytes).digest('hex') : null) !== source.sha256) throw errorOf(409, '迁移期间原数据发生变化，未提交迁移', 'migration_source_changed')
    }
    summary.rejectedRows = summary.inputRows - summary.migratedSamples - summary.duplicateRows
    summary.skipped = summary.rejectedRows
    for (const event of groups.values()) if (!this.store.runs.has(event.runKey)) await this.store.event(event)
    await this.store.event(summary)
  }

  async collect(accountId, { purpose = 'posts', requestId = randomUUID(), automatic = false, sinceDays = 30, acknowledgeUnknown = false, identifierOverride } = {}) {
    if (!['posts', 'followers'].includes(purpose)) throw errorOf(400, '采集类型无效')
    if (typeof requestId !== 'string' || !/^[\w:-]{1,100}$/.test(requestId)) throw errorOf(400, '请求标识无效')
    const key = JSON.stringify([accountId, purpose, identifierOverride || ''])
    if (this.inflight.has(key)) return this.inflight.get(key).then(result => this.mutate(() => fileLock(join(this.store.root, 'collector.lock'), () => this.reuseRun(result, requestId))))
    const promise = this.mutate(() => fileLock(join(this.store.root, 'collector.lock'), async () => {
      // 进程间写入后重新读取事件账本，幂等检查以持锁后的状态为准。
      await this.store.reload()
      const account = await this.requireAccount(accountId)
      if (identifierOverride) {
        if (!account.roles.includes('own') || typeof identifierOverride !== 'string') throw errorOf(403, '内部身份覆盖只允许自有账号解析结果')
        account.identity = { ...account.identity, value: identifierOverride }
        account.enabled = true
      }
      if (!account.enabled) throw errorOf(409, '账号监控已关闭', 'account_disabled')
      const spec = this.specFor(account, purpose)
      if (!spec) throw errorOf(409, '此平台没有这类已验证采集器', 'unsupported_collector')
      if (spec.channel === 'monid' && !account.allowPaid) throw errorOf(403, '先在账号设置中授权现有月预算内的付费采集', 'paid_not_authorized')
      if (purpose === 'followers' && !account.collectFollowers) throw errorOf(403, '先启用此账号的粉丝采集', 'followers_not_enabled')
      const identity = identityKey(account.platform, account.identity.value)
      const previousIdentity = [...this.store.runs.values()].find(run => run.accountId === accountId && run.status === 'committed' && run.identity)?.identity
      if (previousIdentity && previousIdentity !== identity) throw errorOf(409, '历史观测属于另一个账号身份；请恢复原 ID 或新增账号记录，旧样本不搬家', 'identity_changed')
      const oldId = this.store.requestRuns.get(requestId), old = oldId && this.store.runs.get(oldId)
      if (old && (old.accountId !== accountId || old.purpose !== purpose || old.identity !== identity)) throw errorOf(409, '请求标识已用于其他任务或身份', 'request_conflict')
      const last = [...this.store.runs.values()].filter(run => run.accountId === accountId && run.purpose === purpose && run.identity === identity).at(-1)
      if (old?.status === 'committed') return { ...old, cached: true }
      if (old && old.status !== 'committed') throw errorOf(409, '该请求已记录；重试需新的请求标识并确认可能重复收费', 'request_already_attempted')
      const unknown = [...this.store.runs.values()].filter(run => run.accountId === accountId && (run.purpose === purpose || purpose === 'posts' && run.purpose === 'x-direct') && ['started', 'uncertain'].includes(run.status))
      if (unknown.length && !acknowledgeUnknown) throw errorOf(409, '上次请求结果未知，需人工确认后重试，可能重复收费', 'uncertain_run')
      const at = this.now().toISOString()
      if (last?.status === 'committed' && +this.now() - Date.parse(last.observedAt) < 10 * 60000) return this.reuseRun(last, requestId)
      const runKey = hash([identity, purpose, requestId])
      for (const run of unknown) await this.store.event({ ...run, status: 'acknowledged', resolvedBy: runKey, resolvedAt: at })
      const started = { schemaVersion: 1, runKey, requestId, accountId, identity, purpose, at, scheduledAt: at, automatic, status: 'started' }
      await this.store.event(started)
      let result
      try { result = await this.collectBound(account, purpose, { sinceDays }) } catch (error) {
        const uncertain = !error.code || error.code === 'uncertain_run' || /TIMEOUT|TIMEDOUT|ABORT|ECONNRESET/.test(error.code)
        await this.store.event({ ...started, status: uncertain ? 'uncertain' : 'failed', error: String(error.message).slice(0, 300), code: error.code || 'collector_failed' })
        throw error
      }
      const posts = [], samples = [], followers = []
      for (const row of result.rows) {
        const oldPost = this.store.posts.get(JSON.stringify([accountId, row.id]))
        const pair = observation(account, row, { ...started, observedAt: result.observedAt, ...result.spec, coverage: result.coverage }, oldPost)
        posts.push(pair.post); samples.push(pair.sample)
      }
      if (result.followers) {
        const meta = { ...started, observedAt: result.observedAt, collectorId: result.spec.collectorId }
        const follower = followerObservation(account, result.followers.raw, { ...meta, gain: result.followers.gain, loss: result.followers.loss, net: result.followers.net })
        if (follower) followers.push(follower)
        const history = result.followers.history || []
        for (const row of history) if (row.total != null) {
          const historical = followerObservation(account, row.total, { ...meta, source: 'backfill', method: 'observed', day: row.day, gain: row.gain, loss: row.loss, net: row.net })
          if (historical) followers.push({ ...historical, sourceFields: row.sourceFields, timeZone: row.timeZone || historical.timeZone })
        }
        if (history.length && history.every(row => row.total == null)) followers.push(...reconstructFollowers(account, { total: countValue(result.followers.raw).value, todayNet: result.followers.todayNet, history }, meta))
      }
      const committed = { ...started, status: 'committed', observedAt: result.observedAt, posts, samples, followers, legacyRows: result.legacyRows || [], coverage: result.coverage, price: result.price, profile: result.profile ? { identifier: result.profile.identifier, observed: result.profile.observed } : null }
      await this.store.event(committed)
      try { await this.store.project(dailySeries) } catch (error) { this.startupError = `事件已提交，索引等待恢复：${error.message}` }
      return committed
    }))
    this.inflight.set(key, promise)
    promise.then(() => this.inflight.delete(key), () => this.inflight.delete(key))
    return promise
  }

  async reuseRun(result, requestId) {
    const existing = this.store.requestRuns.get(requestId)
    if (existing && existing !== result.runKey) throw errorOf(409, '请求标识已用于其他任务', 'request_conflict')
    if (!existing) await this.store.event({ schemaVersion: 1, runKey: hash(['alias', requestId]), at: this.now().toISOString(), status: 'alias', requestId, aliasOf: result.runKey })
    return { ...result, cached: true }
  }

  async startRefresh(body) {
    if (body.purpose === 'recover') {
      return this.mutate(async () => {
        await recoverLock(join(this.store.root, 'collector.lock.recovery'))
        await recoverLock(join(this.dataDir, 'monid-budget.lock.recovery'))
        const recovered = await recoverLock(join(this.store.root, 'collector.lock'))
        await recoverLock(join(this.dataDir, 'monid-budget.lock'))
        this.bootstrapPromise = null
        await fileLock(join(this.store.root, 'collector.lock'), async () => { await this.store.reload(); await this.store.project(dailySeries) })
        this.startupError = null
        return { recovered }
      })
    }
    await this.requireAccount(body.accountId)
    if (!body.requestId || !['posts', 'followers'].includes(body.purpose)) throw errorOf(400, '缺少有效的请求标识或采集类型')
    // 响应等待提交，调用方显示进行中；错误由原 HTTP 请求直接返回，避免虚假“成功”。
    return publicRun(await this.collect(body.accountId, { purpose: body.purpose, requestId: body.requestId, acknowledgeUnknown: body.acknowledgeUnknown === true }))
  }

  async checkDaily(now = this.now()) {
    if (this.lastTick && +now - this.lastTick < 60000) return
    this.lastTick = +now
    await this.bootstrap()
    for (const account of await this.accounts()) {
      if (!account.enabled || !account.identity.value) continue
      for (const purpose of ['posts', ...(account.collectFollowers ? ['followers'] : [])]) {
        const spec = this.specFor(account, purpose)
        if (!spec || (spec.channel === 'monid' && !account.allowPaid)) continue
        const recent = this.store.accountPosts(account.accountId).some(p => p.publishedAt && +now - Date.parse(p.publishedAt) <= 7 * DAY && +now >= Date.parse(p.publishedAt))
        const hours = purpose === 'posts' && recent ? account.schedule.recentHours : 24
        const period = hours === 24 ? localDay(now) : String(Math.floor(+now / (hours * 3600000)))
        if (hours === 24 && now.getHours() < 8) continue
        const requestId = `auto:${hash([account.accountId, purpose, period]).slice(0, 40)}`
        if (this.store.requestRuns.has(requestId)) continue
        const uncertain = [...this.store.runs.values()].some(run => run.accountId === account.accountId && (run.purpose === purpose || purpose === 'posts' && run.purpose === 'x-direct') && ['started', 'uncertain'].includes(run.status))
        if (uncertain) continue
        try { await this.collect(account.accountId, { purpose, requestId, automatic: true }) } catch (error) {
          // 一次失败保留原状态；本轮继续其他账号，不切来源、不自动重试。
          if (!this.store.requestRuns.has(requestId)) this.startupError = error.message
        }
      }
    }
  }

  async listAccounts(query = {}) {
    if (query.role && !['own', 'bench'].includes(query.role)) throw errorOf(400, '账号类型无效')
    return { accounts: (await this.accounts()).filter(row => (!query.role || row.roles.includes(query.role)) && (!query.platform || row.platform === query.platform)), platforms: PLATFORM_COVERAGE }
  }

  async listPosts(query) {
    await this.requireAccount(query.accountId)
    const limit = query.limit == null ? 50 : Number(query.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw errorOf(400, '每页数量范围为 1–200')
    let cursor = null
    if (query.cursor) {
      try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()); if (!Array.isArray(cursor) || cursor.length !== 2 || !cursor.every(x => typeof x === 'string')) throw new Error() } catch { throw errorOf(400, '分页游标无效') }
    }
    const rows = this.store.accountPosts(query.accountId).sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.postKey.localeCompare(b.postKey))
    let start = 0
    if (cursor) { start = rows.findIndex(row => row.postKey === cursor[1] && (row.publishedAt || '') === cursor[0]) + 1; if (!start) throw errorOf(409, '分页数据已变化，请从第一页载入') }
    const page = rows.slice(start, start + limit).map(row => {
      const samples = this.store.samples(row.postKey), latest = new Map()
      for (const s of samples) if (!latest.has(s.seriesKey) || latest.get(s.seriesKey).observedAt < s.observedAt) latest.set(s.seriesKey, s)
      return { ...row, series: [...latest.values()].map(s => ({ seriesKey: s.seriesKey, collectorId: s.collectorId, measurementSet: s.measurementSet, channel: s.channel, observedAt: s.observedAt, values: s.values, quality: s.quality, legacy: s.legacy })) }
    })
    const end = page.at(-1)
    return { posts: page, total: rows.length, nextCursor: start + limit < rows.length ? Buffer.from(JSON.stringify([end.publishedAt || '', end.postKey])).toString('base64url') : null }
  }

  dateRange(query) {
    const to = query.to || localDay(this.now()), from = query.from || localDay(new Date(+this.now() - 29 * DAY))
    const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
    if (!valid(from) || !valid(to) || to < from || Date.parse(to) - Date.parse(from) > 365 * DAY) throw errorOf(400, '日期范围须为有效的连续 1–366 天')
    return { from, to }
  }

  async series(query) {
    await this.store.load()
    const post = this.store.posts.get(query.postKey)
    if (!post) throw errorOf(404, '找不到作品')
    const { from, to } = this.dateRange(query)
    const all = this.store.samples(post.postKey).filter(s => !query.seriesKey || s.seriesKey === query.seriesKey)
    return { post, from, to, samples: all.filter(s => s.day >= from && s.day <= to), daily: dailySeries(all, { from, to, now: this.now() }), comparisonPolicy: 'same_series_only' }
  }

  async followers(query) {
    const account = await this.requireAccount(query.accountId), { from, to } = this.dateRange(query)
    return { accountId: account.accountId, from, to, available: account.capabilities.followers, enabled: account.collectFollowers, daily: followerDaily(this.store.followers.filter(row => row.accountId === account.accountId)).filter(row => row.day >= from && row.day <= to), attribution: 'concurrent_only' }
  }

  async cohort(query) {
    await this.store.load()
    const post = this.store.posts.get(query.postKey)
    if (!post) throw errorOf(404, '找不到作品')
    const posts = this.store.accountPosts(post.accountId), samples = posts.flatMap(row => this.store.samples(row.postKey))
    return cohort(post, posts, samples, { ageDays: query.ageDays == null ? 3 : Number(query.ageDays), seriesKey: query.seriesKey, asOf: this.now() })
  }

  async status() {
    await this.store.load()
    const runs = [...this.store.runs.values()]
    return { schemaVersion: 1, running: [...this.inflight.keys()].map(key => { const [accountId, purpose] = JSON.parse(key); return { accountId, purpose } }),
      budget: await this.budget.read(), runs: runs.slice(-100).reverse().map(publicRun),
      startupError: this.startupError, uncertain: runs.filter(row => ['started', 'uncertain'].includes(row.status)).map(publicRun),
      migration: this.store.runs.has('legacy-migration-v1') ? { complete: true, samples: this.store.runs.get('legacy-migration-v1').migratedSamples, skipped: this.store.runs.get('legacy-migration-v1').skipped, inputRows: this.store.runs.get('legacy-migration-v1').inputRows, duplicateRows: this.store.runs.get('legacy-migration-v1').duplicateRows, sourceDigests: this.store.runs.get('legacy-migration-v1').sourceDigests } : { complete: false },
      platforms: PLATFORM_COVERAGE, sampleCount: this.store.sampleKeys.size, postCount: this.store.posts.size,
    }
  }

  async ownRows(accountId) {
    await this.store.load()
    return this.store.accountPosts(accountId).map(post => {
      const sample = this.store.samples(post.postKey).filter(row => !row.legacy).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]
      return sample ? { id: post.postId, accountId, platform: post.platform, title: post.title, url: post.url, publishedAt: post.publishedAt, fetchedAt: sample.observedAt, ...sample.values } : null
    }).filter(Boolean)
  }

  async benchRows() {
    const ids = new Set((await this.accounts()).filter(row => row.roles.includes('bench') && row.platform === 'X').map(row => row.accountId))
    const latest = new Map()
    for (const run of this.store.runs.values()) if (run.status === 'committed' && ids.has(run.accountId)) {
      for (const raw of run.legacyRows || []) {
        const old = latest.get(String(raw.id)), observedAt = raw.observedAt || run.observedAt
        if (!old || old.fetchedAt < observedAt) latest.set(String(raw.id), { ...raw, fetchedAt: observedAt, observedAt })
      }
    }
    return [...latest.values()]
  }

  async latestOwn(note) {
    await this.store.load()
    const result = new Map()
    for (const post of this.store.posts.values()) {
      if (post.pieceNote !== note) continue
      for (const sample of this.store.samples(post.postKey)) {
        if (sample.channel === 'csv') continue
        const key = `${post.platform}:${post.accountId}`, old = result.get(key)
        if (!old || old.at < sample.observedAt) result.set(key, { at: sample.observedAt, note, accountId: post.accountId, platform: post.platform, postId: post.postId, matchedBy: 'url', ...sample.values })
      }
    }
    return [...result.values()]
  }

  async latestX(note) {
    const row = (await this.latestOwn(note)).filter(row => row.platform === 'X' && row.views != null).sort((a, b) => b.at.localeCompare(a.at))[0]
    return row ? { ...row, tweetId: row.postId, favorites: row.likes, replies: row.comments, retweets: row.shares, bookmarks: row.saves } : null
  }

  async commitProjection(event) {
    await this.store.event(event)
    try { await this.store.project(dailySeries) } catch (error) { this.startupError = `事件已提交，索引等待恢复：${error.message}` }
    return event
  }

  async ingestProfile(accountId, platform, identifier, output, observedAt = this.now().toISOString()) {
    const value = followerValue(platform, output, identifier)
    if (value.raw == null || ['withheld', 'unsupported', 'invalid', 'missing'].includes(value.quality)) return { captured: false, reason: value.quality }
    return this.mutate(() => fileLock(join(this.store.root, 'collector.lock'), async () => {
      await this.store.reload()
      const account = await this.requireAccount(accountId)
      if (account.platform !== platform || (account.identity.value && account.identity.value !== identifier)) throw errorOf(409, '粉丝观测账号身份不一致', 'identity_mismatch')
      const runKey = hash(['profile', accountId, identifier, observedAt]), spec = collectorSpec(platform, 'followers')
      if (this.store.runs.has(runKey)) return { captured: true, cached: true }
      const row = followerObservation(account, value.raw, { runKey, observedAt, collectorId: spec.collectorId })
      if (!row) return { captured: false, reason: 'invalid' }
      await this.commitProjection({ schemaVersion: 1, runKey, accountId, identity: identityKey(platform, identifier), purpose: 'followers', at: observedAt, observedAt, status: 'committed', posts: [], samples: [], followers: [row], price: null, coverage: { complete: false, reason: 'existing_manual_profile' } })
      return { captured: true }
    }))
  }

  async ingestXMetrics(rows, { collectorId = 'legacy.x.refresh.v1', observedAt } = {}) {
    if (!rows.length) return { captured: 0 }
    return this.mutate(() => fileLock(join(this.store.root, 'collector.lock'), async () => {
      await this.store.reload()
      const accounts = (await this.accounts()).filter(row => row.platform === 'X' && row.roles.includes('own'))
      const at = this.now().toISOString(), runKey = hash(['x-metrics', collectorId, rows])
      if (this.store.runs.has(runKey)) return { captured: 0, cached: true }
      const event = { schemaVersion: 1, runKey, at, status: 'committed', purpose: 'x-association', posts: [], samples: [], followers: [], unassigned: 0 }
      for (const raw of rows) {
        const id = String(raw.tweetId ?? raw.id ?? ''), existing = [...this.store.posts.values()].filter(post => post.platform === 'X' && post.postId === id)
        const handle = raw.handle || /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\//.exec(raw.url || '')?.[1]
        const matches = handle ? accounts.filter(account => account.identity.value.toLowerCase() === handle.toLowerCase()) : accounts.filter(account => existing.some(post => post.accountId === account.accountId))
        const actualAt = raw.observedAt || observedAt || raw.at
        if (!/^\d+$/.test(id) || matches.length !== 1 || !Number.isFinite(Date.parse(actualAt))) { event.unassigned++; continue }
        const account = matches[0], old = this.store.posts.get(JSON.stringify([account.accountId, id]))
        const row = normalizedLegacy('X', { ...raw, id })
        const source = collectorId.includes('grok') ? 'grok.x.posts.v1' : collectorId
        const previous = old && this.store.samples(old.postKey).find(sample => sample.observedAt === actualAt && sample.collectorId === source)
        if (previous && old) { event.posts.push({ ...old, pieceNote: raw.note || old.pieceNote, linkMatch: raw.note ? 'confirmed' : old.linkMatch }); continue }
        const pair = observation(account, row, { runKey, observedAt: actualAt, collectorId: source, channel: source.startsWith('grok') ? 'grok' : 'monid', measurementSet: 'x.public-counts.v1', coverage: { complete: false, reason: 'single_post' } }, old)
        event.posts.push(pair.post); event.samples.push(pair.sample)
      }
      await this.commitProjection(event)
      return { captured: event.samples.length, unassigned: event.unassigned }
    }))
  }

  async importCsv(csv, pieces = []) {
    const metrics = readMetrics(csv), runKey = hash(['x-csv', csv])
    return this.mutate(() => fileLock(join(this.store.root, 'collector.lock'), async () => {
      await this.store.reload()
      if (this.store.runs.has(runKey)) return { captured: 0, cached: true }
      const accounts = (await this.accounts()).filter(account => account.platform === 'X' && account.roles.includes('own'))
      const at = this.now().toISOString(), event = { schemaVersion: 1, runKey, at, observedAt: at, status: 'committed', purpose: 'csv', posts: [], samples: [], followers: [], unassigned: 0 }
      const seen = new Set()
      for (const metric of metrics) {
        if (!/^\d+$/.test(metric.postId) || !Number.isSafeInteger(metric.impressions) || metric.impressions < 0 || seen.has(metric.postId)) { event.unassigned++; continue }
        if (metrics.some(other => other.postId === metric.postId && other.impressions !== metric.impressions)) { event.unassigned++; continue }
        seen.add(metric.postId)
        const matches = pieces.flatMap(piece => (piece.distributions || []).filter(dist => dist.platform === 'X' && new RegExp(`/status/${metric.postId}(?:[/?#]|$)`).test(dist.url || '')).map(dist => ({ piece, dist })))
        const identities = new Set(matches.map(({ dist }) => /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\//.exec(dist.url || '')?.[1]?.toLowerCase()).filter(Boolean))
        const existing = [...this.store.posts.values()].filter(post => post.platform === 'X' && post.postId === metric.postId && accounts.some(account => account.accountId === post.accountId))
        const candidates = identities.size ? accounts.filter(account => identities.has(account.identity.value.toLowerCase())) : accounts.filter(account => existing.some(post => post.accountId === account.accountId))
        if (candidates.length !== 1) { event.unassigned++; continue }
        const account = candidates[0], old = existing.find(post => post.accountId === account.accountId), match = matches[0]
        const row = { id: metric.postId, title: match?.piece.title || old?.title, url: match?.dist.url || old?.url, note: matches.length === 1 ? match.piece.note : old?.pieceNote, publishedAt: old?.publishedAt || match?.dist.date, contentKind: old?.contentKind || 'unknown', impressions: metric.impressions, sourceFields: { impressions: 'Impressions' } }
        const pair = observation(account, row, { runKey, observedAt: at, collectorId: 'csv.x.analytics.v1', channel: 'csv', measurementSet: 'x.csv.impressions.v1', coverage: { complete: false, reason: 'report_period_unknown' }, legacy: true }, old)
        event.posts.push(pair.post); event.samples.push(pair.sample)
      }
      await this.commitProjection(event)
      return { captured: event.samples.length, unassigned: event.unassigned }
    }))
  }

  async readXPosts(urls, { partial = false } = {}) {
    if (!Array.isArray(urls) || urls.length > 200) throw errorOf(400, 'X 链接列表无效')
    const requested = [...new Set(urls)].map(url => {
      const parsed = new URL(url), match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/.exec(parsed.pathname)
      if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(parsed.hostname) || parsed.protocol !== 'https:' || !match || parsed.username || parsed.password) throw errorOf(400, '需要完整的 X 帖子链接')
      return { url, handle: match[1], id: match[2] }
    })
    return this.mutate(() => fileLock(join(this.store.root, 'collector.lock'), async () => {
      await this.store.reload()
      const accounts = await this.accounts(), cached = new Map(), groups = new Map(), failed = []
      for (const run of this.store.runs.values()) if (run.status === 'committed') for (const row of run.legacyRows || []) {
        const observedAt = row.observedAt || run.observedAt
        if (row.textComplete && +this.now() - Date.parse(observedAt) < 600000 && (!cached.has(String(row.id)) || cached.get(String(row.id)).observedAt < observedAt)) cached.set(String(row.id), { ...row, observedAt })
      }
      for (const request of requested) {
        if (cached.get(request.id)?.handle.toLowerCase() === request.handle.toLowerCase()) continue
        const account = accounts.find(row => row.platform === 'X' && row.identity.value.toLowerCase() === request.handle.toLowerCase())
        if (!account?.enabled) { failed.push({ ...request, reason: '账号缺少已启用的监控身份' }); continue }
        if (!groups.has(account.accountId)) groups.set(account.accountId, { account, requests: [] })
        groups.get(account.accountId).requests.push(request)
      }
      for (const { account, requests } of groups.values()) {
        const uncertain = [...this.store.runs.values()].some(run => run.accountId === account.accountId && ['started', 'uncertain'].includes(run.status))
        if (uncertain) throw errorOf(409, 'X 上次请求结果未知，先在监控状态确认风险', 'uncertain_run')
        const at = this.now().toISOString(), runKey = hash(['x-direct', account.accountId, randomUUID()])
        const started = { schemaVersion: 1, runKey, accountId: account.accountId, at, purpose: 'x-direct', status: 'started' }
        await this.store.event(started)
        let result
        try { result = await this.collectors.grokx.readPosts(requests.map(row => row.url), { partial: true }) } catch (error) {
          await this.store.event({ ...started, status: 'uncertain', error: String(error.message).slice(0, 300) }); throw error
        }
        const observedAt = this.now().toISOString(), posts = [], samples = [], legacyRows = []
        for (const raw of result.posts) {
          if (!requests.some(request => request.id === String(raw.id) && request.handle.toLowerCase() === String(raw.handle).toLowerCase())) continue
          const normalized = normalizeMonitorPosts('X', [raw], account.identity.value)[0]
          if (!normalized) continue
          const pair = observation(account, normalized, { runKey, observedAt, collectorId: 'grok.x.posts.v1', channel: 'grok', measurementSet: 'x.public-counts.v1', coverage: { complete: false, reason: 'single_post' } }, this.store.posts.get(JSON.stringify([account.accountId, String(raw.id)])))
          posts.push(pair.post); samples.push(pair.sample)
          legacyRows.push({ ...raw, observedAt }); cached.set(String(raw.id), { ...raw, observedAt })
        }
        for (const request of requests) if (!cached.has(request.id)) failed.push({ ...request, reason: result.failed.find(row => row.id === request.id)?.reason || '未取得身份匹配的完整帖子' })
        await this.commitProjection({ ...started, status: 'committed', observedAt, posts, samples, followers: [], legacyRows, coverage: { complete: false, reason: 'single_post' } })
      }
      const posts = requested.flatMap(row => cached.has(row.id) && !failed.some(fail => fail.id === row.id) ? [cached.get(row.id)] : [])
      if (!partial && failed.length) throw errorOf(502, failed.map(row => `${row.id}：${row.reason}`).join('；'))
      return partial ? { posts, failed } : posts
    }))
  }

  async recentX(handle, opts) {
    const account = (await this.accounts()).find(row => row.platform === 'X' && row.identity.value.toLowerCase() === handle.toLowerCase())
    if (!account) throw errorOf(409, 'X 账号尚未绑定监控身份')
    const result = await this.collect(account.accountId, { ...opts, purpose: 'posts' })
    return Object.assign(result.legacyRows.map(row => ({ ...row, observedAt: row.observedAt || result.observedAt })), { missed: result.coverage?.missed || 0, failed: result.coverage?.failed || [] })
  }
}
