// Only tool_execution_end payloads are data. Assistant prose is never parsed.
import { spawn as nodeSpawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { findOmp } from './omp.js'

const MODEL = 'xai-oauth/grok-4.7'
const TIMEOUT = 5 * 60 * 1000
const URL_PATTERN = /https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/g
const METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'bookmarks']

function postUrl(value) {
  const url = new URL(value)
  if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.protocol !== 'https:') throw new Error('Invalid X post URL')
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/.exec(url.pathname)
  if (!match) throw new Error('Invalid X post URL')
  return { id: match[2], handle: match[1], url: `https://x.com/${match[1]}/status/${match[2]}` }
}

function resultText(result) {
  return (result?.content ?? []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
}

function count(value) {
  if (value == null) return null
  const normalized = String(value).replaceAll(',', '').trim()
  // Rounded 3.7K display values are not exact measurements.
  return /^\d+$/.test(normalized) && Number.isSafeInteger(Number(normalized)) ? Number(normalized) : null
}

/** Observed x-search format: ## Post/Thread/Replies, ### @author · date · URL. */
export function parseReadResult(result) {
  if (result?.details?.method !== 'x-search' && !/^Method: x-search$/m.test(resultText(result))) return []
  const text = resultText(result)
  const lines = text.split('\n')
  const rows = []
  const threadRows = []
  const targets = []
  let section = ''
  let row = null
  let body = []
  let metadata = false
  const finish = () => {
    if (!row) return
    row.text = body.join('\n').trim() || null
    row.textComplete = result?.details?.truncated === false && row.text != null && !/(?:\[truncated\]|\[\.\.\.\]|…\s*\[more\]|show more\s*$)/i.test(row.text)
    rows.push(row)
    if (section === 'thread') threadRows.push(row)
    if (section === 'post') targets.push(row)
    row = null
    body = []
    metadata = false
  }
  for (const line of lines) {
    const heading = /^## (Post|Thread|Replies|Reposts)\s*$/i.exec(line)
    if (heading) { finish(); section = heading[1].toLowerCase(); continue }
    const header = /^### @([A-Za-z0-9_]{1,15})\b.*? · (.*?) · (https:\/\/\S+)/.exec(line)
    if (header) {
      finish()
      let identity
      try { identity = postUrl(header[3]) } catch { continue }
      const date = Date.parse(header[2])
      row = { ...identity, text: null, createdAt: Number.isFinite(date) ? new Date(date).toISOString() : null, ...Object.fromEntries(METRICS.map(key => [key, null])), kind: section === 'replies' ? '回复' : section === 'reposts' ? '转推' : '未知', textComplete: false }
      continue
    }
    if (!row) continue
    if (/^> ### @/.test(line)) {
      if (row.kind === '未知') row.kind = '引用'
      metadata = true
      continue
    }
    if (/^(?:Likes|Views|Reposts|Replies|Quotes|Bookmarks)[:=]/i.test(line)) {
      for (const key of METRICS) {
        const value = new RegExp(`(?:^|[·,|]\\s*)${key}[:=]\\s*([\\d,]+)(?=\\s*(?:[·,|]\\s*[A-Za-z]+[:=]|$))`, 'i').exec(line)
        if (value) row[key] = count(value[1])
      }
      metadata = true
      continue
    }
    if (/^Media:/i.test(line)) { metadata = true; continue }
    if (!metadata) body.push(line)
  }
  finish()
  let target = targets[0]
  try { target = rows.find(post => post.id === postUrl(result?.details?.url).id) } catch { /* Tool-start URL may be the only target metadata. */ }
  if (target) {
    const continuations = threadRows.filter(post => post.id !== target.id && post.text && post.handle.toLowerCase() === target.handle.toLowerCase())
    if (continuations.length) {
      target.threadPosts = [...new Map(continuations.map(post => [post.id, post])).values()]
        .sort((a, b) => (a.createdAt == null ? Infinity : Date.parse(a.createdAt)) - (b.createdAt == null ? Infinity : Date.parse(b.createdAt)))
    }
  }
  return rows
}

export function searchPostUrls(result, handle) {
  const response = result?.details?.response
  const sources = [...(response?.sources ?? []), ...(response?.citations ?? [])]
  const raw = sources.length ? sources.map(source => source.url ?? '').join('\n') : resultText(result)
  const urls = new Map()
  for (const match of raw.matchAll(URL_PATTERN)) {
    const author = match[1].toLowerCase()
    // X search citations also use author-neutral /i/status/<id> permalinks.
    // readPosts verifies the returned author before listRecent includes it.
    if (author !== handle.toLowerCase() && author !== 'i') continue
    urls.set(match[2], `https://x.com/${author === 'i' ? handle : match[1]}/status/${match[2]}`)
  }
  return [...urls.values()]
}

/** Each batch runs in an empty temporary cwd, never in the user's vault. */
export function createGrokX({ settings = {}, spawn = nodeSpawn } = {}) {
  async function logged(method, input, operation) {
    const started = Date.now()
    const config = typeof settings.read === 'function' ? await settings.read() : settings
    const logDir = config.logDir || join(tmpdir(), 'dsh-media-desk-grokx')
    await mkdir(logDir, { recursive: true })
    let rows = 0
    let error = null
    try {
      const value = await operation()
      rows = Array.isArray(value) ? value.length : value.posts.length
      return value
    } catch (err) {
      error = String(err?.message || err)
      throw err
    } finally {
      await appendFile(join(logDir, 'grokx.log'), JSON.stringify({ at: new Date().toISOString(), method, input, elapsedMs: Date.now() - started, posts: rows, error }) + '\n')
    }
  }

  async function run(prompt, toolName, requested = []) {
    const bin = spawn === nodeSpawn ? findOmp() : 'omp'
    if (!bin) throw new Error('omp executable not found')
    const cwd = await mkdtemp(join(tmpdir(), 'media-desk-grokx-'))
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(bin, ['-p', '--mode', 'json', '--no-session', '--no-skills', '--no-rules', '--no-context-files', '--model', MODEL, '--cwd', cwd, prompt], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        const decoder = new StringDecoder('utf8')
        let pending = ''
        let stderr = ''
        let done = false
        let satisfied = false
        const results = []
        const completed = new Map()
        const missing = new Map(requested.map(post => [post.id, 'Grok X did not return requested tool results']))
        const starts = new Map()
        const timer = setTimeout(() => { finish(new Error('Grok X batch timed out after 5 minutes')); child.kill('SIGKILL') }, TIMEOUT)
        const finish = (error) => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve({
            results,
            posts: [...completed.values()],
            failed: requested.filter(post => !completed.has(post.id)).map(({ id, url }) => ({ id, url, reason: missing.get(id) })),
          })
        }
        const take = (line) => {
          if (done || satisfied) return
          let event
          try { event = JSON.parse(line) } catch { return }
          if (event.type === 'tool_execution_start') { starts.set(event.toolCallId, event); return }
          if (event.type !== 'tool_execution_end' || event.toolName !== toolName) return
          if (event.isError) { finish(new Error(`Grok X ${toolName} tool failed`)); child.kill('SIGKILL'); return }
          if (toolName === 'read') {
            let target
            try {
              const source = event.result?.details?.url || starts.get(event.toolCallId)?.args?.path
              target = requested.find(post => post.id === postUrl(source).id)
            } catch { /* No verified tool target. */ }
            if (target) {
              const post = event.result?.details?.method === 'x-search' ? parseReadResult(event.result).find(row => row.id === target.id) : null
              if (post?.text && post.textComplete) completed.set(target.id, post)
              else missing.set(target.id, post?.text ? 'Grok X returned an incomplete post body' : 'Grok X returned no full post body')
            }
          } else results.push(event.result)
          satisfied = toolName === 'web_search' || requested.every(post => completed.has(post.id))
          // Unavailable or incomplete reads must leave room for a later model retry.
          if (satisfied) child.kill('SIGTERM')
        }
        child.stdout?.on('data', chunk => {
          pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          let index
          while ((index = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, index)
            pending = pending.slice(index + 1)
            take(line)
          }
        })
        child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-500) })
        child.on('error', err => finish(err))
        child.on('close', (code, signal) => {
          pending += decoder.end()
          if (pending) take(pending)
          if (done) return
          if (code !== 0 && !(satisfied && (signal === 'SIGTERM' || code === 143))) { finish(new Error(`Grok X exited ${code ?? signal}: ${stderr}`)); return }
          finish()
        })
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }

  async function readPosts(urls, { partial = false } = {}) {
    return logged('readPosts', urls, async () => {
      if (!Array.isArray(urls)) throw new Error('X post URLs must be an array')
      const requested = [...new Map(urls.map(url => { const post = postUrl(url); return [post.id, post] })).values()]
      const completed = new Map()
      const failed = []
      for (let offset = 0; offset < requested.length; offset += 10) {
        let missing = requested.slice(offset, offset + 10)
        // A natural exit may leave some URLs unread. Retry only those URLs, once.
        for (let attempt = 0; attempt < 2 && missing.length; attempt++) {
          const result = await run('对下面每个链接调用 read 工具。只调用工具，不总结或转述。\n' + missing.map(post => post.url).join('\n'), 'read', missing)
          for (const post of result.posts) completed.set(post.id, post)
          missing = result.failed
        }
        failed.push(...missing)
      }
      const posts = requested.flatMap(post => completed.has(post.id) ? [completed.get(post.id)] : [])
      if (partial) return { posts, failed }
      if (failed.length) throw new Error(failed.map(post => `${post.reason} for ${post.id} (${post.url})`).join('; '))
      return posts
    })
  }

  async function listRecent(handle, { sinceDays = 3 } = {}) {
    return logged('listRecent', { handle, sinceDays }, async () => {
      handle = String(handle).replace(/^@/, '')
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('Invalid X handle')
      if (!Number.isFinite(sinceDays) || sinceDays <= 0) throw new Error('sinceDays must be positive')
      const cutoff = Date.now() - sinceDays * 86400000
      const since = new Date(cutoff).toISOString().slice(0, 10)
      const { results } = await run(`调用 web_search 查 from:${handle} since:${since} -filter:replies -filter:retweets。只调用工具，不总结或转述。`, 'web_search')
      if (!results.length) throw new Error('Grok X did not return requested tool results')
      const urls = [...new Set(results.flatMap(result => searchPostUrls(result, handle)))]
      const { posts, failed } = await readPosts(urls, { partial: true })
      const recent = posts.filter(post => post.handle.toLowerCase() === handle.toLowerCase() && !['回复', '转推'].includes(post.kind) && (post.createdAt == null || Date.parse(post.createdAt) >= cutoff))
      // Only this search explicitly excludes replies and reposts.
      for (const post of recent) if (post.kind === '未知') post.kind = '原创'
      recent.missed = failed.length
      recent.failed = failed
      return recent
    })
  }

  async function readThread(url) {
    return logged('readThread', url, async () => {
      const posts = await readPosts([url])
      // x-search exposes sampled replies, not parent IDs or an exhaustive thread cursor.
      // Combining those replies would silently turn unrelated self-replies into a thread.
      return { posts, threadComplete: false }
    })
  }

  return { readPosts, listRecent, readThread }
}
