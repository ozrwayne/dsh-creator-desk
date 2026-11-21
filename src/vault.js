// 知识库里的收藏和知识原子。路径一律相对 vaultRoot，拒绝跳出允许的目录。
import { appendFile, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tr } from './i18n.js'
import { moveToTrash } from './trash.js'

export const PATHS = {
  favorites: '收藏',
  archived: '已处理收藏',
  images: '收藏/images',
  pending: '知识原子/待确认',
  atoms: '知识原子/已确认',
  wiki: '知识来源',
  bench: '对标/X原文',
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const IMAGE = /!\[\[[^\]]*\/images\/([\w.-]+)\|Image\]\]/
const EXCERPT = 120

export function httpError(status, message) {
  return Object.assign(new Error(tr(message)), { status })
}

export function localDay(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function shiftDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + delta)
  return localDay(date)
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function inFavoriteSpan(row, days, now) {
  if (days === 'all') return true
  // 日期目录名是本地日历日。最近 n 天含今天，起点是今天往前 n-1 天
  const span = clampInt(days, 1, 3660, 14)
  const today = localDay(now)
  const start = shiftDay(today, -(span - 1))
  return row.date >= start && row.date <= today
}

function posix(root, file) {
  return relative(root, file).split(sep).join('/')
}

function inside(root, file) {
  const rel = relative(root, file)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function atomTitle(filename) {
  return filename.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}-/, '')
}

export function splitFrontmatter(text) {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!src.startsWith('---')) return { meta: {}, body: src }
  const end = src.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: src }
  const meta = {}
  for (const line of src.slice(4, end).split('\n')) {
    const match = /^([\w\u4e00-\u9fff.-]+)\s*:\s*(.*)$/.exec(line)
    if (match) meta[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
  }
  let bodyAt = end + 4
  if (src[bodyAt] === '\n') bodyAt += 1
  return { meta, body: src.slice(bodyAt) }
}

export function splitTagHeader(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  const meta = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i += 1; break }
    const match = /^([^:：]{1,40})[:：]\s*(.*)$/.exec(line)
    if (!match) break
    meta[match[1].trim()] = match[2].trim()
    i += 1
  }
  return { meta, body: lines.slice(i).join('\n') }
}

export function excerptOf(text, limit = EXCERPT) {
  const plain = String(text ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return [...plain].slice(0, limit).join('')
}


function firstImage(body) {
  const name = IMAGE.exec(body)?.[1]
  if (!name || name === '.' || name === '..' || name.includes('..')) return null
  return name
}

async function readDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return []
    throw err
  }
}

async function walkFiles(dir, visit) {
  for (const entry of await readDir(dir)) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(file, visit)
    else if (entry.isFile()) await visit(file, entry.name)
  }
}

async function realChild(rootDir, file, missing) {
  let realRoot
  let realFile
  try {
    realRoot = await realpath(rootDir)
    realFile = await realpath(file)
  } catch (err) {
    if (err.code === 'ENOENT') throw httpError(404, missing)
    throw err
  }
  if (!inside(realRoot, realFile)) throw httpError(400, '路径无效')
  return realFile
}

function replaceFrontmatterOnce(text, oldRel, newRel) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const at = text.slice(0, end).indexOf(oldRel)
  if (at < 0) return null
  return text.slice(0, at) + newRel + text.slice(at + oldRel.length)
}

function cleanAtomTitle(title) {
  const cleaned = String(title ?? '').replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim()
  return [...cleaned].slice(0, 80).join('').trim()
}

function replaceFirstHeading(text, title) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const index = lines.findIndex(line => line.startsWith('# '))
  if (index < 0) return text
  lines[index] = `# ${title}`
  return lines.join(nl)
}

async function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, file)
}
function skippedName(name) {
  return name.includes('sync-conflict') || name.startsWith('.syncthing.')
}

