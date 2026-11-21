// 受管稿件。文件夹是状态的唯一依据；标签头只描述稿件，扫描时若和文件夹不符就改这一个键。
import { appendFile, open, link, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { buildBoard } from './board.js'
import { planImport } from './metrics.js'
import { openTrashDir, uniqueDest } from './trash.js'
export const FORMS = [
  { id: '短推', enabled: true },
  { id: '长文', enabled: true },
  { id: '视频', enabled: true },
  { id: '播客', enabled: false },
]

const ROOT = '稿件'

export const STATUS_DIRS = {
  短推: {
    进行中: `${ROOT}/短推/草稿`,
    定稿: `${ROOT}/短推/待发布`,
    已发布: `${ROOT}/短推/已发布`,
  },
  长文: {
    进行中: `${ROOT}/长文/草稿`,
    定稿: `${ROOT}/长文/待发布`,
    已发布: `${ROOT}/长文/已发布`,
  },
  视频: {
    进行中: `${ROOT}/视频/草稿`,
    定稿: `${ROOT}/视频/待发布`,
    已发布: `${ROOT}/视频/已发布`,
  },
}

export const ORIGIN_DIR = '知识原子/已确认'

export const STAGES = ['0想法', '1测试', '2验证', '3升级', '4沉淀']
export const STATUSES = ['进行中', '定稿', '已发布']
export const ALL_PLATFORMS = ['X', '公众号', '知乎', '今日头条', 'LinkedIn', 'Substack', '小红书', '抖音', '视频号', 'B站', 'YouTube', 'Instagram', '小宇宙']
export const DEFAULT_THRESHOLD = 3000
// 标签头可能很长：一篇长文并入 4 条原子、分发到 12 个平台就超过 2048 字节
const HEAD_LIMIT = 8192

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})-/
const ILLEGAL_TITLE = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|', '#', '^', '[', ']'])
const SCHEDULE_AT = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/
// 长文另外用到的知识原子，一行一个，只指 知识原子 里的原子
const MERGE_KEY = '并入'
const MISSING_ATOM = '并入的知识原子不存在'

const DEFAULTS = {
  短推: { accounts: '纸飞机编辑部', platforms: 'X' },
  长文: { accounts: '纸飞机编辑部', platforms: 'X, 公众号' },
  视频: { accounts: '纸飞机放映室', platforms: '视频号, 抖音, 小红书, YouTube' },
}

export function fail(status, message) {
  return Object.assign(new Error(message), { status })
}

export function ymd(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function sanitizeTitle(title) {
  const stripped = [...String(title ?? '')].filter(ch => !ILLEGAL_TITLE.has(ch)).join('')
  return stripped.replace(/\s+/g, ' ').trim().slice(0, 80).trim()
}

export function lineNameOf(filename) {
  const base = filename.endsWith('.md') ? filename.slice(0, -3) : filename
  const dated = base.replace(/^\d{4}-\d{2}-\d{2}-/, '')
  return dated.trim() || base
}

export function pieceTitle(note) {
  return String(note).replace(/^\d{4}-\d{2}-\d{2}-/, '')
}

// 省略号是文件名的一部分。只拒绝路径分隔和单独的 . / .. 段。
export function validNote(note) {
  if (typeof note !== 'string' || note.length === 0 || note.length > 240) return false
  if (note.includes('/') || note.includes('\\') || note.includes('\0')) return false
  const parts = note.split(/[/\\]/)
  return parts.every(part => part !== '' && part !== '.' && part !== '..')
}

export function unwrapSource(value) {
  if (typeof value !== 'string') return ''
  const match = /^\[\[([\s\S]+)\]\]$/.exec(value.trim())
  return match ? match[1].trim() : value
}

export function splitDocument(content) {
  const entries = []
  let i = 0
  while (i < content.length) {
    const nl = content.indexOf('\n', i)
    if (nl === -1) {
      const line = content.slice(i)
      const match = /^([^\s:]+): ?(.*)$/.exec(line)
      if (!match) break
      entries.push({ key: match[1], value: match[2], original: match[2], raw: line, eol: '' })
      i = content.length
      break
    }
    let line = content.slice(i, nl)
    let eol = '\n'
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
      eol = '\r\n'
    }
    const match = line === '' ? null : /^([^\s:]+): ?(.*)$/.exec(line)
    if (!match) break
    entries.push({ key: match[1], value: match[2], original: match[2], raw: line, eol })
    i = nl + 1
  }
  return { entries, body: content.slice(i), headerRaw: content.slice(0, i) }
}

export function renderHeader(entries) {
  let out = ''
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const line = entry.raw != null && entry.value === entry.original ? entry.raw : `${entry.key}: ${entry.value}`
    const eol = entry.eol || ''
    out += line + (i < entries.length - 1 ? (eol || '\n') : eol)
  }
  return out
}

export function parseDist(value) {
  const parts = String(value).split(' | ')
  if (parts.length !== 4) return null
  const imp = parts[3].trim()
  const impressions = imp === '' ? null : (/^\d+$/.test(imp) ? Number(imp) : null)
  return { platform: parts[0], date: parts[1], url: parts[2], impressions }
}

export function parseSchedule(value) {
  const parts = String(value).split(' | ')
  if (parts.length !== 2) return null
  const at = parts[1].trim()
  if (!SCHEDULE_AT.test(at)) return null
  return { platform: parts[0].trim(), at }
}

