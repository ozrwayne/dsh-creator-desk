// Wiki 收录队列。一次只跑一篇，其余排队。子进程脱离父进程，工作台重启不会带走它。
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { exitPath, killGroup, pidAlive, POLL_MS, readExitCode, spawnWrapped, waitForExit } from './job-proc.js'
import { tr } from './i18n.js'
import { httpError } from './vault.js'

export const DEFAULT_INGEST_SCRIPT = process.env.MEDIA_DESK_INGEST_SCRIPT || ''
const PYTHON = '/usr/bin/python3'
const HISTORY = 200
const TIMEOUT_MS = 20 * 60 * 1000
const TAIL = 300

let spawnImpl = nodeSpawn
let failEnqueue = false

export function setIngestSpawnForTests(fn) {
  spawnImpl = fn || nodeSpawn
}

export function setIngestEnqueueFailureForTests(value) {
  failEnqueue = Boolean(value)
}

export function resetIngestForTests() {
  spawnImpl = nodeSpawn
  failEnqueue = false
}

function jobId() {
  return `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function trim(jobs) {
  const active = jobs.filter(job => job.status === 'queued' || job.status === 'running')
  const rest = jobs
    .filter(job => job.status !== 'queued' && job.status !== 'running')
    .sort((a, b) => (b.finishedAt || b.createdAt || '').localeCompare(a.finishedAt || a.createdAt || ''))
  return [...active, ...rest.slice(0, HISTORY)]
}

function withLocalBin(env) {
  const extra = join(homedir(), '.local', 'bin')
  const path = String(env.PATH || '')
  if (path.split(delimiter).includes(extra)) return { ...env }
  return { ...env, PATH: path ? `${extra}${delimiter}${path}` : extra }
}

async function tail(file, limit = TAIL) {
  try {
    const text = await readFile(file, 'utf8')
    return text.slice(-limit).trim()
  } catch {
    return ''
  }
}

export function presentIngest(jobs) {
  const list = Array.isArray(jobs) ? jobs : []
  const queued = list.filter(job => job.status === 'queued').length
  const running = list.filter(job => job.status === 'running').length
  const failed = list.filter(job => job.status === 'failed').length
  const recent = [...list]
    .sort((a, b) => (b.finishedAt || b.startedAt || b.createdAt || '').localeCompare(a.finishedAt || a.startedAt || a.createdAt || ''))
    .slice(0, 5)
    .map(job => {
      const row = { id: job.id, title: job.title || '', status: job.status, finishedAt: job.finishedAt || null }
      if (job.error) row.error = job.error
      return row
    })
  return { queued, running, failed, recent }
}

/** 归档已经完成。排队失败只记在这里，不往外抛。 */
export async function queueAfterArchive(ingest, vault, moved) {
  if (!ingest || !moved?.to) return null
  const name = String(moved.to).split('/').pop() || ''
  try {
    return await ingest.enqueue({
      file: vault.abs(moved.to),
      title: name.replace(/\.md$/i, ''),
    })
  } catch {
    return null
  }
}

/** 对标原文只由用户显式排队，文件保持在对标原文目录。 */
export async function queueBenchWiki(ingest, vault, path) {
  const spec = vault.parseBenchId(`bench:${String(path ?? '').replace(/^bench:/, '')}`)
  const row = await vault.benchRecord(spec)
  return ingest.enqueue({
    file: spec.file, title: row.title,
    kind: 'bench', handle: spec.handle, path: spec.rel,
  })
}

export class IngestQueue {
  constructor({ dataDir, context, spawn = null, timeoutMs = TIMEOUT_MS, pollMs = POLL_MS }) {
    this.dataDir = dataDir
    this.context = context
    this.spawn = spawn || ((bin, args, options) => spawnImpl(bin, args, options))
    this.timeoutMs = timeoutMs
    this.pollMs = pollMs
    this.file = join(dataDir, 'ingest-jobs.json')
    this.jobs = []
    this.wikiFiles = []
    this.loaded = false
    this.runningId = null
    this.pumping = false
    this.abandoned = false
    this.chain = Promise.resolve()
  }

  mutate(task) {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => {})
    return next
  }

  /** 测试用来模拟父进程退出：停下监视，不杀子进程。 */
  abandon() {
    this.abandoned = true
  }

  async load() {
    if (this.loaded) return
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'))
      this.jobs = Array.isArray(saved?.jobs) ? saved.jobs : []
      this.wikiFiles = Array.isArray(saved?.benchWiki) ? saved.benchWiki : []
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      this.jobs = []
    }
    this.loaded = true
  }

  async save() {
    await mkdir(this.dataDir, { recursive: true })
    this.jobs = trim(this.jobs)
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ jobs: this.jobs, benchWiki: this.wikiFiles }))
    await rename(tmp, this.file)
  }

  async list() {
    await this.load()
    return this.jobs
  }

  async benchWikiFiles() {
    await this.load()
    return this.wikiFiles
  }

  exitFile(id) {
    return exitPath(this.dataDir, id)
  }

  async recover() {
    await this.mutate(async () => {
      await this.load()
      const front = []
      for (const job of this.jobs) {
        if (job.status !== 'running') continue
        const code = await readExitCode(this.exitFile(job.id))
        if (code !== null || pidAlive(job.pid)) continue
        job.status = 'queued'
        job.startedAt = null
        job.finishedAt = null
        job.pid = null
        job.error = null
        job.cancelRequested = false
        front.push(job)
      }
      if (front.length) {
        const ids = new Set(front.map(job => job.id))
        this.jobs = [...front, ...this.jobs.filter(job => !ids.has(job.id))]
        await this.save()
      }
    })
    this.pump()
  }

  async enqueue({ file, title, kind, handle, path: sourcePath } = {}) {
    if (failEnqueue) throw new Error('queue failed')
    const path = String(file ?? '')
    if (!path.startsWith('/') || path.includes('\0')) throw httpError(400, '路径无效')
    const job = await this.mutate(async () => {
      await this.load()
      if (kind === 'bench') {
        const existing = this.wikiFiles.find(item => item.file === path)
          || this.jobs.find(item => item.file === path && ['queued', 'running', 'done'].includes(item.status))
        if (existing) return existing
      }
      const next = {
        id: jobId(),
        file: path,
        title: String(title || basename(path).replace(/\.md$/i, '')).slice(0, 200),
        ...(kind === 'bench' ? { kind, handle, path: sourcePath } : {}),
        status: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        error: null,
      }
      this.jobs.push(next)
      await this.save()
      return next
    })
    this.pump()
    return job
  }

  async retry(id) {
    const job = await this.mutate(async () => {
      await this.load()
      const found = this.jobs.find(item => item.id === id)
      if (!found) throw httpError(404, '找不到这个任务')
      if (found.status !== 'failed') throw httpError(400, '这个任务不能重试')
      found.status = 'queued'
      found.error = null
      found.startedAt = null
      found.finishedAt = null
      found.pid = null
      found.cancelRequested = false
      await this.save()
      return found
    })
    await rm(this.exitFile(id) || '', { force: true }).catch(() => {})
    this.pump()
    return job
  }

  async cancel(id) {
    const pid = await this.mutate(async () => {
      await this.load()
      const job = this.jobs.find(item => item.id === id)
      if (!job) throw httpError(404, '找不到这个任务')
      if (job.status === 'queued') {
        job.status = 'cancelled'
        job.error = '任务已取消'
        job.finishedAt = new Date().toISOString()
        await this.save()
        return null
      }
      if (job.status !== 'running') throw httpError(400, '这个任务不能取消')
      job.cancelRequested = true
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      await this.save()
      return job.pid
    })
    if (pid) killGroup(pid)
  }

  pump() {
    if (this.abandoned || this.pumping) return
    this.pumping = true
    this.drain()
  }

  async drain() {
    try {
      for (;;) {
        if (this.abandoned) return
        const running = this.jobs.find(item => item.status === 'running')
        if (running) {
          await this.settleRunning(running)
          continue
        }
        const job = this.jobs.find(item => item.status === 'queued')
        if (!job) return
        try {
          await this.runJob(job)
        } catch (err) {
          if (this.abandoned) return
          job.status = 'failed'
          job.error = err.message || '模型调用失败'
          job.finishedAt = new Date().toISOString()
          await this.mutate(() => this.save())
        }
      }
    } finally {
      this.pumping = false
      queueMicrotask(() => {
        if (this.abandoned) return
        if (!this.pumping && this.jobs.some(item => item.status === 'queued' || item.status === 'running')) this.pump()
      })
    }
  }

  async settleRunning(job) {
    if (this.abandoned) return
    const code = await readExitCode(this.exitFile(job.id))
    if (code !== null) {
      await this.finish(job, { code })
      return
    }
    if (pidAlive(job.pid)) {
      const outcome = await this.watch(job)
      if (outcome.abandoned || this.abandoned) return
      await this.finish(job, outcome)
      return
    }
    await this.finish(job, { unexpected: true })
  }

  async runJob(job) {
    if (job.status !== 'queued' || this.abandoned) return
    job.status = 'running'
    job.startedAt = new Date().toISOString()
    job.error = null
    job.cancelRequested = false
    job.pid = null
    await this.mutate(() => this.save())
    const { logDir, script } = await this.context()
    const args = [script || DEFAULT_INGEST_SCRIPT, '--file', job.file]
    const file = this.exitFile(job.id)
    await mkdir(logDir, { recursive: true })
    await mkdir(join(this.dataDir, 'jobs'), { recursive: true })
    if (file) await rm(file, { force: true })
    const logPath = join(logDir, 'ingest.log')
    const handle = await open(logPath, 'a')
    let child
    try {
      await handle.write(`\n--- ${job.startedAt} ${job.id} ${job.file}\n`)
      child = spawnWrapped(this.spawn, {
        bin: PYTHON,
        args,
        env: withLocalBin(process.env),
        logFd: handle.fd,
        exitFile: file,
      })
    } catch (err) {
      job.status = 'failed'
      job.error = err.message
      job.finishedAt = new Date().toISOString()
      await this.mutate(() => this.save())
      return
    } finally {
      await handle.close()
    }
    this.runningId = job.id
    job.pid = child.pid
    await this.mutate(() => this.save())
    const outcome = await this.watch(job)
    if (outcome.abandoned || this.abandoned) return
    await this.finish(job, outcome)
    if (this.runningId === job.id) this.runningId = null
  }

  watch(job) {
    return waitForExit({
      exitFile: this.exitFile(job.id),
      pid: job.pid,
      pollMs: this.pollMs,
      startedAt: job.startedAt,
      timeoutMs: this.timeoutMs,
      isCancelled: () => job.status === 'cancelled' || job.cancelRequested,
      isAbandoned: () => this.abandoned,
    })
  }

  async finish(job, outcome) {
    if (outcome?.abandoned || this.abandoned) return
    const { logDir } = await this.context()
    const reason = await tail(join(logDir, 'ingest.log'))
    await this.mutate(async () => {
      if (job.status === 'cancelled' || job.cancelRequested || outcome.cancelled) {
        job.status = 'cancelled'
        job.error = job.error || reason || '任务已取消'
        job.finishedAt = job.finishedAt || new Date().toISOString()
        await this.save()
        return
      }
      if (outcome.timedOut) {
        job.status = 'failed'
        job.error = reason || tr('收录超时')
        job.finishedAt = new Date().toISOString()
        await this.save()
        return
      }
      if (outcome.unexpected) {
        job.status = 'failed'
        job.error = '进程意外退出'
        job.finishedAt = new Date().toISOString()
        await this.save()
        return
      }
      if (outcome.code === 0) {
        job.status = 'done'
        job.error = null
        job.finishedAt = new Date().toISOString()
        if (job.kind === 'bench') {
          this.wikiFiles = this.wikiFiles.filter(item => item.file !== job.file)
          this.wikiFiles.push({
            id: job.id, file: job.file, path: job.path, title: job.title,
            kind: 'bench', handle: job.handle, status: 'done', finishedAt: job.finishedAt,
          })
        }
        await this.save()
        return
      }
      job.status = 'failed'
      job.error = reason || tr('模型调用失败')
      job.finishedAt = new Date().toISOString()
      await this.save()
    })
  }
}