export async function rewriteAttachmentIndex(indexPath, oldRel, newRel) {
  if (!indexPath || !oldRel || oldRel === newRel) return false
  let text
  try {
    text = await readFile(indexPath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
  if (!text.includes(oldRel)) return false
  const next = text.replaceAll(oldRel, newRel)
  if (next === text) return false
  await atomicWrite(indexPath, next)
  return true
}
export function matchAtomLink(rows, rel) {
  const name = String(rel || '').split('/').pop()
  if (!name || !name.endsWith('.md')) return null
  let named = null
  const list = Array.isArray(rows) ? rows : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const row = list[i]
    const atoms = Array.isArray(row?.atoms) ? row.atoms : []
    if (atoms.includes(rel)) return row
    if (!named && atoms.some(atom => String(atom).split('/').pop() === name)) named = row
  }
  return named
}



export class Vault {
  constructor(root, options = {}) {
    this.root = resolve(root)
    this.attachmentIndex = options.attachmentIndex || ''
    this.now = options.now || (() => new Date())
    this.dataDir = options.dataDir || ''
  }

  abs(...parts) {
    return join(this.root, ...parts)
  }

  parseFavoriteId(id) {
    const match = /^fav:(\d{4}-\d{2}-\d{2})\/([^/\\]+)$/.exec(String(id ?? ''))
    if (!match) throw httpError(400, '路径无效')
    const [, day, name] = match
    // 标题里常有省略号「...」，只拒绝真正的路径分隔和上级目录
    if (!DAY.test(day) || !name.endsWith('.md') || name.includes('/') || name.includes('\\') || name.startsWith('同步助手_')) throw httpError(400, '路径无效')
    const rel = `${PATHS.favorites}/${day}/${name}`
    const file = this.abs(PATHS.favorites, day, name)
    if (!inside(this.abs(PATHS.favorites), file)) throw httpError(400, '路径无效')
    return { id: `fav:${day}/${name}`, day, name, rel, file, title: name.replace(/\.md$/i, '') }
  }

  parseBenchId(id) {
    const raw = String(id ?? '')
    if (!raw.startsWith('bench:')) throw httpError(400, '路径无效')
    const input = raw.slice(6)
    const path = input.startsWith(`${PATHS.bench}/`) ? input.slice(PATHS.bench.length + 1) : input
    const parts = path.split('/')
    if (parts.length !== 2 || !/^[A-Za-z0-9_]{1,15}$/.test(parts[0]) || !parts[1].endsWith('.md')
      || parts.some(part => !part || part === '.' || part === '..') || /[\\\0]/.test(path)) throw httpError(400, '路径无效')
    const rel = `${PATHS.bench}/${path}`
    return { id: `bench:${path}`, kind: 'bench', handle: parts[0], rel, file: this.abs(rel), title: parts[1].replace(/\.md$/i, '') }
  }

  parseSourceId(id) {
    return String(id ?? '').startsWith('bench:') ? this.parseBenchId(id) : { ...this.parseFavoriteId(id), kind: 'fav', handle: '' }
  }

  async benchRecord(spec) {
    const file = await realChild(this.abs(PATHS.bench), spec.file, '找不到这条记录')
    if (!(await stat(file)).isFile()) throw httpError(400, '路径无效')
    const text = await readFile(file, 'utf8')
    const { meta, body } = splitTagHeader(text)
    return {
      id: spec.id, path: spec.rel, title: spec.title, handle: spec.handle,
      place: 'bench', origin: 'bench', meta, body, raw: text,
      date: meta.日期 || '', author: meta.作者 || `@${spec.handle}`,
      url: /\]\((https?:\/\/[^)]+)\)/.exec(meta.来源 || '')?.[1] || '',
      excerpt: excerptOf(body),
    }
  }

  async sourceRecord(spec) {
    return spec.kind === 'bench' ? this.benchRecord(spec) : this.favoriteRecord(spec)
  }

  async readLinks() {
    if (!this.dataDir) return []
    try {
      const text = await readFile(join(this.dataDir, 'links.jsonl'), 'utf8')
      return text.split('\n').flatMap(line => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }
  }

  atomSource(rel, links) {
    const hit = matchAtomLink(links, rel)
    if (hit?.kind === 'bench') {
      try {
        const spec = this.parseBenchId(`bench:${hit.path}`)
        return { origin: 'bench', handle: spec.handle, fromBench: { handle: spec.handle, path: spec.rel, title: spec.title } }
      } catch { return { origin: 'other', handle: '' } }
    }
    return { origin: hit?.favorite ? 'fav' : 'other', handle: '' }
  }

  async recordAtomEvent(action, path, source) {
    if (!this.dataDir) return
    await mkdir(this.dataDir, { recursive: true })
    await appendFile(join(this.dataDir, 'atom-events.jsonl'), `${JSON.stringify({
      at: this.now().toISOString(), action, path, origin: source.origin, handle: source.handle,
    })}\n`)
  }

  parseAtomId(id, { pendingOnly = false, rejectMessage = '路径无效' } = {}) {
    const raw = String(id ?? '')
    if (!raw.startsWith('atom:')) throw httpError(400, '路径无效')
    const rel = raw.slice('atom:'.length)
    if (!rel.endsWith('.md') || rel.split('/').includes('..') || rel.includes('\\') || rel.startsWith('/') || rel.includes('\0')) throw httpError(400, '路径无效')
    const pending = rel.startsWith(`${PATHS.pending}/`)
    const atom = rel.startsWith(`${PATHS.atoms}/`)
    if (pendingOnly && !pending) throw httpError(400, rejectMessage)
    if (!pending && !atom) throw httpError(400, '路径无效')
    const file = resolve(this.root, ...rel.split('/'))
    const allowed = this.abs(pending ? PATHS.pending : PATHS.atoms)
    if (!inside(allowed, file) && file !== allowed) throw httpError(400, '路径无效')
    return { id: `atom:${rel}`, rel, file, place: pending ? 'pending' : 'atom' }
  }

  async readFavorite(spec) {
    const spots = [
      { root: PATHS.favorites, rel: spec.rel, file: spec.file },
      { root: PATHS.archived, rel: `${PATHS.archived}/${spec.day}/${spec.name}`, file: this.abs(PATHS.archived, spec.day, spec.name) },
    ]
    for (const spot of spots) {
      if (!inside(this.abs(spot.root), spot.file)) continue
      let text
      try {
        text = await readFile(spot.file, 'utf8')
      } catch (err) {
        if (err.code === 'ENOENT') continue
        throw err
      }
      const { meta, body } = splitFrontmatter(text)
      return {
        id: spec.id,
        path: spot.rel,
        title: spec.title,
        author: meta.author || '',
        source: meta.source || '',
        url: meta.url || '',
        saved: meta.saved || '',
        date: spec.day,
        excerpt: excerptOf(body),
        image: firstImage(body),
        place: 'fav',
        body,
      }
    }
    return null
  }

  async favoriteRecord(spec) {
    let text
    try {
      text = await readFile(spec.file, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
    const { meta, body } = splitFrontmatter(text)
    return {
      id: spec.id,
      path: spec.rel,
      title: spec.title,
      author: meta.author || '',
      source: meta.source || '',
      url: meta.url || '',
      saved: meta.saved || '',
      date: spec.day,
      excerpt: excerptOf(body),
      image: firstImage(body),
      place: 'fav',
      body,
    }
  }

  async listFavorites() {
    const root = this.abs(PATHS.favorites)
    const rows = []
    for (const entry of await readDir(root)) {
      if (!entry.isDirectory() || !DAY.test(entry.name)) continue
      const dir = join(root, entry.name)
      for (const file of await readDir(dir)) {
        if (!file.isFile() || !file.name.endsWith('.md') || file.name.startsWith('同步助手_') || skippedName(file.name)) continue
        const spec = this.parseFavoriteId(`fav:${entry.name}/${file.name}`)
        const row = await this.favoriteRecord(spec)
        if (row) rows.push(row)
      }
    }
    rows.sort((a, b) => b.date.localeCompare(a.date) || b.saved.localeCompare(a.saved) || a.title.localeCompare(b.title, 'zh'))
    return rows
  }

  async activityDays(now = new Date(), span = 60) {
    // 只数日期目录里的稿，不读正文。已归档的也算，连续记录才不会在处理后断掉
    const today = localDay(now)
    const start = shiftDay(today, -(clampInt(span, 1, 3660, 60) - 1))
    const totals = new Map()
    for (const rel of [PATHS.favorites, PATHS.archived]) {
      for (const entry of await readDir(this.abs(rel))) {
        if (!entry.isDirectory() || !DAY.test(entry.name) || entry.name < start || entry.name > today) continue
        let n = 0
        for (const file of await readDir(this.abs(rel, entry.name))) {
          if (!file.isFile() || !file.name.endsWith('.md') || file.name.startsWith('同步助手_') || skippedName(file.name)) continue
          n += 1
        }
        if (n) totals.set(entry.name, (totals.get(entry.name) || 0) + n)
      }
    }
    return [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, favorites]) => ({ date, favorites }))
  }

  async listAtoms(dirRel, place, links = null) {
    const root = this.abs(dirRel)
    const rows = []
    links ??= await this.readLinks()
    await walkFiles(root, async (file, name) => {
      if (!name.endsWith('.md') || skippedName(name)) return
      const rel = posix(this.root, file)
      if (!rel.startsWith(`${dirRel}/`) || rel.split('/').includes('..')) return
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch {
        return
      }
      const { meta, body } = splitTagHeader(text)
      const filename = name
      const dateMatch = /^(\d{4}-\d{2}-\d{2})-/.exec(filename)
      rows.push({
        id: `atom:${rel}`,
        path: rel,
        ...this.atomSource(rel, links),
        title: atomTitle(filename),
        date: dateMatch?.[1] || String(meta.日期 || '').slice(0, 10),
        group: place === 'pending' ? rel.slice(dirRel.length + 1, rel.length - filename.length - 1) : '',
        meta,
        excerpt: excerptOf(body),
        place,
        body,
      })
    })
    rows.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'zh'))
    return rows
  }

  attach({ body, ...row }, positions) {
    return { ...row, pos: positions[row.id] ?? null }
  }

  async inbox({ days = 14, q = '', offset = 0, limit, now = new Date(), positions = {} } = {}) {
    const query = String(q ?? '').trim().toLowerCase()
    const all = await this.listFavorites()
    const links = await this.readLinks()
    const pending = await this.listAtoms(PATHS.pending, 'pending', links)
    const atoms = await this.listAtoms(PATHS.atoms, 'atom', links)
    let favorites = query
      ? all.filter(row => `${row.title}\n${row.author}\n${row.source}`.toLowerCase().includes(query))
      : all.filter(row => inFavoriteSpan(row, days, now))
    const favoriteTotal = favorites.length
    let favoriteMore = false
    if (query || limit != null) {
      const start = Math.max(0, clampInt(offset, 0, 1_000_000, 0))
      const size = clampInt(limit, 1, 100, 30)
      favoriteMore = start + size < favorites.length
      favorites = favorites.slice(start, start + size)
    }
    return {
      favorites: favorites.map(row => this.attach(row, positions)),
      pending: pending.map(row => this.attach(row, positions)),
      atoms: atoms.map(row => this.attach(row, positions)),
      favoriteIds: all.map(row => row.id),
      counts: { favorites: all.length, pending: pending.length, atoms: atoms.length },
      days: await this.activityDays(now),
      favoriteMore,
      favoriteTotal,
    }
  }

  async item(id) {
    if (String(id).startsWith('bench:')) return this.benchRecord(this.parseBenchId(id))
    if (String(id).startsWith('fav:')) {
      const spec = this.parseFavoriteId(id)
      const row = await this.readFavorite(spec)
      if (!row) throw httpError(404, '找不到这篇收藏')
      return row
    }
    const spec = this.parseAtomId(id)
    let text
    try {
      text = await readFile(spec.file, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') throw httpError(404, '找不到这条记录')
      throw err
    }
    const { meta, body } = splitTagHeader(text)
    const name = spec.rel.slice(spec.rel.lastIndexOf('/') + 1)
    const dateMatch = /^(\d{4}-\d{2}-\d{2})-/.exec(name)
    const info = await stat(spec.file)
    return {
      id: spec.id,
      path: spec.rel,
      ...this.atomSource(spec.rel, await this.readLinks()),
      title: atomTitle(name),
      date: dateMatch?.[1] || String(meta.日期 || '').slice(0, 10),
      group: spec.place === 'pending' ? spec.rel.slice(PATHS.pending.length + 1, spec.rel.length - name.length - 1) : '',
      meta,
      excerpt: excerptOf(body),
      place: spec.place,
      body,
      raw: text,
      mtimeMs: info.mtimeMs,
    }
  }

  async imageFile(name) {
    if (!/^[\w.-]+$/.test(String(name ?? '')) || name === '.' || name === '..' || String(name).includes('..')) throw httpError(400, '路径无效')
    const dir = this.abs(PATHS.images)
    const file = join(dir, name)
    try {
      const realDir = await realpath(dir)
      const realFile = await realpath(file)
      if (!inside(realDir, realFile)) throw httpError(400, '路径无效')
      return realFile
    } catch (err) {
      if (err.status) throw err
      if (err.code === 'ENOENT') throw httpError(404, '图片不存在')
      throw err
    }
  }

  async moveFavorite(spec) {
    await realChild(this.abs(PATHS.favorites), spec.file, '找不到这篇收藏')
    const destRel = `${PATHS.archived}/${spec.day}/${spec.name}`
    const dest = this.abs(PATHS.archived, spec.day, spec.name)
    await mkdir(this.abs(PATHS.archived, spec.day), { recursive: true })
    try {
      await stat(dest)
      throw httpError(409, '目标已存在')
    } catch (err) {
      if (err.status) throw err
      if (err.code !== 'ENOENT') throw err
    }
    const realDestDir = await realpath(this.abs(PATHS.archived, spec.day))
    if (!inside(await realpath(this.abs(PATHS.archived)), realDestDir) && realDestDir !== await realpath(this.abs(PATHS.archived))) throw httpError(400, '路径无效')
    await rename(spec.file, dest)
    await this.rewriteWiki(spec.rel, destRel)
    return { from: spec.rel, to: destRel }
  }

  async archive(id) {
    const moved = await this.moveFavorite(this.parseFavoriteId(id))
    await rewriteAttachmentIndex(this.attachmentIndex, moved.from, moved.to)
    return moved
  }

  async rewriteWiki(oldRel, newRel) {
    const dir = this.abs(PATHS.wiki)
    for (const entry of await readDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const file = join(dir, entry.name)
      const text = await readFile(file, 'utf8')
      const next = replaceFrontmatterOnce(text, oldRel, newRel)
      if (next == null || next === text) continue
      await atomicWrite(file, next)
    }
  }

  async confirm(id) {
    const spec = this.parseAtomId(id, { pendingOnly: true, rejectMessage: '只能确认待确认的笔记' })
    await realChild(this.abs(PATHS.pending), spec.file, '找不到这条记录')
    const name = spec.rel.slice(spec.rel.lastIndexOf('/') + 1)
    const dest = this.abs(PATHS.atoms, name)
    await mkdir(this.abs(PATHS.atoms), { recursive: true })
    try {
      await stat(dest)
      throw httpError(409, '目标已存在')
    } catch (err) {
      if (err.status) throw err
      if (err.code !== 'ENOENT') throw err
    }
    const source = this.atomSource(spec.rel, await this.readLinks())
    await rename(spec.file, dest)
    await this.recordAtomEvent('confirm', spec.rel, source)
    return { from: spec.rel, to: `${PATHS.atoms}/${name}` }
  }

  async reject(id) {
    const spec = this.parseAtomId(id, { pendingOnly: true, rejectMessage: '只能否决待确认的笔记' })
    const file = await realChild(this.abs(PATHS.pending), spec.file, '找不到这条记录')
    const info = await stat(file)
    if (!info.isFile() || !file.endsWith('.md')) throw httpError(400, '只能否决待确认的笔记')
    const source = this.atomSource(spec.rel, await this.readLinks())
    const path = await moveToTrash(this.root, file, this.now())
    await this.recordAtomEvent('reject', spec.rel, source)
    return { path }
  }

  async archiveMany(ids) {
    if (!Array.isArray(ids)) throw httpError(400, 'ids 必须是列表')
    if (ids.length > 100) throw httpError(400, '单次最多 100 篇')
    const archived = []
    const failed = []
    for (const id of ids) {
      const key = String(id ?? '')
      try {
        const moved = await this.archive(key)
        archived.push({ id: key, ...moved })
      } catch (err) {
        failed.push({ id: key, error: err.message || tr('路径无效') })
      }
    }
    return { archived, failed }
  }

  async save({ id, raw, mtimeMs }) {
    const file = await this.editableFile(id)
    if (typeof raw !== 'string' || raw.trim() === '') throw httpError(400, '内容不能为空')
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) throw httpError(400, '缺少修改时间')
    const info = await stat(file)
    if (info.mtimeMs !== mtimeMs) throw httpError(409, '文件已在别处修改，请重新打开')
    await atomicWrite(file, raw)
    return { path: posix(this.root, file) }
  }

  async rename({ id, title }) {
    const spec = this.editableSpec(id)
    const file = await realChild(this.abs(spec.place === 'pending' ? PATHS.pending : PATHS.atoms), spec.file, '找不到这条记录')
    const cleaned = cleanAtomTitle(title)
    if (!cleaned) throw httpError(400, '标题不能为空')
    const slash = spec.rel.lastIndexOf('/')
    const name = spec.rel.slice(slash + 1)
    const fromNote = name.replace(/\.md$/i, '')
    const date = /^(\d{4}-\d{2}-\d{2})-/.exec(name)?.[1]
    const nextName = `${date ? `${date}-` : ''}${cleaned}.md`
    const toNote = nextName.replace(/\.md$/i, '')
    const nextRel = `${spec.rel.slice(0, slash)}/${nextName}`
    const nextFile = join(file, '..', nextName)
    const allowed = await realpath(this.abs(spec.place === 'pending' ? PATHS.pending : PATHS.atoms))
    if (!inside(allowed, nextFile)) throw httpError(400, '路径无效')
    const srcInfo = await stat(file)
    try {
      const destInfo = await stat(nextFile)
      if (destInfo.ino !== srcInfo.ino || destInfo.dev !== srcInfo.dev) throw httpError(409, '目标已存在')
    } catch (err) {
      if (err.status) throw err
      if (err.code !== 'ENOENT') throw err
    }
    const text = await readFile(file, 'utf8')
    const nextText = replaceFirstHeading(text, cleaned)
    if (nextFile !== file) await rename(file, nextFile)
    if (nextText !== text || nextFile !== file) await atomicWrite(nextFile, nextText)
    return { id: `atom:${nextRel}`, title: cleaned, fromNote, toNote }
  }

  editableSpec(id) {
    if (String(id ?? '').startsWith('fav:')) throw httpError(400, '收藏不能修改')
    return this.parseAtomId(id)
  }

  async editableFile(id) {
    const spec = this.editableSpec(id)
    const root = this.abs(spec.place === 'pending' ? PATHS.pending : PATHS.atoms)
    const file = await realChild(root, spec.file, '找不到这条记录')
    const info = await stat(file)
    if (!info.isFile() || !file.endsWith('.md')) throw httpError(400, '路径无效')
    return file
  }

  async listPendingFiles() {
    const found = new Set()
    await walkFiles(this.abs(PATHS.pending), async (file, name) => {
      if (name.endsWith('.md')) found.add(posix(this.root, file))
    })
    return found
  }

  absolute(rel) {
    if (!rel || rel.split('/').includes('..') || rel.startsWith('/') || rel.includes('\\')) throw httpError(400, '路径无效')
    const file = resolve(this.root, ...String(rel).split('/'))
    if (!inside(this.root, file) && file !== this.root) throw httpError(400, '路径无效')
    return file
  }
}
