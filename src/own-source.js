// 本人账号正本：解析账号表，只改目标行，原子写回。路径固定在知识库内，不跟随符号链接。
import { createHash, randomBytes } from 'node:crypto'
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { checkIdText, checkName, URL_MAX } from './own-platforms.js'
import { httpError } from './vault.js'

export const OWN_SOURCE = '账号.md'
export const KEY_PATTERN = /^own-[0-9a-f]{6}$/
// 只有这张七列表格里的行允许写入；读取也认旧的六列行。
export const OWN_COLUMNS = Object.freeze(['槽', '平台', '显示名', 'handle 或 ID', '备注', '链接', '键'])
// 链接栏里这些词等于「还没有链接」。
export const LINK_PLACEHOLDERS = Object.freeze(['未给主页链接', '未注册'])

const STALE = '账号资料已在别处修改，已载入最新内容'
const MISSING = '找不到本人账号正本'
const UNREGISTERED_ID = /^row:[0-9a-f]{12}(?:-\d+)?$/
const URL_IN_CELL = /https?:\/\/[^\s`()<>|\\，。！？、；：「」《》（）【】]+/
const FIELDS = ['displayName', 'handle', 'url', 'key']

const digest = value => createHash('sha256').update(value).digest('hex')
const unescapePipes = value => value.replace(/\\\|/g, '|')
const plain = value => value.replace(/^`+|`+$/g, '').trim()
const isDelimiter = cells => cells.length > 0 && cells.every(cell => /^[-:]+$/.test(cell))

// 按未转义的竖线切格；反斜杠连同后一个字符原样留在格里，和 GFM 表格一致。
function splitCells(line) {
  const row = line.trim()
  if (!row.startsWith('|')) return null
  const cells = []
  let cell = ''
  for (let i = 1; i < row.length; i += 1) {
    const char = row[i]
    if (char === '\\' && i + 1 < row.length) {
      cell += char + row[i + 1]
      i += 1
    } else if (char === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += char
  }
  if (cell.trim()) cells.push(cell.trim())
  return cells
}

function withoutUrl(cell, match) {
  const before = cell.slice(0, match.index).replace(/\s+$/, '')
  const after = cell.slice(match.index + match[0].length).replace(/^\s+/, '')
  return before && after ? `${before} ${after}` : before + after
}

function readLink(cell) {
  const match = URL_IN_CELL.exec(cell)
  const rest = match ? withoutUrl(cell, match) : cell
  return { url: match?.[0] || '', linkNote: LINK_PLACEHOLDERS.includes(rest) ? '' : unescapePipes(rest) }
}

// 已有 URL 只换那一段；空栏或占位词整栏换成 URL；有别的文字时 URL 放最前。清空时只删 URL。
function nextLinkCell(cell, url) {
  const match = URL_IN_CELL.exec(cell)
  if (match) return url ? cell.slice(0, match.index) + url + cell.slice(match.index + match[0].length) : withoutUrl(cell, match)
  if (!url) return cell
  return !cell || LINK_PLACEHOLDERS.includes(cell) ? url : `${url} ${cell}`
}

function renderRow(cells) {
  return `|${cells.map(cell => (cell ? ` ${cell} ` : ' ')).join('|')}|`
}

function scan(markdown) {
  const parts = String(markdown ?? '').split(/(\r?\n)/)
  const rows = []
  const seenKeys = new Set()
  const seenIds = new Map()
  let hasKeyColumn = false
  let inTable = false
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]
    const cells = splitCells(line)
    if (!cells) {
      inTable = false
      continue
    }
    if (cells[0] === '槽') {
      const next = index + 2 < parts.length ? splitCells(parts[index + 2]) : null
      inTable = cells.length === OWN_COLUMNS.length && cells.every((cell, i) => cell === OWN_COLUMNS[i]) && next?.length === OWN_COLUMNS.length && isDelimiter(next)
      if (inTable) hasKeyColumn = true
      continue
    }
    if (isDelimiter(cells) || (cells.length !== 6 && cells.length !== 7)) continue
    const raw = cells.length === 7 ? cells : [...cells, '']
    const slot = unescapePipes(raw[0])
    const platform = unescapePipes(raw[1])
    if (!slot || !platform) continue
    const keyText = plain(unescapePipes(raw[6]))
    const valid = KEY_PATTERN.test(keyText)
    const key = valid && !seenKeys.has(keyText) ? keyText : ''
    if (valid) seenKeys.add(keyText)
    const hash = digest(line)
    let id = key
    if (!id) {
      const base = `row:${hash.slice(0, 12)}`
      const count = (seenIds.get(base) || 0) + 1
      seenIds.set(base, count)
      id = count === 1 ? base : `${base}-${count}`
    }
    const { url, linkNote } = readLink(raw[5])
    rows.push({
      line: index / 2 + 1,
      rowRev: hash.slice(0, 16),
      key,
      id,
      registered: Boolean(key),
      slot,
      platform,
      displayName: plain(unescapePipes(raw[2])),
      handle: plain(unescapePipes(raw[3])),
      note: unescapePipes(raw[4]),
      url,
      linkNote,
      index,
      cells: raw,
      keyText,
      writable: inTable,
    })
  }
  return { parts, rows, hasKeyColumn }
}

/**
 * 解析正本账号表。六列旧表和七列表都认；没有合规键或键重复（第二次出现）的行是未登记行。
 * @returns {{ hasKeyColumn: boolean, rows: Array<{ line: number, rowRev: string, key: string, id: string, registered: boolean,
 *   slot: string, platform: string, displayName: string, handle: string, note: string, url: string, linkNote: string }> }}
 */
export function parseOwnSource(markdown) {
  const { rows, hasKeyColumn } = scan(markdown)
  return { hasKeyColumn, rows: rows.map(({ index, cells, keyText, writable, ...row }) => row) }
}

function markdownUrl(value) {
  if (typeof value !== 'string') throw httpError(400, '账号资料无效')
  const url = value.trim()
  if (!url) return ''
  let parsed = null
  try { parsed = new URL(url) } catch { /* 下面统一报错 */ }
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || url.length > URL_MAX
    || URL_IN_CELL.exec(url)?.[0] !== url || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(url)) throw httpError(400, '主页链接无效')
  return url
}

/**
 * 只重写目标行，其他行、换行符和文件末尾原样保留；目标行里没改的栏保留原文。
 * @param {{ id: string, rowRev: string, set: { displayName?: string, handle?: string, url?: string, key?: string } }} patch
 *   值应先经 checkFields 清洗；这里只再挡一次会破坏表格的字符。
 * @returns {string} 新全文；没有变化时返回原文。找不到 404；行已变 409；表头不符 409。
 */
export function patchOwnRow(markdown, { id, rowRev, set = {} } = {}) {
  const text = String(markdown ?? '')
  const { parts, rows } = scan(text)
  for (const field of Object.keys(set || {})) if (!FIELDS.includes(field)) throw new TypeError(`patchOwnRow: 不认识的栏 ${field}`)
  const row = rows.find(item => item.id === id)
  // 未登记行的 id 由行文本算出，找不到说明这一行已在别处改过。
  if (!row) throw UNREGISTERED_ID.test(String(id)) ? httpError(409, STALE) : httpError(404, '账号不存在')
  if (!row.writable) throw httpError(409, '正本表头和工作台约定的不一样，先核对表头')
  if (row.rowRev !== rowRev) throw httpError(409, STALE)
  const cells = [...row.cells]
  let changed = false
  // 和当前值相同的栏不动，旧行里手写的格式原样保留；变了的栏再挡一次会破坏表格的字符。
  if (set?.displayName !== undefined && set.displayName !== row.displayName) {
    const name = checkName(set.displayName)
    if (name !== row.displayName) {
      cells[2] = name.replace(/\|/g, '\\|')
      changed = true
    }
  }
  if (set?.handle !== undefined && set.handle !== row.handle) {
    const handle = checkIdText(set.handle)
    if (handle !== row.handle) {
      cells[3] = /^[A-Za-z0-9.-]*$/.test(handle) ? handle : `\`${handle}\``
      changed = true
    }
  }
  if (set?.url !== undefined && set.url !== row.url) {
    const url = markdownUrl(set.url)
    if (url !== row.url) {
      cells[5] = nextLinkCell(cells[5], url)
      changed = true
    }
  }
  if (set?.key !== undefined) {
    const key = set.key
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw httpError(400, '键无效')
    if (row.key && row.key !== key) throw httpError(409, '这一行已经有键')
    if (key !== row.key) {
      if (rows.some(item => item !== row && item.keyText === key)) throw httpError(409, '键已被另一行使用')
      cells[6] = key
      changed = true
    }
  }
  if (!changed) return text
  parts[row.index] = renderRow(cells)
  return parts.join('')
}