function splitList(value) {
  if (!value || !String(value).trim()) return []
  return String(value).split(',').map(item => item.trim()).filter(Boolean)
}

function joinList(list) {
  return list.map(item => String(item).trim()).filter(Boolean).join(', ')
}

function firstValue(entries, key) {
  return entries.find(entry => entry.key === key)?.value
}

function setEntry(entries, key, value) {
  const found = entries.find(entry => entry.key === key)
  if (found) {
    found.value = value
    return found
  }
  const entry = { key, value, original: undefined, raw: null, eol: entries.at(-1)?.eol || '\n' }
  entries.push(entry)
  return entry
}

export function raiseStage(current, minimum) {
  const at = STAGES.indexOf(current)
  const floor = STAGES.indexOf(minimum)
  if (floor < 0) return current || ''
  if (at < 0) return minimum
  return STAGES[Math.max(at, floor)]
}

function problemsOf(entries, folderStatus) {
  const problems = []
  const stage = firstValue(entries, '阶段')
  const status = firstValue(entries, '状态')
  if (stage && !STAGES.includes(stage)) problems.push(`阶段「${stage}」不在枚举里`)
  if (status && !STATUSES.includes(status)) problems.push(`状态「${status}」不在枚举里`)
  for (const entry of entries) {
    if (entry.key === '分发' && !parseDist(entry.value)) problems.push('分发行格式不对')
    if (entry.key === '排期' && !parseSchedule(entry.value)) problems.push('排期行格式不对')
  }
  const published = entries.some(entry => entry.key === '分发' && parseDist(entry.value))
  if (folderStatus === '已发布' && !published) problems.push('在已发布文件夹，但没有发布记录')
  return problems
}

function mergedOf(entries) {
  const merged = []
  for (const entry of entries) {
    if (entry.key !== MERGE_KEY) continue
    const name = unwrapSource(entry.value).trim()
    if (name && !merged.includes(name)) merged.push(name)
  }
  return merged
}

function withMergeProblems(piece, origins) {
  if (piece.form !== '长文' || !piece.merged.length) return piece
  const extra = []
  for (const atom of piece.merged) {
    const origin = origins.find(item => item.note === atom)
    if (!origin) {
      if (!extra.includes(MISSING_ATOM)) extra.push(MISSING_ATOM)
    }
  }
  return extra.length ? { ...piece, problems: [...piece.problems, ...extra] } : piece
}

// 主线的原点原子：顺着来源找到短推，短推的来源就是原子。
function mainOriginOf(pieces, piece) {
  const byNote = new Map(pieces.map(item => [item.note, item]))
  const seen = new Set()
  let current = piece
  while (current && !seen.has(current.note)) {
    if (current.form === '短推') return current.source
    seen.add(current.note)
    current = byNote.get(current.source)
  }
  return ''
}

function looksManaged(head) {
  if (!head || head.startsWith('---')) return false
  const lines = head.split(/\r?\n/)
  const entries = []
  for (const line of lines) {
    if (line === '') break
    const match = /^([^\s:]+): ?(.*)$/.exec(line)
    if (!match) return false
    entries.push(match)
  }
  if (!entries.length) return false
  const topic = entries.find(item => item[1] === '选题')
  const stage = entries.find(item => item[1] === '阶段')
  return Boolean(topic && topic[2].trim() && stage && stage[2].trim())
}

function toPiece(doc) {
  const distributions = []
  const schedules = []
  for (const entry of doc.entries) {
    if (entry.key === '分发') {
      const parsed = parseDist(entry.value)
      if (parsed) distributions.push(parsed)
    }
    if (entry.key === '排期') {
      const parsed = parseSchedule(entry.value)
      if (parsed) schedules.push(parsed)
    }
  }
  return {
    note: doc.note,
    form: doc.form,
    title: pieceTitle(doc.note),
    date: firstValue(doc.entries, '日期') || '',
    accounts: splitList(firstValue(doc.entries, '账号')),
    platforms: splitList(firstValue(doc.entries, '平台')),
    source: unwrapSource(firstValue(doc.entries, '来源') || ''),
    merged: mergedOf(doc.entries),
    lineKey: firstValue(doc.entries, '选题') || '',
    stage: firstValue(doc.entries, '阶段') || '',
    status: firstValue(doc.entries, '状态') || '',
    distributions,
    schedules,
    mtimeMs: doc.mtimeMs,
    problems: problemsOf(doc.entries, doc.folderStatus),
    folder: doc.folder,
  }
}

function contained(dir, file) {
  const root = resolve(dir)
  const target = resolve(file)
  return target === root || target.startsWith(root + sep)
}

function assetsPath(file) {
  return file.slice(0, -3) + '-assets'
}

function defaultExec(file, args) {
  return new Promise((resolveExec, reject) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(file, args, { shell: false }, (err, stdout, stderr) => {
        if (err) reject(err)
        else resolveExec({ stdout, stderr })
      })
    }, reject)
  })
}

async function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, file)
}

async function createExclusive(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content)
  try {
    await link(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    if (err.code === 'EEXIST') throw fail(409, '已有同名稿件')
    throw err
  }
  await unlink(tmp).catch(() => {})
}

export class Pieces {
  constructor(settings, { now = () => new Date(), execFile = defaultExec, dataDir = '' } = {}) {
    this.settings = settings
    this.now = now
    this.execFile = execFile
    this.dataDir = dataDir
    this.queue = Promise.resolve()
    this.cache = new Map()
  }

