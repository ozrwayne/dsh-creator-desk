import { mkdir, open, readFile, readdir, rename, unlink, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { errorOf } from './monitor-model.js'

const queues = new Map()
const host = hostname()
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString()
const monthName = /^\d{4}-(0[1-9]|1[0-2])\.jsonl$/
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.length > 0
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const instant = value => typeof value === 'string' && day(value.slice(0, 10)) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
const count = value => value === null || (Number.isSafeInteger(value) && value >= 0)
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

function queued(root, task) {
  const key = resolve(root)
  const result = (queues.get(key) || Promise.resolve()).then(task)
  const settled = result.catch(() => {})
  queues.set(key, settled)
  settled.then(() => { if (queues.get(key) === settled) queues.delete(key) })
  return result
}

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}

function* parsedLines(file, bytes, committedOnly) {
  // 换行是旧追加日志的提交边界；可解析但未换行的 JSON 同样不能生效。
  const end = committedOnly ? bytes.lastIndexOf(10) + 1 : bytes.length
  let contents
  try { contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)) } catch (cause) {
    throw Object.assign(errorOf(500, `监控日志编码损坏：${file}`, 'corrupt_log'), { cause })
  }
  let line = 0
  for (const source of contents.split('\n')) {
    line++
    if (!source.trim()) continue
    let value
    try { value = JSON.parse(source) } catch (cause) {
      throw Object.assign(errorOf(500, `监控日志损坏：${file}:${line}`, 'corrupt_log'), { cause })
    }
    yield { value, line }
  }
}