/**
 * 发一个新键。taken 收正本、state.json、posts.jsonl 里出现过的键。
 * @param {Iterable<string>} [taken]
 * @param {() => string} [random] - 6 位十六进制；测试时替换。
 */
export function newOwnKey(taken = [], random = () => randomBytes(3).toString('hex')) {
  const used = new Set(taken)
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const key = `own-${random()}`
    if (KEY_PATTERN.test(key) && !used.has(key)) return key
  }
  throw new Error('生成键失败')
}

// 知识库根目录本身可以是链接；根目录以下每一段都不能是符号链接，真实路径必须在知识库内。
async function sourceFile(vaultRoot) {
  if (typeof vaultRoot !== 'string' || !vaultRoot.trim()) throw httpError(404, MISSING)
  let root
  try { root = await realpath(vaultRoot) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw httpError(404, MISSING)
    throw error
  }
  let current = root
  let info = null
  for (const part of OWN_SOURCE.split('/')) {
    current = join(current, part)
    try { info = await lstat(current) } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw httpError(404, MISSING)
      throw error
    }
    if (info.isSymbolicLink()) throw httpError(400, '路径无效')
  }
  if (!info?.isFile()) throw httpError(400, '路径无效')
  const rel = relative(root, await realpath(current))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw httpError(400, '路径无效')
  return current
}