  run(task) {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  board() {
    return this.run(() => this._board())
  }

  readPiece(note) {
    return this.run(() => this._readPiece(note))
  }

  create(input) {
    return this.run(async () => {
      const note = await this._create(input || {})
      const title = note.replace(/^\d{4}-\d{2}-\d{2}-/, '')
      return { ...(await this._board()), note, title }
    })
  }

  rewriteSources(oldNote, newNote) {
    return this.run(() => this._rewriteSources(oldNote, newNote))
  }

  merge(input) {
    return this.run(async () => {
      const raised = await this._merge(input || {})
      return { ...(await this._board()), raised }
    })
  }

  unmerge(input) {
    return this.run(async () => {
      await this._unmerge(input || {})
      return this._board()
    })
  }

  saveBody(input) {
    return this.run(async () => {
      await this._saveBody(input || {})
      return this._board()
    })
  }

  setStatus(input) {
    return this.run(async () => {
      await this._setStatus(input || {})
      return this._board()
    })
  }

  publish(input) {
    return this.run(async () => {
      await this._publish(input || {})
      return this._board()
    })
  }

  unpublish(input) {
    return this.run(async () => {
      await this._unpublish(input || {})
      return this._board()
    })
  }

  setImpressions(input) {
    return this.run(async () => {
      const settings = await this.settings.read()
      await this._setImpressions(settings, input?.note, input?.platform, input?.impressions)
      return this._board()
    })
  }

  setSchedule(input) {
    return this.run(async () => {
      await this._setSchedule(input || {})
      return this._board()
    })
  }

  setPlatforms(input) {
    return this.run(async () => {
      await this._setPlatforms(input || {})
      return this._board()
    })
  }

  open(note) {
    return this.run(() => this._open(note))
  }

  importMetrics(csv) {
    return this.run(() => this._importMetrics(csv))
  }

  deletePiece(note) {
    return this.run(() => this._deletePiece(note))
  }

  deleteLine(key) {
    return this.run(() => this._deleteLine(key))
  }

  async _board() {
    const settings = await this.settings.read()
    const scanned = await this._scan(settings.vaultRoot)
    return buildBoard({
      ...scanned,
      threshold: Number.isFinite(settings.threshold) ? settings.threshold : DEFAULT_THRESHOLD,
      forms: FORMS,
      platforms: ALL_PLATFORMS,
    })
  }

  _dropCache(file) {
    this.cache.delete(resolve(file))
  }

  async _scan(vaultRoot) {
    const pieces = []
    const seen = new Set()
    for (const form of FORMS) {
      const dirs = STATUS_DIRS[form.id]
      if (!dirs) continue
      for (const [folderStatus, rel] of Object.entries(dirs)) {
        const dir = join(vaultRoot, rel)
        await this._walk(dir, async (file, name) => {
          const abs = resolve(file)
          seen.add(abs)
          if (!contained(dir, file)) return
          const piece = await this._readManaged(vaultRoot, form.id, folderStatus, file, name)
          if (piece) pieces.push(piece)
        })
      }
    }
    for (const key of this.cache.keys()) {
      if (!seen.has(key)) this.cache.delete(key)
    }
    const origins = await this._scanOrigins(vaultRoot)
    return { pieces: pieces.map(piece => withMergeProblems(piece, origins)), origins }
  }

  async _walk(dir, visit) {
    let names
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
    for (const ent of names) {
      if (ent.name.startsWith('.') || ent.name.includes('sync-conflict') || ent.name.startsWith('.syncthing.')) continue
      const file = join(dir, ent.name)
      if (!contained(dir, file)) continue
      if (ent.isDirectory()) {
        await this._walk(file, visit)
        continue
      }
      if (ent.isFile() && ent.name.endsWith('.md')) await visit(file, ent.name)
    }
  }

  async _readManaged(vaultRoot, form, folderStatus, file, name) {
    let info
    try {
      info = await stat(file)
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
    if (!info.isFile()) return null
    const key = resolve(file)
    const cached = this.cache.get(key)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.piece
    }
    const handle = await open(file, 'r')
    let head = ''
    let content = null
    try {
      const buf = Buffer.alloc(HEAD_LIMIT)
      const { bytesRead } = await handle.read(buf, 0, HEAD_LIMIT, 0)
      head = buf.subarray(0, bytesRead).toString('utf8')
      if (looksManaged(head)) content = (await readFile(file)).toString('utf8')
    } finally {
      await handle.close()
    }
    if (content == null) {
      this.cache.set(key, { mtimeMs: info.mtimeMs, size: info.size, piece: null })
      return null
    }
    let doc = this._doc(file, form, name.slice(0, -3), info.mtimeMs, content, folderStatus)
    const tagged = firstValue(doc.entries, '状态')
    if (tagged !== folderStatus) {
      setEntry(doc.entries, '状态', folderStatus)
      await atomicWrite(file, renderHeader(doc.entries) + doc.body)
      const next = await stat(file)
      const rewritten = await readFile(file, 'utf8')
      doc = this._doc(file, form, name.slice(0, -3), next.mtimeMs, rewritten, folderStatus)
      info = next
    }
    const piece = await this._annotate(vaultRoot, doc)
    this.cache.set(key, { mtimeMs: info.mtimeMs, size: info.size, piece })
    return piece
  }

  async _scanOrigins(vaultRoot) {
    const dir = join(vaultRoot, ORIGIN_DIR)
    const origins = []
    await this._walk(dir, async (file, name) => {
      if (!contained(dir, file)) return
      let info
      try {
        info = await stat(file)
      } catch (err) {
        if (err.code === 'ENOENT') return
        throw err
      }
      if (!info.isFile()) return
      const content = await readFile(file, 'utf8')
      const { entries } = splitDocument(content)
      const note = name.slice(0, -3)
      const tagged = firstValue(entries, '日期')
      const fromName = DATE_PREFIX.exec(note)
      origins.push({
        note,
        title: lineNameOf(name),
        date: tagged || (fromName ? fromName[1] : ''),
        audience: firstValue(entries, '谁会看') || '',
        path: relative(vaultRoot, file).split(sep).join('/'),
      })
    })
    return origins
  }

  _doc(file, form, note, mtimeMs, content, folderStatus) {
    const parsed = splitDocument(content)
    const folder = folderStatus && STATUS_DIRS[form]?.[folderStatus] ? STATUS_DIRS[form][folderStatus] : ''
    return { file, form, note, mtimeMs, content, folder, folderStatus, ...parsed }
  }

  async _locate(vaultRoot, note) {
    if (!validNote(note)) return []
    const { pieces } = await this._scan(vaultRoot)
    const hits = []
    for (const piece of pieces) {
      if (piece.note !== note) continue
      const rel = STATUS_DIRS[piece.form]?.[piece.status]
      if (!rel) continue
      const file = join(vaultRoot, rel, `${note}.md`)
      // 稿件可能在状态目录的子文件夹里，按扫描结果的文件名再找一次
      const found = await this._findFile(join(vaultRoot, rel), `${note}.md`)
      if (!found) continue
      hits.push({ form: piece.form, file: found.file, mtimeMs: found.mtimeMs, status: piece.status })
    }
    if (!hits.length && validNote(note)) {
      for (const form of FORMS) {
        const dirs = STATUS_DIRS[form.id]
        if (!dirs) continue
        for (const rel of Object.values(dirs)) {
          const found = await this._findFile(join(vaultRoot, rel), `${note}.md`)
          if (found) hits.push({ form: form.id, file: found.file, mtimeMs: found.mtimeMs })
        }
      }
    }
    return hits
  }

  async _findFile(dir, name) {
    let hit = null
    await this._walk(dir, async (file, entry) => {
      if (entry === name && !hit) {
        const info = await stat(file)
        hit = { file, mtimeMs: info.mtimeMs }
      }
    })
    return hit
  }

  async _load(vaultRoot, note) {
    if (!validNote(note)) throw fail(400, '稿件路径无效')
    const hits = await this._locate(vaultRoot, note)
    if (!hits.length) throw fail(404, '稿件不存在')
    if (hits.length > 1) throw fail(400, '两个目录都有同名稿件')
    const content = await readFile(hits[0].file, 'utf8')
    const form = hits[0].form
    const status = hits[0].status || this._folderStatus(vaultRoot, form, hits[0].file)
    return this._doc(hits[0].file, form, note, hits[0].mtimeMs, content, status)
  }

  _folderStatus(vaultRoot, form, file) {
    const dirs = STATUS_DIRS[form] || {}
    const abs = resolve(file)
    for (const [status, rel] of Object.entries(dirs)) {
      const root = resolve(vaultRoot, rel)
      if (abs === root || abs.startsWith(root + sep)) return status
    }
    return null
  }

  async _writeDoc(doc) {
    await atomicWrite(doc.file, renderHeader(doc.entries) + doc.body)
    this._dropCache(doc.file)
  }

  async _readPiece(note) {
    const settings = await this.settings.read()
    const doc = await this._load(settings.vaultRoot, note)
    const piece = await this._annotate(settings.vaultRoot, doc)
    const origins = piece.form === '长文' && piece.merged.length ? await this._scanOrigins(settings.vaultRoot) : []
    return { ...withMergeProblems(piece, origins), body: doc.body, file: doc.file }
  }

  async _noteTaken(vaultRoot, note) {
    const { pieces } = await this._scan(vaultRoot)
    return pieces.some(piece => piece.note === note)
  }

  async _create(input) {
    const form = input.form
    const formDef = FORMS.find(item => item.id === form)
    if (!formDef) throw fail(400, '形态无效')
    if (!formDef.enabled) throw fail(400, '形态未启用')
    const originNote = typeof input.originNote === 'string' ? input.originNote.trim() : ''
    const parentNote = typeof input.parentNote === 'string' ? input.parentNote.trim() : ''
    const lineName = typeof input.lineName === 'string' ? input.lineName.trim() : ''
    const modes = [originNote, parentNote, lineName].filter(Boolean)
    if (modes.length !== 1) throw fail(400, '请指定原点、上一级稿件或线名中的一个')

    const settings = await this.settings.read()
    const vaultRoot = settings.vaultRoot
    const date = ymd(this.now())
    const title = sanitizeTitle(input.title || lineName)
    if (!title) throw fail(400, '标题无效')
    const note = `${date}-${title}`
    if (!validNote(note)) throw fail(400, '标题无效')
    if (await this._noteTaken(vaultRoot, note)) throw fail(409, '已有同名稿件')

    let sourceRaw = ''
    let lineKey = ''
    const skipRaise = [note]
    if (originNote) {
      if (form !== '短推') throw fail(400, '由原点创建只限短推')
      if (!validNote(originNote)) throw fail(404, '原点不存在')
      const originRoot = join(vaultRoot, ORIGIN_DIR)
      const found = await this._findFile(originRoot, `${originNote}.md`)
      if (!found || !contained(originRoot, found.file)) throw fail(404, '原点不存在')
      sourceRaw = `[[${originNote}]]`
      const scanned = await this._scan(vaultRoot)
      const sibling = scanned.pieces.find(piece => piece.source === originNote && piece.lineKey)
      lineKey = sibling?.lineKey || `知识原子/${lineNameOf(originNote)}`
    } else if (lineName) {
      if (form !== '短推') throw fail(400, '从零新建只限短推')
      if (!validNote(lineName)) throw fail(400, '线名无效')
      sourceRaw = '工作台'
      lineKey = lineName
    } else {
      let parent
      try {
        parent = await this._load(vaultRoot, parentNote)
      } catch (err) {
        if (err.status === 404 || err.status === 400) throw fail(404, '上一级稿件不存在')
        throw err
      }
      const formIdx = FORMS.findIndex(item => item.id === form)
      const parentIdx = FORMS.findIndex(item => item.id === parent.form)
      lineKey = firstValue(parent.entries, '选题') || ''
      if (!lineKey.trim()) throw fail(400, '上一级稿件没有选题')
      if (form === parent.form) {
        sourceRaw = firstValue(parent.entries, '来源') || ''
        skipRaise.push(parent.note)
      } else if (formIdx === parentIdx + 1) {
        sourceRaw = `[[${parent.note}]]`
      } else {
        throw fail(400, '不能从该稿件创建这一形态')
      }
    }

    const defaults = DEFAULTS[form]
    const header = [
      `来源: ${sourceRaw}`,
      `日期: ${date}`,
      `账号: ${defaults.accounts}`,
      `平台: ${defaults.platforms}`,
      `选题: ${lineKey}`,
      '阶段: 0想法',
      '状态: 进行中',
    ].join('\n') + '\n'
    const content = header + `\n# ${title}\n\n`
    const dir = join(vaultRoot, STATUS_DIRS[form]['进行中'])
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${note}.md`)
    if (!contained(dir, file)) throw fail(400, '标题无效')
    await createExclusive(file, content)
    this._dropCache(file)
    await this._raiseSourceIfPiece(vaultRoot, sourceRaw, skipRaise)
    return note
  }
  async _rewriteSources(oldNote, newNote) {
    if (!oldNote || !newNote || oldNote === newNote) return
    const settings = await this.settings.read()
    const { pieces } = await this._scan(settings.vaultRoot)
    for (const piece of pieces) {
      // 来源指向原子的只有短推；长文、视频的来源是上一级稿，可能和原子同名
      const sourced = piece.form === '短推' && piece.source === oldNote
      if (!sourced && !piece.merged.includes(oldNote)) continue
      const doc = await this._load(settings.vaultRoot, piece.note)
      let changed = false
      for (const entry of doc.entries) {
        const name = entry.key === '来源' && sourced ? unwrapSource(entry.value)
          : entry.key === MERGE_KEY ? unwrapSource(entry.value).trim() : null
        if (name !== oldNote) continue
        const next = /^\[\[/.test(entry.value.trim()) ? `[[${newNote}]]` : newNote
        if (entry.value === next) continue
        entry.value = next
        changed = true
      }
      if (changed) await this._writeDoc(doc)
    }
  }

  async _merge(input) {
    const settings = await this.settings.read()
    const vaultRoot = settings.vaultRoot
    const doc = await this._load(vaultRoot, input.note)
    const { pieces } = await this._scan(vaultRoot)
    const self = pieces.find(piece => piece.note === doc.note && piece.form === doc.form)
    if (doc.form !== '长文' || !self) throw fail(400, '只有长文可以并入知识原子')
    const wanted = Array.isArray(input.atoms) ? input.atoms.map(atom => (typeof atom === 'string' ? atom.trim() : '')) : []
    if (!wanted.length) throw fail(400, '只能并入已确认的知识原子')
    const merged = mergedOf(doc.entries)
    const origin = mainOriginOf(pieces, self)
    const originRoot = join(vaultRoot, ORIGIN_DIR)
    const atoms = []
    for (const note of wanted) {
      const found = validNote(note) ? await this._findFile(originRoot, `${note}.md`) : null
      if (!found || !contained(originRoot, found.file)) throw fail(400, '只能并入已确认的知识原子')
      if (merged.includes(note) || atoms.some(atom => atom.note === note)) throw fail(409, '这条原子已经并入')
      if (note === origin) throw fail(400, '这条原子是本线的原点')
      atoms.push({ note, path: relative(vaultRoot, found.file).split(sep).join('/') })
    }
    // 写在来源行下面；已有并入行时接在最后一行并入后面
    let at = doc.entries.findLastIndex(entry => entry.key === MERGE_KEY)
    if (at < 0) at = doc.entries.findIndex(entry => entry.key === '来源')
    const eol = doc.entries[Math.max(at, 0)]?.eol || '\n'
    doc.entries.splice(at + 1, 0, ...atoms.map(atom => ({ key: MERGE_KEY, value: `[[${atom.note}]]`, original: undefined, raw: null, eol })))
    await this._writeDoc(doc)
    // 被并入原子的线里已到 2验证 的短推升 3升级；没到的等它到 2验证 时由 _setImpressions 补升
    const raised = []
    for (const piece of pieces) {
      if (piece.form !== '短推' || piece.stage !== '2验证' || !atoms.some(atom => atom.note === piece.source)) continue
      const short = await this._load(vaultRoot, piece.note)
      setEntry(short.entries, '阶段', raiseStage(firstValue(short.entries, '阶段') || '', '3升级'))
      await this._writeDoc(short)
      raised.push(piece.note)
    }
    await this._recordMerges(atoms, doc.note)
    return raised
  }

  // 移除并入行，阶段不回退；没有这一行时什么也不改
  async _unmerge(input) {
    const settings = await this.settings.read()
    const doc = await this._load(settings.vaultRoot, input.note)
    const atom = typeof input.atom === 'string' ? input.atom.trim() : ''
    const kept = doc.entries.filter(entry => entry.key !== MERGE_KEY || unwrapSource(entry.value).trim() !== atom)
    if (!atom || kept.length === doc.entries.length) return
    doc.entries = kept
    await this._writeDoc(doc)
  }

  async _isMerged(vaultRoot, atom) {
    if (!atom) return false
    const { pieces } = await this._scan(vaultRoot)
    return pieces.some(piece => piece.form === '长文' && piece.merged.includes(atom))
  }

  async _recordMerges(atoms, piece) {
    if (!this.dataDir) return
    await mkdir(this.dataDir, { recursive: true })
    const at = this.now().toISOString()
    const lines = atoms.map(atom => `${JSON.stringify({ at, action: 'merge', path: atom.path, piece })}\n`)
    await appendFile(join(this.dataDir, 'atom-events.jsonl'), lines.join(''))
  }


  async _raiseSourceIfPiece(vaultRoot, sourceRaw, skipNotes) {
    const skip = new Set(Array.isArray(skipNotes) ? skipNotes : [skipNotes])
    const name = unwrapSource(sourceRaw)
    if (!name || skip.has(name) || !validNote(name)) return
    let doc
    try {
      doc = await this._load(vaultRoot, name)
    } catch {
      return
    }
    const next = raiseStage(firstValue(doc.entries, '阶段') || '', '3升级')
    if (next === (firstValue(doc.entries, '阶段') || '')) return
    setEntry(doc.entries, '阶段', next)
    await this._writeDoc(doc)
  }

  async _saveBody(input) {
    if (typeof input.body !== 'string') throw fail(400, '正文必须是字符串')
    if (typeof input.mtimeMs !== 'number' || !Number.isFinite(input.mtimeMs)) throw fail(400, '缺少修改时间')
    const settings = await this.settings.read()
    const doc = await this._load(settings.vaultRoot, input.note)
    if (doc.mtimeMs !== input.mtimeMs) throw fail(409, '文件已在别处修改，请重新打开')
    const gap = /^\r?\n/.test(input.body) ? '' : (doc.headerRaw.endsWith('\r\n') ? '\r\n' : '\n')
    await atomicWrite(doc.file, doc.headerRaw + gap + input.body)
    this._dropCache(doc.file)
  }

  async _setStatus(input) {
    if (input.status !== '进行中' && input.status !== '定稿') throw fail(400, '状态只能是进行中或定稿')
    const settings = await this.settings.read()
    const doc = await this._load(settings.vaultRoot, input.note)
    const current = this._folderStatus(settings.vaultRoot, doc.form, doc.file)
    if (current === '已发布') throw fail(400, '已发布的稿件不能改状态')
    if (current === input.status) {
      if (firstValue(doc.entries, '状态') !== input.status) {
        setEntry(doc.entries, '状态', input.status)
        await this._writeDoc(doc)
      }
      return
    }
    setEntry(doc.entries, '状态', input.status)
    await this._move(settings.vaultRoot, doc, input.status, current)
  }

  async _publish(input) {
    const platform = typeof input.platform === 'string' ? input.platform.trim() : ''
    const url = typeof input.url === 'string' ? input.url : ''
    const date = typeof input.date === 'string' ? input.date : ''
    if (!platform) throw fail(400, '平台不能为空')
    if (!ALL_PLATFORMS.includes(platform)) throw fail(400, '平台无效')
    if (!url.startsWith('http://') && !url.startsWith('https://')) throw fail(400, '链接必须以 http:// 或 https:// 开头')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, '日期必须是 YYYY-MM-DD')
    const settings = await this.settings.read()
    const doc = await this._load(settings.vaultRoot, input.note)
    const had = doc.entries.some(entry => entry.key === '分发' && parseDist(entry.value))
    const existing = doc.entries.find(entry => entry.key === '分发' && parseDist(entry.value)?.platform === platform)
    if (existing) {
      const parts = existing.value.split(' | ')
      parts[1] = date
      parts[2] = url
      existing.value = parts.join(' | ')
    }
    const platforms = splitList(firstValue(doc.entries, '平台'))
    if (!platforms.includes(platform)) {
      platforms.push(platform)
      setEntry(doc.entries, '平台', platforms.join(', '))
    }
    doc.entries = doc.entries.filter(entry => {
      if (entry.key !== '排期') return true
      return parseSchedule(entry.value)?.platform !== platform
    })
    const folderStatus = this._folderStatus(settings.vaultRoot, doc.form, doc.file)
    const firstPublish = !had
    if (firstPublish) {
      setEntry(doc.entries, '状态', '已发布')
      setEntry(doc.entries, '阶段', raiseStage(firstValue(doc.entries, '阶段') || '', '1测试'))
    }
    if (!existing) {
      doc.entries.push({
        key: '分发',
        value: `${platform} | ${date} | ${url} | `,
        original: undefined,
        raw: null,
        eol: doc.entries.at(-1)?.eol || '\n',
      })
    }
    if (firstPublish && folderStatus !== '已发布') await this._move(settings.vaultRoot, doc, '已发布', folderStatus)
    else await this._writeDoc(doc)
  }

  async _unpublish(input) {
    const platform = typeof input.platform === 'string' ? input.platform.trim() : ''
    if (!platform) throw fail(400, '平台不能为空')
    const settings = await this.settings.read()
    const doc = await this._load(settings.vaultRoot, input.note)
    const before = doc.entries.length
    doc.entries = doc.entries.filter(entry => {
      if (entry.key !== '分发') return true
      const parsed = parseDist(entry.value)
      return !parsed || parsed.platform !== platform
    })
    if (doc.entries.length === before) throw fail(400, '该平台没有发布记录')
    const folderStatus = this._folderStatus(settings.vaultRoot, doc.form, doc.file)
    if (!doc.entries.some(entry => entry.key === '分发' && parseDist(entry.value))) {
      setEntry(doc.entries, '状态', '定稿')
      if (folderStatus !== '定稿') await this._move(settings.vaultRoot, doc, '定稿', folderStatus)
      else await this._writeDoc(doc)
      return
    }
    await this._writeDoc(doc)
  }

  async _setImpressions(settings, note, platform, impressions) {
    const name = typeof platform === 'string' ? platform.trim() : ''
    if (!name) throw fail(400, '平台不能为空')
    const clear = impressions === null
    if (!clear && (!Number.isInteger(impressions) || impressions < 0)) throw fail(400, '曝光数必须是非负整数')
    const doc = await this._load(settings.vaultRoot, note)
    const existing = doc.entries.find(entry => entry.key === '分发' && parseDist(entry.value)?.platform === name)
    if (!existing) throw fail(400, '该平台还没有发布记录')
    const parts = existing.value.split(' | ')
    parts[3] = clear ? '' : String(impressions)
    existing.value = parts.join(' | ')
    const threshold = Number.isFinite(settings.threshold) ? settings.threshold : DEFAULT_THRESHOLD
    if (!clear && doc.form === '短推' && name === 'X' && impressions > threshold) {
      let stage = raiseStage(firstValue(doc.entries, '阶段') || '', '2验证')
      // 原子已被某篇长文并入：到 2验证 的这一刻补升 3升级
      if (stage === '2验证' && await this._isMerged(settings.vaultRoot, unwrapSource(firstValue(doc.entries, '来源') || ''))) stage = '3升级'
      setEntry(doc.entries, '阶段', stage)
    }
    await this._writeDoc(doc)
  }

  async _setSchedule(input) {
    const platform = typeof input.platform === 'string' ? input.platform.trim() : ''
    if (!platform) throw fail(400, '平台不能为空')
    if (!ALL_PLATFORMS.includes(platform)) throw fail(400, '平台无效')
    const at = input.at == null || input.at === '' ? null : String(input.at)
    if (at && !SCHEDULE_AT.test(at)) throw fail(400, '排期时间必须是 YYYY-MM-DD HH:mm')
    const settings = await this.settings.read()
    const doc = await this._load(settings.vaultRoot, input.note)
    doc.entries = doc.entries.filter(entry => {
      if (entry.key !== '排期') return true
      return parseSchedule(entry.value)?.platform !== platform
    })
    if (at) {
      doc.entries.push({
        key: '排期',
        value: `${platform} | ${at}`,
        original: undefined,
        raw: null,
        eol: doc.entries.at(-1)?.eol || '\n',
      })
    }
    await this._writeDoc(doc)
  }

  async _setPlatforms(input) {
    if (!Array.isArray(input.accounts) || !Array.isArray(input.platforms)) throw fail(400, '账号和平台必须是列表')
    const platforms = input.platforms.map(item => String(item).trim()).filter(Boolean)
    if (platforms.some(item => !ALL_PLATFORMS.includes(item))) throw fail(400, '平台无效')
    const accounts = input.accounts.map(item => String(item).trim()).filter(Boolean)
    const settings = await this.settings.read()
    const doc = await this._load(settings.vaultRoot, input.note)
    setEntry(doc.entries, '账号', joinList(accounts))
    setEntry(doc.entries, '平台', joinList(platforms))
    await this._writeDoc(doc)
  }

  async _move(vaultRoot, doc, targetStatus, previousStatus) {
    const previousTag = previousStatus
    const targetDir = join(vaultRoot, STATUS_DIRS[doc.form][targetStatus])
    await mkdir(targetDir, { recursive: true })
    const dest = join(targetDir, basename(doc.file))
    if (!contained(targetDir, dest)) throw fail(400, '稿件路径无效')
    const sameFile = resolve(dest) === resolve(doc.file)
    await this._writeDoc(doc)
    if (sameFile) return
    try {
      await stat(dest)
      throw fail(409, '目标已有同名文件')
    } catch (err) {
      if (err.status === 409) {
        await this._rollbackTag(doc, previousTag)
        throw err
      }
      if (err.code !== 'ENOENT') {
        await this._rollbackTag(doc, previousTag)
        throw err
      }
    }
    const assets = assetsPath(doc.file)
    const assetsDest = assetsPath(dest)
    let assetsInfo = null
    try {
      assetsInfo = await stat(assets)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        await this._rollbackTag(doc, previousTag)
        throw err
      }
    }
    if (assetsInfo && !assetsInfo.isDirectory()) assetsInfo = null
    if (assetsInfo) {
      try {
        await stat(assetsDest)
        await this._rollbackTag(doc, previousTag)
        throw fail(409, '目标已有同名素材目录')
      } catch (err) {
        if (err.status === 409) throw err
        if (err.code !== 'ENOENT') {
          await this._rollbackTag(doc, previousTag)
          throw err
        }
      }
    }
    const sourceFile = doc.file
    try {
      await rename(sourceFile, dest)
      this._dropCache(sourceFile)
      this._dropCache(dest)
      doc.file = dest
    } catch (err) {
      await this._rollbackTag(doc, previousTag)
      throw err
    }
    if (assetsInfo) {
      try {
        await rename(assets, assetsDest)
      } catch (err) {
        await rename(dest, sourceFile).catch(() => {})
        doc.file = sourceFile
        await this._rollbackTag(doc, previousTag)
        throw err
      }
    }
  }

  async _rollbackTag(doc, previousStatus) {
    const status = doc.entries.find(entry => entry.key === '状态')
    if (status) status.value = previousStatus
    else setEntry(doc.entries, '状态', previousStatus)
    await this._writeDoc(doc)
  }

  async _open(note) {
    const settings = await this.settings.read()
    const doc = await this._load(settings.vaultRoot, note)
    if (!contained(settings.vaultRoot, doc.file)) throw fail(400, '稿件路径无效')
    const url = `obsidian://open?path=${encodeURIComponent(doc.file)}`
    await this.execFile('open', [url])
    return { ok: true }
  }

  async _importMetrics(csv) {
    if (typeof csv !== 'string') throw fail(400, '缺少 CSV')
    const settings = await this.settings.read()
    const threshold = Number.isFinite(settings.threshold) ? settings.threshold : DEFAULT_THRESHOLD
    const { pieces } = await this._scan(settings.vaultRoot)
    const plan = planImport(csv, pieces)
    const matched = []
    for (const hit of plan.hits) {
      await this._setImpressions(settings, hit.note, 'X', hit.impressions)
      matched.push({
        note: hit.note,
        title: hit.title,
        impressions: hit.impressions,
        validated: hit.form === '短推' && hit.impressions > threshold,
      })
    }
    return { matched, unmatched: plan.unmatched, ...(await this._board()) }
  }
  async _annotate(vaultRoot, doc) {
    const piece = toPiece(doc)
    piece.path = relative(vaultRoot, doc.file).split(sep).join('/')
    piece.assets = await this._assetsRel(vaultRoot, doc.file)
    return piece
  }

  async _assetsRel(vaultRoot, file) {
    const assets = assetsPath(file)
    try {
      const info = await stat(assets)
      if (!info.isDirectory()) return ''
      return relative(vaultRoot, assets).split(sep).join('/')
    } catch (err) {
      if (err.code === 'ENOENT') return ''
      throw err
    }
  }

  _statusRoot(vaultRoot, file) {
    const abs = resolve(file)
    for (const dirs of Object.values(STATUS_DIRS)) {
      for (const rel of Object.values(dirs)) {
        const root = resolve(vaultRoot, rel)
        if (abs === root || abs.startsWith(root + sep)) return root
      }
    }
    return null
  }

  async _assertInsideStatus(vaultRoot, file) {
    const root = this._statusRoot(vaultRoot, file)
    if (!root) throw fail(400, '路径无效')
    const realRoot = await realpath(root).catch(() => resolve(root))
    const realFile = await realpath(file)
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) throw fail(400, '路径无效')
  }