export async function readLines(file, { committedOnly = false } = {}) {
  let bytes
  try { bytes = await readFile(file) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  return [...parsedLines(file, bytes, committedOnly)].map(row => row.value)
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function ensureDirectory(directory) {
  const first = await mkdir(directory, { recursive: true })
  if (first) {
    const stop = dirname(resolve(first))
    for (let current = resolve(directory); ; current = dirname(current)) {
      await syncDirectory(current)
      if (current === stop) break
    }
  }
}

async function atomicWrite(file, write) {
  const directory = dirname(file)
  await ensureDirectory(directory)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let handle, installed = false, failure
  try {
    handle = await open(tmp, 'wx', 0o600)
    await write(handle)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tmp, file)
    installed = true
    await syncDirectory(directory)
  } catch (error) {
    failure = error
    // rename 后目录 sync 失败属于可见但持久性未确认，调用方不得自动重发付费请求。
    if (installed) error.replacementVisible = true
    throw error
  } finally {
    if (handle) await handle.close().catch(error => { if (failure) failure.closeError = error })
    if (!installed) await unlink(tmp).catch(error => { if (error.code !== 'ENOENT' && failure) failure.cleanupError = error })
  }
}

function json(value) {
  const result = JSON.stringify(value)
  if (result === undefined) throw new TypeError('JSON value is required')
  return result
}

export async function atomicJson(file, value) {
  const contents = JSON.stringify(value, null, 2)
  if (contents === undefined) throw new TypeError('JSON value is required')
  await atomicWrite(file, handle => handle.writeFile(contents + '\n'))
}

export async function atomicLines(file, rows) {
  await atomicWrite(file, async handle => {
    let chunk = []
    for (const row of rows) {
      chunk.push(json(row))
      if (chunk.length === 500) { await handle.writeFile(chunk.join('\n') + '\n'); chunk = [] }
    }
    if (chunk.length) await handle.writeFile(chunk.join('\n') + '\n')
  })
}

async function recoveryInProgress(file) {
  try { await lstat(`${file}.recovery`); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

/** 不按时间偷锁；调用方须在 reload、付费请求和 event/project 全程持锁。 */
export async function fileLock(file, task) {
  await ensureDirectory(dirname(file))
  const locked = () => errorOf(409, '另一采集或恢复任务持有锁；遗留锁需显式恢复', 'collector_locked')
  if (await recoveryInProgress(file)) throw locked()
  let handle
  try { handle = await open(file, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw locked()
    throw error
  }
  let owned, failure, result
  try {
    owned = await handle.stat({ bigint: true })
    // 与恢复者的 guard 配对检查，防止检查 guard 后、创建锁前的竞争。
    if (await recoveryInProgress(file)) throw locked()
    await handle.writeFile(json({ schemaVersion: 1, pid: process.pid, host, processStartedAt, token: randomUUID(), at: new Date().toISOString() }) + '\n')
    await handle.sync()
    await syncDirectory(dirname(file))
    result = await task()
  } catch (error) {
    failure = error
  } finally {
    try {
      const current = await lstat(file, { bigint: true })
      if (!owned || !sameFile(owned, current)) throw errorOf(409, '锁已被替换或无法核验，保留现有锁供人工检查', 'lock_changed')
      await unlink(file)
      await syncDirectory(dirname(file))
    } catch (error) {
      if (failure) failure.lockReleaseError = error
      else failure = Object.assign(errorOf(500, `任务已结束但锁释放失败：${error.message}`, 'lock_release_failed'), { cause: error, taskCompleted: true, result })
    }
    await handle.close().catch(error => { if (failure) failure.closeError = error; else failure = error })
  }
  if (failure) throw failure
  return result
}

export async function recoverLock(file) {
  // guard 阻止新持锁者和第二个恢复者进入 unlink 的检查窗口。
  // 若恢复进程本身崩溃，先显式 recoverLock(file + '.recovery')；不自动清除 guard。
  return fileLock(`${file}.recovery`, async () => {
    let handle
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
      if (error.code === 'ENOENT') return false
      throw Object.assign(errorOf(409, '锁无法安全读取，需人工检查', 'unknown_lock'), { cause: error })
    }
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.nlink !== 1n) throw errorOf(409, '锁文件类型异常，需人工检查', 'unknown_lock')
      let owner
      try { owner = JSON.parse(await handle.readFile('utf8')) } catch (cause) {
        throw Object.assign(errorOf(409, '锁内容损坏，需人工检查', 'unknown_lock'), { cause })
      }
      if (!record(owner) || owner.schemaVersion !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 2147483647 ||
          owner.host !== host || !instant(owner.at) || !instant(owner.processStartedAt) || !text(owner.token)) {
        throw errorOf(409, '锁缺少可核验的本机进程身份，需人工检查', 'unknown_lock')
      }
      let dead = false
      try { process.kill(owner.pid, 0) } catch (error) {
        if (error.code === 'ESRCH') dead = true
        else if (error.code !== 'EPERM') throw Object.assign(errorOf(409, '无法确认锁进程已退出', 'unknown_lock'), { cause: error })
      }
      // PID 被复用或权限不足也拒绝解除；宁可人工检查，不碰活进程的锁。
      if (!dead) throw errorOf(409, '采集进程仍在运行，不能解除锁', 'collector_active')
      const after = await lstat(file, { bigint: true })
      if (!sameFile(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw errorOf(409, '锁已变化，请重新查看状态', 'lock_changed')
      }
      await unlink(file)
      await syncDirectory(dirname(file))
      return true
    } finally { await handle.close() }
  })
}

function emptyState() {
  return {
    posts: new Map(), byAccount: new Map(), byPost: new Map(), followers: [], runs: new Map(), events: [],
    sampleKeys: new Set(), requestRuns: new Map(), samplesByKey: new Map(), followersByKey: new Map(),
  }
}

function validateEvent(event) {
  const invalid = reason => { throw errorOf(400, `监控事件无效：${reason}`, 'invalid_event') }
  if (!record(event) || !text(event.runKey) || !instant(event.at) ||
      !['started', 'committed', 'failed', 'uncertain', 'acknowledged', 'alias'].includes(event.status)) invalid('事件标识、时间或状态')
  if (event.schemaVersion !== 1 && !(event.status === 'alias' && event.schemaVersion === undefined)) invalid('schemaVersion')
  if (event.requestId != null && !text(event.requestId)) invalid('requestId')
  if (event.status === 'alias' && (!text(event.requestId) || !text(event.aliasOf))) invalid('请求别名')
  if (event.status === 'acknowledged' && !text(event.resolvedBy)) invalid('人工确认缺少 resolvedBy')
  for (const key of ['posts', 'samples', 'followers']) {
    if ((event.status === 'committed' || event[key] !== undefined) && !Array.isArray(event[key])) invalid(key)
    if (event.status !== 'committed' && event[key]?.length) invalid('未提交事件含观测')
  }
  for (const post of event.posts || []) {
    if (!record(post) || (post.schemaVersion !== undefined && post.schemaVersion !== 1) || !text(post.postKey) || !text(post.accountId) ||
        (post.lastSeenAt != null && !instant(post.lastSeenAt)) ||
        (post.publicationRevision !== undefined && (!Number.isSafeInteger(post.publicationRevision) || post.publicationRevision < 1))) invalid('作品结构')
  }
  for (const sample of event.samples || []) {
    if (!record(sample) || (sample.schemaVersion !== undefined && sample.schemaVersion !== 1) ||
        !['sampleKey', 'postKey', 'accountId', 'seriesKey'].every(key => text(sample[key])) || !day(sample.day) || !instant(sample.observedAt) ||
        !record(sample.values) || !Object.values(sample.values).every(count) || !record(sample.quality) ||
        !Object.values(sample.quality).every(text)) invalid('样本结构')
  }
  for (const follower of event.followers || []) {
    if (!record(follower) || (follower.schemaVersion !== undefined && follower.schemaVersion !== 1) ||
        !['followerKey', 'dailyKey', 'accountId'].every(key => text(follower[key])) || !day(follower.day) ||
        !instant(follower.observedAt) || !count(follower.total)) invalid('粉丝观测结构')
  }
}

function applyEvent(state, event) {
  validateEvent(event)
  const target = event.status === 'alias' ? event.aliasOf : event.runKey
  const requestTarget = event.requestId && state.requestRuns.get(event.requestId)
  if (requestTarget && requestTarget !== target) throw errorOf(409, '请求标识已绑定其他任务', 'request_conflict')
  if (event.status === 'alias') {
    const original = state.runs.get(target)
    if (original?.status !== 'committed' || event.at.slice(0, 7) < original.at.slice(0, 7)) {
      throw errorOf(409, '请求别名必须指向此前已提交任务', 'invalid_alias')
    }
    state.events.push(event)
    state.requestRuns.set(event.requestId, target)
    return !requestTarget
  }
  const old = state.runs.get(event.runKey)
  const next = old ? { ...old, ...event } : event
  if (old && isDeepStrictEqual(old, next)) { state.events.push(event); return false }
  if (event.status === 'acknowledged' && !['started', 'uncertain'].includes(old?.status)) {
    throw errorOf(409, '只有未决任务能被人工确认', 'run_conflict')
  }
  if (old && (old.status === 'committed' || event.status === 'started' || event.at.slice(0, 7) < old.at.slice(0, 7) ||
      ['accountId', 'purpose', 'identity', 'requestId'].some(key => old[key] != null && event[key] != null && old[key] !== event[key]))) {
    throw errorOf(409, '已记录的任务不能被重复启动或改写', 'run_conflict')
  }
  // 先校验整条事件，任何一条坏样本都不能留下半次内存归约或半次落盘。
  const posts = new Map()
  for (const post of event.posts || []) {
    const previous = posts.get(post.postKey) || state.posts.get(post.postKey)
    if (previous && (previous.accountId !== post.accountId ||
        ['postId', 'platform'].some(key => previous[key] != null && post[key] !== previous[key]))) {
      throw errorOf(409, '作品业务键绑定的身份发生冲突', 'post_conflict')
    }
    posts.set(post.postKey, post)
  }
  const samples = new Map(), followers = new Map()
  for (const sample of event.samples || []) {
    const post = posts.get(sample.postKey) || state.posts.get(sample.postKey)
    if (!post || post.accountId !== sample.accountId) throw errorOf(409, '样本缺少对应账号作品', 'sample_conflict')
    const previous = samples.get(sample.sampleKey) || state.samplesByKey.get(sample.sampleKey)
    if (previous && !isDeepStrictEqual(previous, sample)) throw errorOf(409, '样本业务键已有不同观测', 'sample_conflict')
    samples.set(sample.sampleKey, sample)
  }
  for (const follower of event.followers || []) {
    const previous = followers.get(follower.followerKey) || state.followersByKey.get(follower.followerKey)
    if (previous && !isDeepStrictEqual(previous, follower)) throw errorOf(409, '粉丝业务键已有不同观测', 'sample_conflict')
    followers.set(follower.followerKey, follower)
  }
  state.events.push(event)
  state.runs.set(event.runKey, next)
  if (event.requestId) state.requestRuns.set(event.requestId, event.runKey)
  for (const post of posts.values()) {
    const previous = state.posts.get(post.postKey)
    if (previous?.lastSeenAt && post.lastSeenAt && (Date.parse(previous.lastSeenAt) > Date.parse(post.lastSeenAt) ||
        (previous.lastSeenAt === post.lastSeenAt && previous.publicationRevision > post.publicationRevision))) continue
    state.posts.set(post.postKey, post)
    if (!state.byAccount.has(post.accountId)) state.byAccount.set(post.accountId, new Set())
    state.byAccount.get(post.accountId).add(post.postKey)
  }
  for (const sample of samples.values()) {
    if (state.sampleKeys.has(sample.sampleKey)) continue
    state.sampleKeys.add(sample.sampleKey)
    state.samplesByKey.set(sample.sampleKey, sample)
    if (!state.byPost.has(sample.postKey)) state.byPost.set(sample.postKey, [])
    state.byPost.get(sample.postKey).push(sample)
  }
  for (const follower of followers.values()) {
    if (state.followersByKey.has(follower.followerKey)) continue
    state.followersByKey.set(follower.followerKey, follower)
    state.followers.push(follower)
  }
  return true
}

async function readState(root, captureMonth) {
  const state = emptyState()
  let names = [], captured = Buffer.alloc(0)
  try { names = await readdir(join(root, 'runs')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const name of names.filter(name => name.endsWith('.jsonl')).sort()) {
    if (!monthName.test(name)) throw errorOf(500, `监控日志分区无效：${name}`, 'corrupt_log')
    const file = join(root, 'runs', name), bytes = await readFile(file)
    if (name === `${captureMonth}.jsonl`) captured = bytes
    for (const { value, line } of parsedLines(file, bytes, true)) {
      try {
        validateEvent(value)
        if (value.at.slice(0, 7) !== name.slice(0, 7)) throw errorOf(400, '事件月份与分区不符', 'invalid_event')
        applyEvent(state, value)
      } catch (cause) {
        throw Object.assign(errorOf(500, `监控事件损坏：${file}:${line}：${cause.message}`, 'corrupt_log'), { cause })
      }
    }
  }
  return { state, captured }
}

function addMonth(months, row) {
  if (!day(row.day)) throw errorOf(500, '物化记录缺少有效日期', 'invalid_projection')
  const month = row.day.slice(0, 7)
  if (!months.has(month)) months.set(month, [])
  months.get(month).push(row)
}

async function writeMonths(root, type, months) {
  let previous = []
  try { previous = await readdir(join(root, type)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  // 人工修复正本后，旧分区也必须清空；绝不从旧投影反向补回事件。
  for (const name of previous.filter(name => monthName.test(name))) {
    if (!months.has(name.slice(0, 7))) months.set(name.slice(0, 7), [])
  }
  for (const [month, rows] of months) await atomicLines(join(root, type, `${month}.jsonl`), rows)
}

export class MonitorStore {
  constructor(root) {
    this.root = join(root, 'monitor')
    Object.assign(this, emptyState())
    this.loaded = null
  }

  load() {
    if (!this.loaded) return this.reload()
    return this.loaded
  }

  reload() {
    this.loaded = queued(this.root, async () => {
      const { state } = await readState(this.root)
      // 所有 await 完成之后一次替换；GET 只能看到上一完整水位或这一完整水位。
      Object.assign(this, state)
      return this
    })
    return this.loaded
  }

  apply(event) { return applyEvent(this, event) }

  async event(event) {
    // 与调用者的可变对象断开，落盘与内存始终使用同一份 JSON 事实。
    const serialized = json(event), committed = JSON.parse(serialized)
    validateEvent(committed)
    await this.load()
    return queued(this.root, async () => {
      const month = committed.at.slice(0, 7)
      const { state, captured } = await readState(this.root, month)
      const changed = applyEvent(state, committed)
      if (!changed) {
        state.events.pop()
        Object.assign(this, state)
        return
      }
      const file = join(this.root, 'runs', `${month}.jsonl`), end = captured.lastIndexOf(10) + 1
      if (end !== captured.length) {
        // 先复制恢复证据；不把旧正本移走，崩溃时旧的完整前缀仍留在原路径。
        await atomicWrite(`${file}.interrupted-${randomUUID()}`, handle => handle.writeFile(captured))
      }
      try {
        await atomicWrite(file, async handle => {
          if (end) await handle.writeFile(captured.subarray(0, end))
          await handle.writeFile(serialized + '\n')
        })
      } catch (error) {
        error.runKey = committed.runKey
        error.journalCommitted = Boolean(error.replacementVisible)
        throw error
      }
      Object.assign(this, state)
    })
  }

  accountPosts(accountId) { return [...(this.byAccount.get(accountId) || [])].map(key => this.posts.get(key)) }
  samples(postKey) { return this.byPost.get(postKey) || [] }

  async project(daily) {
    await this.load()
    return queued(this.root, async () => {
      const { state } = await readState(this.root)
      Object.assign(this, state)
      const sampleMonths = new Map(), dailyMonths = new Map(), followerMonths = new Map()
      for (const samples of state.byPost.values()) {
        for (const sample of samples) addMonth(sampleMonths, sample)
        // 先对每个作品的完整历史求日终，再分月，月初才能看到上月最后一天。
        for (const row of daily(samples)) addMonth(dailyMonths, row)
      }
      for (const row of state.followers) addMonth(followerMonths, row)
      await atomicLines(join(this.root, 'posts.jsonl'), state.posts.values())
      await writeMonths(this.root, 'samples', sampleMonths)
      await writeMonths(this.root, 'daily', dailyMonths)
      await writeMonths(this.root, 'followers', followerMonths)
      // 单文件原子替换不等于多文件事务；GET 只读事件归约，永不拼接这些投影。
      await atomicJson(join(this.root, 'state.json'), {
        schemaVersion: 1, lastRunKey: state.events.at(-1)?.runKey || null,
        eventCount: state.events.length, projectedAt: new Date().toISOString(),
      })
    })
  }
}