/** 读正本全文。不存在 404；符号链接或在知识库外 400。 */
export async function readOwnSource(vaultRoot) {
  const file = await sourceFile(vaultRoot)
  try { return await readFile(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') throw httpError(404, MISSING)
    throw error
  }
}

async function snapshot(vaultRoot) {
  const file = await sourceFile(vaultRoot)
  const info = await lstat(file)
  const text = await readFile(file, 'utf8')
  return { file, text, mtimeMs: info.mtimeMs, size: info.size, ino: info.ino, mode: info.mode & 0o777 }
}

const sameSnapshot = (a, b) => a.file === b.file && a.text === b.text && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino

async function rewrite(vaultRoot, fn) {
  let before = await snapshot(vaultRoot)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = await fn(before.text)
    if (next == null || next === before.text) return before.text
    if (typeof next !== 'string') throw new TypeError('mutateOwnSource: 回调要返回全文或 null')
    const tmp = join(dirname(before.file), `.${basename(before.file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
    try {
      await writeFile(tmp, next, { flag: 'wx', mode: before.mode })
      // 改名前复核：文件变了就按最新内容重算一遍，再变返回 409。
      const now = await snapshot(vaultRoot)
      if (sameSnapshot(before, now)) {
        await rename(tmp, before.file)
        return next
      }
      before = now
    } finally {
      await rm(tmp, { force: true })
    }
  }
  throw httpError(409, STALE)
}

let queue = Promise.resolve()

/**
 * 进程内串行地改正本：fn(全文) 返回新全文或 null（不写）。临时文件加改名，原子替换；改名前复核文件没被别处改过。
 * fn 要快，不能联网，也不能再调用 mutateOwnSource（会互相等待）。
 * @returns {Promise<string>} 写入后的全文；没写时是当前全文。
 */
export function mutateOwnSource(vaultRoot, fn) {
  const task = () => rewrite(vaultRoot, fn)
  const result = queue.then(task, task)
  queue = result.catch(() => {})
  return result
}