  async _deletePiece(note) {
    if (!validNote(note)) throw fail(400, '稿件路径无效')
    const settings = await this.settings.read()
    const doc = await this._load(settings.vaultRoot, note)
    if (!String(firstValue(doc.entries, '选题') || '').trim() || !String(firstValue(doc.entries, '阶段') || '').trim()) {
      throw fail(400, '只能删除受管稿件')
    }
    const moved = await this._trash(settings.vaultRoot, [doc.file])
    return { moved, ...(await this._board()) }
  }

  async _deleteLine(key) {
    const text = String(key ?? '')
    if (!text.trim() || text.includes('\0') || text.includes('\\') || text.split('/').includes('..') || text.length > 500) {
      throw fail(400, '路径无效')
    }
    const settings = await this.settings.read()
    const { pieces } = await this._scan(settings.vaultRoot)
    const files = []
    for (const piece of pieces) {
      if (piece.lineKey !== text) continue
      const hits = await this._locate(settings.vaultRoot, piece.note)
      for (const hit of hits) files.push(hit.file)
    }
    const moved = await this._trash(settings.vaultRoot, files)
    return { moved, ...(await this._board()) }
  }

  async _trash(vaultRoot, files) {
    const destDir = await openTrashDir(vaultRoot, this.now())
    const plan = []
    for (const file of files) {
      await this._assertInsideStatus(vaultRoot, file)
      plan.push(file)
      const assets = assetsPath(file)
      try {
        const info = await stat(assets)
        if (!info.isDirectory()) continue
        await this._assertInsideStatus(vaultRoot, assets)
        plan.push(assets)
      } catch (err) {
        if (err.status) throw err
        if (err.code !== 'ENOENT') throw err
      }
    }
    const moved = []
    for (const file of plan) {
      const dest = await uniqueDest(destDir, basename(file))
      await rename(file, dest)
      this._dropCache(file)
      moved.push(relative(vaultRoot, file).split(sep).join('/'))
    }
    return moved
  }
}

