// 麦田视频发布包（A 线）：生成 publish.json、裁切/准备三比例封面、归位本地成片、AI 补齐分平台文案、读取 发布记录.json 回填。
import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { extractJson } from './ai.js'
import { resolveExportDir } from './export.js'
import { tr } from './i18n.js'
import { STATUS_DIRS } from './pieces.js'
import { BUNDLE_PLATFORMS, checkMp4Faststart, codepointLen, validateBundle } from './publish-check.js'
import { beijingPreview, DESK_TO_MAITIAN, localScheduleToIso, MAITIAN_ORDER, MAITIAN_TO_DESK } from './publish-map.js'
import { createZipBuffer } from './zip.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BUNDLE_ZIP_FILE_BYTES = 25 * 1024 * 1024

const execFileAsync = promisify(execFile)
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const VIDEO_EXTS = new Set(['.mp4', '.mov'])
const CHANNELS_FALLBACK_URL = 'https://channels.weixin.qq.com/platform/post/list'

function fail(status, message) {
  return Object.assign(new Error(tr(message)), { status })
}

export function resolveBundleRoot(settings) {
  const custom = String(settings?.publish?.bundleDir ?? '').trim()
  if (custom) {
    return custom.startsWith('~/') ? join(homedir(), custom.slice(2)) : resolve(custom)
  }
  return join(resolveExportDir(settings?.exportDir), '发布包')
}

function safeFolderName(name) {
  const clean = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
  return clean || '未命名视频'
}

function stripMarkdownPlain(text) {
  return String(text ?? '')
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, n, a) => a || n)
    .replace(/[`*_~>]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function stripUrlsAndAngles(text, { allowLinks = true, noAngle = false } = {}) {
  let out = String(text ?? '')
  if (!allowLinks) {
    out = out.replace(/https?:\/\/\S+/gi, '').replace(/\bwww\.\S+/gi, '')
  }
  if (noAngle) {
    out = out.replace(/[<>]/g, '')
  }
  return out.replace(/\s+\n/g, '\n').trim()
}

function sliceChars(text, max) {
  return [...String(text ?? '').trim()].slice(0, max).join('').trim()
}

function padShortTitle(title) {
  const clean = String(title ?? '').replace(/[^\u4e00-\u9fffA-Za-z0-9，。！？、：·\s-]/g, '').trim()
  const base = sliceChars(clean || '本期核心内容分享', 16)
  if (codepointLen(base) >= 6) return base
  return sliceChars(`${base}｜干货分享`, 16)
}

const SECTION_ALIASES = {
  bilibili: ['b站', 'b 站', 'bilibili', '哔哩哔哩'],
  xhs: ['小红书', 'xhs', 'rednote'],
  douyin: ['抖音', 'douyin'],
  channels: ['视频号', '微信视频号', 'channels'],
  youtube: ['youtube', '油管'],
  x: ['x', 'twitter', '推特'],
  instagram: ['instagram', 'ins', 'ig', 'reels'],
}

function matchSectionPlatform(heading) {
  const clean = heading
    .replace(/^[一二三四五六七八九十\d]+[、.．\s]*/, '')
    .trim()
    .toLowerCase()
  for (const [id, names] of Object.entries(SECTION_ALIASES)) {
    if (names.some(n => clean === n || clean.startsWith(`${n}（`) || clean.startsWith(`${n}(`))) return id
  }
  return null
}

function parseTagList(raw) {
  return String(raw ?? '')
    .split(/[,，、#\s]+/)
    .map(s => s.trim().replace(/^#/, ''))
    .filter(Boolean)
}

/**
 * 解析正文里的分平台小节（如 `## B站`、`## 小红书`），支持 `**标题：**` / `**短标题：**` / `**正文：**` / `**简介：**` / `**标签：**` / `**话题：**`。
 */
export function parseVideoSections(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const sections = {}
  let current = null
  let buf = []
  const flush = () => {
    if (!current) return
    const raw = buf.join('\n').trim()
    const fields = {}
    let activeKey = null
    for (const line of raw.split('\n')) {
      const m = /^\*{0,2}(标题|短标题|正文|简介|说明|配文|描述|标签|话题)\*{0,2}\s*[:：]\s*\*{0,2}\s*(.*)$/.exec(line.trim())
      if (m) {
        activeKey = m[1]
        fields[activeKey] = m[2].trim()
      } else if (activeKey) {
        fields[activeKey] = `${fields[activeKey]}\n${line}`.trim()
      }
    }
    sections[current] = { raw, fields }
  }
  for (const line of lines) {
    const h = /^#{2,3}\s+(.+)$/.exec(line.trim())
    if (h) {
      const matched = matchSectionPlatform(h[1])
      if (matched) {
        flush()
        current = matched
        buf = []
        continue
      }
    }
    if (current) buf.push(line)
  }
  flush()
  return sections
}

function withRequiredTags(tags, requiredTags, maxCount = 10) {
  const merged = []
  for (const tag of [...(requiredTags || []), ...(tags || [])]) {
    const clean = sliceChars(String(tag || '').replace(/^#/, '').trim(), 20)
    if (clean && !merged.includes(clean)) merged.push(clean)
  }
  return merged.slice(0, maxCount)
}

/**
 * 为 7 个视频平台构造 publish.json 的 platforms 字段：
 * 优先采用正文分平台小节 -> 已有 publish.json 编辑 -> 从标题与正文首段自动裁剪兜底。
 */
export function buildPlatformsConfig(piece, body, { selectedPlatforms = [], existingPlatforms = {}, requiredTags = [] } = {}) {
  const selectedIds = new Set(selectedPlatforms.map(name => DESK_TO_MAITIAN[name]).filter(Boolean))
  const parsed = parseVideoSections(body)
  const h1Match = /^#\s+(.+)$/m.exec(String(body ?? ''))
  const baseTitle = (h1Match ? h1Match[1] : piece.title || '本期视频').trim()
  const summary = sliceChars(stripMarkdownPlain(body), 360) || baseTitle

  const out = {}
  for (const id of MAITIAN_ORDER) {
    const spec = BUNDLE_PLATFORMS[id]
    const prev = existingPlatforms[id] && typeof existingPlatforms[id] === 'object' ? existingPlatforms[id] : null
    const sec = parsed[id]?.fields || {}
    const enabled = selectedIds.has(id)

    let entry
    if (id === 'bilibili') {
      entry = {
        covers: prev?.covers || [...spec.defaultCovers],
        title: sliceChars(sec.标题 || prev?.title || baseTitle, 80),
        desc: sliceChars(sec.简介 || sec.正文 || sec.描述 || prev?.desc || summary, 2000),
        tags: withRequiredTags(sec.标签 || sec.话题 ? parseTagList(sec.标签 || sec.话题) : (prev?.tags || ['AI', '效率工具']), requiredTags, 10),
      }
      if (prev?.category) entry.category = prev.category
    } else if (id === 'xhs') {
      const cleanSummary = stripUrlsAndAngles(sec.正文 || sec.简介 || prev?.body || summary, { allowLinks: false })
      entry = {
        covers: prev?.covers || [...spec.defaultCovers],
        title: sliceChars(stripUrlsAndAngles(sec.标题 || prev?.title || baseTitle, { allowLinks: false }), 20),
        body: sliceChars(cleanSummary || baseTitle, 1000),
        topics: withRequiredTags(sec.话题 || sec.标签 ? parseTagList(sec.话题 || sec.标签) : (prev?.topics || []), requiredTags, 8),
      }
    } else if (id === 'douyin') {
      const cleanSummary = stripUrlsAndAngles(sec.正文 || sec.简介 || prev?.body || summary, { allowLinks: false })
      entry = {
        covers: prev?.covers || [...spec.defaultCovers],
        title: sliceChars(stripUrlsAndAngles(sec.标题 || prev?.title || baseTitle, { allowLinks: false }), 30),
        body: sliceChars(cleanSummary, 1000),
        topics: withRequiredTags(sec.话题 || sec.标签 ? parseTagList(sec.话题 || sec.标签) : (prev?.topics || []), requiredTags, 5),
      }
    } else if (id === 'channels') {
      const cleanSummary = stripUrlsAndAngles(sec.正文 || sec.描述 || prev?.body || summary, { allowLinks: false })
      entry = {
        covers: prev?.covers || [...spec.defaultCovers],
        shortTitle: padShortTitle(sec.短标题 || sec.标题 || prev?.shortTitle || baseTitle),
        body: sliceChars(cleanSummary, 1000),
        topics: withRequiredTags(sec.话题 || sec.标签 ? parseTagList(sec.话题 || sec.标签) : (prev?.topics || []), requiredTags, 8),
      }
    } else if (id === 'youtube') {
      entry = {
        covers: prev?.covers || [...spec.defaultCovers],
        title: sliceChars(stripUrlsAndAngles(sec.标题 || prev?.title || baseTitle, { noAngle: true }), 100),
        desc: sliceChars(stripUrlsAndAngles(sec.简介 || sec.说明 || sec.正文 || prev?.desc || summary, { noAngle: true }), 5000),
        tags: withRequiredTags(sec.标签 || sec.话题 ? parseTagList(sec.标签 || sec.话题) : (prev?.tags || []), requiredTags, 15),
      }
    } else if (id === 'x') {
      const xText = sec.正文 || sec.配文 || prev?.text || `${baseTitle}\n\n${sliceChars(summary, 200)}`
      entry = {
        covers: [],
        text: sliceChars(xText, 25000),
      }
      if (prev?.mode) entry.mode = prev.mode
      if (prev?.article) entry.article = prev.article
    } else if (id === 'instagram') {
      const tags = sec.话题 || sec.标签 ? parseTagList(sec.话题 || sec.标签) : []
      const suffix = tags.length ? `\n\n${tags.slice(0, 10).map(t => `#${t}`).join(' ')}` : ''
      entry = {
        covers: prev?.covers || [...spec.defaultCovers],
        caption: sliceChars((sec.配文 || sec.正文 || prev?.caption || `${baseTitle}\n\n${sliceChars(summary, 300)}`) + suffix, 2200),
      }
    }

    if (!enabled) {
      entry.skip = prev?.skip || '未在稿件平台中勾选'
    } else {
      delete entry.skip
    }
    out[id] = entry
  }
  return out
}

async function listBundleFiles(dir, prefix = '', out = new Set()) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return out
    throw err
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) await listBundleFiles(join(dir, entry.name), rel, out)
    else if (entry.isFile()) out.add(rel)
  }
  return out
}

async function findSourceCover(piece, vaultRoot) {
  const candidates = []
  if (piece.file) {
    const assetsDir = `${piece.file.slice(0, -3)}-assets`
    candidates.push(assetsDir)
    // 如果视频稿件位于专属子文件夹（不是状态根目录），也查找同目录的 cover.png / 封面.jpg
    const parentDir = dirname(piece.file)
    const statusRoots = Object.values(STATUS_DIRS[piece.form] || {}).map(rel => resolve(vaultRoot, rel))
    if (!statusRoots.includes(resolve(parentDir))) {
      candidates.push(parentDir)
    }
  }
  for (const dir of candidates) {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const imgs = entries
      .filter(e => e.isFile() && IMAGE_EXTS.has(extname(e.name).toLowerCase()))
      .map(e => e.name)
    const preferred = imgs.find(n => /^(cover|video-cover|封面|视频封面)/i.test(n)) || imgs[0]
    if (preferred) return join(dir, preferred)
  }
  return null
}

async function cropOrCopyCover(src, dest, targetW, targetH) {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', src], { timeout: 8000 })
      const w = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] || 0)
      const h = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1] || 0)
      if (w >= 64 && h >= 64) {
        const ratio = targetW / targetH
        const cropW = Math.min(w, Math.round(h * ratio))
        const cropH = Math.min(h, Math.round(w / ratio))
        await copyFile(src, dest)
        await execFileAsync('/usr/bin/sips', ['-c', String(cropH), String(cropW), '--resampleHeightWidth', String(targetH), String(targetW), '-s', 'format', 'jpeg', dest, '--out', dest], { timeout: 10000 })
        return
      }
    } catch {
      // 测试图或环境无 sips 时直接复制原图
    }
  }
  await copyFile(src, dest)
}

async function probeDurationSec(videoPath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], { timeout: 8000 })
    const sec = Math.round(Number(stdout.trim()))
    return Number.isFinite(sec) && sec > 0 ? sec : undefined
  } catch {
    return undefined
  }
}

function pickEarliestSchedule(piece, selectedPlatforms, { now = Date.now(), fixedOffsetMinutes = null } = {}) {
  const videoPlatforms = selectedPlatforms.filter(p => DESK_TO_MAITIAN[p])
  const candidates = (piece.schedules || [])
    .filter(row => videoPlatforms.includes(row.platform) && row.at)
    .map(row => ({ ...row, iso: localScheduleToIso(row.at, fixedOffsetMinutes) }))
    .filter(row => row.iso && !Number.isNaN(Date.parse(row.iso)))
    .sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso))
  if (!candidates.length) return { scheduleIso: undefined, sourceAt: null, scheduleNote: null }
  const earliest = candidates[0]
  const ms = Date.parse(earliest.iso)
  if (ms < now + 2 * 3600_000 || ms > now + 14 * 86_400_000) {
    return {
      scheduleIso: undefined,
      sourceAt: earliest.at,
      scheduleNote: `最早排期 ${earliest.at} 不在「当前 +2 小时 ~ +14 天」窗口内，已暂按不设自动定时生成，可在面板内调整`,
    }
  }
  return { scheduleIso: earliest.iso, sourceAt: earliest.at, scheduleNote: null }
}

async function moveFileAcross(src, dest) {
  try {
    await rename(src, dest)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await copyFile(src, dest)
    await unlink(src)
  }
}

export class BundleService {
  constructor({ settings, pieces, publishStore, callText, now = () => Date.now(), fixedOffsetMinutes = null }) {
    this.settings = settings
    this.pieces = pieces
    this.publishStore = publishStore
    this.callText = callText
    this.now = now
    this.fixedOffsetMinutes = fixedOffsetMinutes
  }

  async _bundleDirFor(piece, savedSettings) {
    const existing = await this.publishStore.getBundle(piece.note)
    if (existing?.dir) return existing.dir
    const root = resolveBundleRoot(savedSettings)
    return join(root, safeFolderName(piece.note))
  }

  async _inspect(piece, dir, savedSettings, extraNote = null) {
    const publishFile = join(dir, 'publish.json')
    let bundle = null
    try {
      bundle = JSON.parse(await readFile(publishFile, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (!bundle) {
      return {
        prepared: false,
        bundleRoot: resolveBundleRoot(savedSettings),
        dir,
        bundle: null,
        videoReady: false,
        faststart: null,
        validation: { errors: [], warnings: [] },
        record: null,
      }
    }
    const files = await listBundleFiles(dir)
    const videoFile = join(dir, bundle.video || '成片.mp4')
    const faststart = files.has(bundle.video || '成片.mp4')
      ? await checkMp4Faststart(videoFile)
      : { ok: false, missing: true, reason: '等待放入 成片.mp4' }
    const validation = validateBundle(bundle, {
      files,
      now: this.now(),
      bannedWords: savedSettings.publish?.bannedWords || [],
    })
    if (faststart && !faststart.ok && !faststart.missing) {
      validation.warnings.push(faststart.reason)
    }
    if (extraNote) validation.warnings.unshift(extraNote)

    let record = null
    try {
      record = JSON.parse(await readFile(join(dir, '发布记录.json'), 'utf8'))
    } catch {
      record = null
    }
    return {
      prepared: true,
      bundleRoot: resolveBundleRoot(savedSettings),
      dir,
      bundle,
      files: [...files].sort(),
      videoReady: Boolean(files.has(bundle.video || '成片.mp4')),
      faststart,
      beijingSchedule: bundle.schedule ? beijingPreview(bundle.schedule, this.fixedOffsetMinutes) : '',
      validation,
      readyToFill: validation.errors.length === 0,
      record,
    }
  }

  async status(note) {
    const saved = await this.settings.read()
    const piece = await this.pieces().readPiece(String(note ?? ''))
    if (piece.form === '长文') {
      const hasH1 = /^#\s+\S+/m.test(String(piece.body ?? ''))
      const vaultRel = piece.file && saved.vaultRoot ? relative(saved.vaultRoot, piece.file).split(sep).join('/') : piece.path || ''
      return {
        form: '长文',
        xArticle: {
          hasH1,
          vaultRel,
          composeUrl: 'https://x.com/compose/articles',
        },
      }
    }
    const dir = await this._bundleDirFor(piece, saved)
    return this._inspect(piece, dir, saved)
  }

  async prepare({ note, overwriteCopy = false, overwriteCovers = false }) {
    const saved = await this.settings.read()
    const piece = await this.pieces().readPiece(String(note ?? ''))
    if (piece.form !== '视频') throw fail(400, '只有视频稿件可以生成麦田发布包')

    const dir = await this._bundleDirFor(piece, saved)
    const coversDir = join(dir, '封面')
    await mkdir(coversDir, { recursive: true })

    let prevBundle = null
    try {
      prevBundle = JSON.parse(await readFile(join(dir, 'publish.json'), 'utf8'))
    } catch {
      prevBundle = null
    }

    const coverSpecs = [
      ['3x4', '封面/cover-3x4.jpg', 1080, 1440],
      ['4x3', '封面/cover-4x3.jpg', 1440, 1080],
      ['16x9', '封面/cover-16x9.jpg', 1920, 1080],
    ]
    const sourceCover = await findSourceCover(piece, saved.vaultRoot)
    const covers = { ...(prevBundle?.covers || {}) }
    if (sourceCover) {
      for (const [ratio, relPath, w, h] of coverSpecs) {
        const target = join(dir, relPath)
        const exists = await stat(target).then(() => true, () => false)
        if (!exists || overwriteCovers) {
          await cropOrCopyCover(sourceCover, target, w, h)
        }
        covers[ratio] = relPath
      }
    } else {
      // 检查目录中是否已有手工放入的封面
      for (const [ratio, relPath] of coverSpecs) {
        if (await stat(join(dir, relPath)).then(() => true, () => false)) {
          covers[ratio] = relPath
        }
      }
    }

    const { scheduleIso, sourceAt, scheduleNote } = pickEarliestSchedule(piece, piece.platforms || [], {
      now: this.now(),
      fixedOffsetMinutes: this.fixedOffsetMinutes,
    })

    // 将勾选的视频平台排期对齐到同一时间
    if (scheduleIso && sourceAt) {
      for (const plat of piece.platforms || []) {
        if (!DESK_TO_MAITIAN[plat]) continue
        const cur = (piece.schedules || []).find(s => s.platform === plat)
        if (cur?.at !== sourceAt) {
          await this.pieces().setSchedule({ note: piece.note, platform: plat, at: sourceAt })
        }
      }
    }

    const requiredTags = saved.publish?.requiredTags || []
    const platforms = buildPlatformsConfig(piece, piece.body || '', {
      selectedPlatforms: piece.platforms || [],
      existingPlatforms: overwriteCopy ? {} : (prevBundle?.platforms || {}),
      requiredTags,
    })

    // 如果尚未有封面文件，不阻塞无封面的 X，但保留需要封面的平台封面声明以便校验明确提示缺哪张封面
    for (const [ratio, relPath] of coverSpecs) {
      if (!covers[ratio]) covers[ratio] = relPath
    }

    const videoRel = prevBundle?.video || '成片.mp4'
    const durationSec = await probeDurationSec(join(dir, videoRel)) ?? prevBundle?.durationSec

    const bundle = {
      version: 1,
      id: piece.note,
      name: piece.title || piece.note,
      source: piece.file && saved.vaultRoot ? relative(saved.vaultRoot, piece.file).split(sep).join('/') : `${piece.note}.md`,
      video: videoRel,
      ...(durationSec ? { durationSec } : {}),
      requiredTags,
      ...(scheduleIso ? { schedule: scheduleIso } : {}),
      covers,
      platforms,
    }

    await writeFile(join(dir, 'publish.json'), JSON.stringify(bundle, null, 2) + '\n', 'utf8')
    await this.publishStore.saveBundle(piece.note, { dir })
    return this._inspect(piece, dir, saved, scheduleNote)
  }

  async saveCopy({ note, platforms, schedule }) {
    const saved = await this.settings.read()
    const piece = await this.pieces().readPiece(String(note ?? ''))
    if (piece.form !== '视频') throw fail(400, '只有视频稿件可以修改发布包')
    const dir = await this._bundleDirFor(piece, saved)
    const publishFile = join(dir, 'publish.json')
    let bundle
    try {
      bundle = JSON.parse(await readFile(publishFile, 'utf8'))
    } catch {
      throw fail(400, '请先准备发布包')
    }
    if (platforms && typeof platforms === 'object') {
      for (const [id, patch] of Object.entries(platforms)) {
        if (!BUNDLE_PLATFORMS[id] || !patch || typeof patch !== 'object') continue
        const current = bundle.platforms?.[id] || {}
        const next = { ...current }
        for (const key of ['title', 'shortTitle', 'desc', 'body', 'text', 'caption', 'category']) {
          if (typeof patch[key] === 'string') next[key] = patch[key]
        }
        if (Array.isArray(patch.tags)) next.tags = patch.tags.map(t => String(t).trim()).filter(Boolean)
        if (Array.isArray(patch.topics)) next.topics = patch.topics.map(t => String(t).trim().replace(/^#/, '')).filter(Boolean)
        if (patch.skip === null || patch.skip === false || patch.skip === '') delete next.skip
        else if (typeof patch.skip === 'string') next.skip = patch.skip.trim()
        bundle.platforms[id] = next
      }
    }
    if (schedule !== undefined) {
      const trimmed = String(schedule ?? '').trim()
      if (!trimmed) {
        delete bundle.schedule
      } else {
        const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(trimmed)
          ? localScheduleToIso(trimmed, this.fixedOffsetMinutes)
          : trimmed
        if (!iso || Number.isNaN(Date.parse(iso))) throw fail(400, '排期时间格式无效')
        bundle.schedule = iso
      }
    }
    await writeFile(publishFile, JSON.stringify(bundle, null, 2) + '\n', 'utf8')
    return this._inspect(piece, dir, saved)
  }

  async generateCopy(ctx, { note }) {
    if (typeof this.callText !== 'function') throw fail(502, '当前未配置可用的文字模型')
    const saved = await this.settings.read()
    const piece = await this.pieces().readPiece(String(note ?? ''))
    if (piece.form !== '视频') throw fail(400, '只有视频稿件可以生成多平台文案')
    const statusBefore = await this.status(piece.note)
    if (!statusBefore.prepared) await this.prepare({ note: piece.note })
    const dir = await this._bundleDirFor(piece, saved)
    const publishFile = join(dir, 'publish.json')
    const bundle = JSON.parse(await readFile(publishFile, 'utf8'))

    const system = `你是资深自媒体多平台运营编辑。根据用户的视频脚本，为以下 7 个平台生成符合各自字数硬上限和社区规范的发布文案，只输出严格合法的 JSON 对象（不要任何解释）：
{
  "bilibili": { "title": "1-80字吸引点击的标题", "desc": "200字内视频简介", "tags": ["标签1", "标签2"] },
  "xhs": { "title": "1-20字标题（严禁超20字）", "body": "300字内笔记正文（严禁出现任何网址、微信号、引流词）", "topics": ["话题1", "话题2"] },
  "douyin": { "title": "1-30字标题", "body": "150字内文案（严禁网址、微信号、引流词）", "topics": ["话题1", "话题2"] },
  "channels": { "shortTitle": "6-16字短标题（必须不少于6字且不超过16字）", "body": "200字内描述（严禁网址、微信号、引流词）", "topics": ["话题1", "话题2"] },
  "youtube": { "title": "1-100字标题（不含尖括号）", "desc": "400字内视频说明（不含尖括号）", "tags": ["tag1", "tag2"] },
  "x": { "text": "240字以内的推文导语" },
  "instagram": { "caption": "300字内配文，末尾带3-5个 #标签" }
}`
    const user = `视频标题：${piece.title}\n必带标签：${(saved.publish?.requiredTags || []).join('、') || '无'}\n\n脚本正文：\n${String(piece.body || '').slice(0, 6000)}`
    const { text } = await this.callText(ctx, { system, user, signal: AbortSignal.timeout(120_000) })
    const generated = extractJson(text)
    const reqTags = saved.publish?.requiredTags || []

    if (generated.bilibili) {
      Object.assign(bundle.platforms.bilibili, {
        title: sliceChars(generated.bilibili.title || piece.title, 80),
        desc: sliceChars(generated.bilibili.desc || '', 2000),
        tags: withRequiredTags(generated.bilibili.tags, reqTags, 10),
      })
    }
    if (generated.xhs) {
      Object.assign(bundle.platforms.xhs, {
        title: sliceChars(stripUrlsAndAngles(generated.xhs.title || piece.title, { allowLinks: false }), 20),
        body: sliceChars(stripUrlsAndAngles(generated.xhs.body || piece.title, { allowLinks: false }), 1000),
        topics: withRequiredTags(generated.xhs.topics, reqTags, 8),
      })
    }
    if (generated.douyin) {
      Object.assign(bundle.platforms.douyin, {
        title: sliceChars(stripUrlsAndAngles(generated.douyin.title || piece.title, { allowLinks: false }), 30),
        body: sliceChars(stripUrlsAndAngles(generated.douyin.body || '', { allowLinks: false }), 1000),
        topics: withRequiredTags(generated.douyin.topics, reqTags, 5),
      })
    }
    if (generated.channels) {
      Object.assign(bundle.platforms.channels, {
        shortTitle: padShortTitle(generated.channels.shortTitle || piece.title),
        body: sliceChars(stripUrlsAndAngles(generated.channels.body || '', { allowLinks: false }), 1000),
        topics: withRequiredTags(generated.channels.topics, reqTags, 8),
      })
    }
    if (generated.youtube) {
      Object.assign(bundle.platforms.youtube, {
        title: sliceChars(stripUrlsAndAngles(generated.youtube.title || piece.title, { noAngle: true }), 100),
        desc: sliceChars(stripUrlsAndAngles(generated.youtube.desc || '', { noAngle: true }), 5000),
        tags: withRequiredTags(generated.youtube.tags, reqTags, 15),
      })
    }
    if (generated.x) {
      Object.assign(bundle.platforms.x, {
        text: sliceChars(generated.x.text || piece.title, 25000),
      })
    }
    if (generated.instagram) {
      Object.assign(bundle.platforms.instagram, {
        caption: sliceChars(generated.instagram.caption || piece.title, 2200),
      })
    }

    await writeFile(publishFile, JSON.stringify(bundle, null, 2) + '\n', 'utf8')
    return this._inspect(piece, dir, saved)
  }

  async placeVideo({ note, sourcePath }) {
    const raw = String(sourcePath ?? '').trim()
    if (!raw) throw fail(400, '请填写本地成片文件的路径')
    const resolved = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : resolve(raw)
    if (!isAbsolute(resolved)) throw fail(400, '成片路径必须是绝对路径')
    const ext = extname(resolved).toLowerCase()
    if (!VIDEO_EXTS.has(ext)) throw fail(400, '成片只支持 .mp4 或 .mov 文件')

    let info
    try {
      info = await lstat(resolved)
    } catch (err) {
      if (err.code === 'ENOENT') throw fail(404, '找不到这个成片文件')
      throw err
    }
    if (!info.isFile() || info.isSymbolicLink()) throw fail(400, '成片必须是普通视频文件，不能是软链接或目录')

    const saved = await this.settings.read()
    const piece = await this.pieces().readPiece(String(note ?? ''))
    if (piece.form !== '视频') throw fail(400, '只有视频稿件可以归位成片')

    let current = await this.status(piece.note)
    if (!current.prepared) current = await this.prepare({ note: piece.note })
    const dir = current.dir
    const targetName = ext === '.mov' ? '成片.mov' : '成片.mp4'
    const dest = join(dir, targetName)
    if (resolve(resolved) !== resolve(dest)) {
      await moveFileAcross(resolved, dest)
    }

    const publishFile = join(dir, 'publish.json')
    const bundle = JSON.parse(await readFile(publishFile, 'utf8'))
    bundle.video = targetName
    const durationSec = await probeDurationSec(dest)
    if (durationSec) bundle.durationSec = durationSec
    await writeFile(publishFile, JSON.stringify(bundle, null, 2) + '\n', 'utf8')
    await this.publishStore.saveBundle(piece.note, { dir, videoFile: targetName })
    return this._inspect(piece, dir, saved)
  }

  async reveal({ note }) {
    const saved = await this.publishStore.getBundle(String(note ?? ''))
    if (!saved?.dir) throw fail(400, '还没有准备过发布包')
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
    execFile(command, [saved.dir], () => {})
    return { path: saved.dir }
  }

  async backfill({ note, record: uploadedRecord = null }) {
    const savedSettings = await this.settings.read()
    const piece = await this.pieces().readPiece(String(note ?? ''))
    if (piece.form !== '视频') throw fail(400, '只有视频稿件可以回填麦田发布记录')
    const dir = await this._bundleDirFor(piece, savedSettings)
    let record
    if (uploadedRecord && typeof uploadedRecord === 'object' && uploadedRecord.platforms && typeof uploadedRecord.platforms === 'object') {
      record = uploadedRecord
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, '发布记录.json'), JSON.stringify(record, null, 2) + '\n', 'utf8')
      await this.publishStore.saveBundle(piece.note, { dir })
    } else {
      try {
        record = JSON.parse(await readFile(join(dir, '发布记录.json'), 'utf8'))
      } catch (err) {
        if (err.code === 'ENOENT') throw fail(404, '还没有找到 发布记录.json，请先在麦田扩展里点「回填链接」或上传本地 发布记录.json')
        throw fail(400, '发布记录.json 格式无效')
      }
    }

    const todayDate = (() => {
      const d = new Date(this.now())
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()

    const applied = []
    const pending = []
    const failed = []

    for (const [id, entry] of Object.entries(record?.platforms || {})) {
      const deskPlatform = MAITIAN_TO_DESK[id]
      if (!deskPlatform || !entry || typeof entry !== 'object') continue
      const status = String(entry.status || '').trim()
      let url = typeof entry.url === 'string' ? entry.url.trim() : ''
      if ((status === '已发布' || status === '已上线') && !url && id === 'channels') {
        url = CHANNELS_FALLBACK_URL
      }
      let pubDate = todayDate
      if (entry.time) {
        const parsed = typeof entry.time === 'number' ? new Date(entry.time) : new Date(String(entry.time))
        if (!Number.isNaN(parsed.getTime())) {
          pubDate = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
        } else if (/^\d{4}-\d{2}-\d{2}/.test(String(entry.time))) {
          pubDate = String(entry.time).slice(0, 10)
        }
      }

      if ((status === '已发布' || status === '已上线') && /^https?:\/\//.test(url)) {
        await this.pieces().publish({ note: piece.note, platform: deskPlatform, url, date: pubDate })
        applied.push({ platform: deskPlatform, url, date: pubDate, fallbackUrl: id === 'channels' && !entry.url })
      } else if (status === '定时' || status === '审核中' || status === '转码中') {
        pending.push({ platform: deskPlatform, status, time: entry.time || null, note: entry.note || '' })
      } else {
        failed.push({ platform: deskPlatform, status: status || '未知', note: entry.note || '' })
      }
    }

    await this.publishStore.saveBundle(piece.note, {
      dir,
      backfilledAt: new Date(this.now()).toISOString(),
      lastBackfill: { applied, pending, failed },
    })

    return {
      applied,
      pending,
      failed,
      piece: await this.pieces().readPiece(piece.note),
    }
  }

  async ensureXHeading({ note }) {
    const piece = await this.pieces().readPiece(String(note ?? ''))
    if (piece.form !== '长文') throw fail(400, '只有长文需要检查 X 长文标题行')
    const body = String(piece.body ?? '')
    if (/^#\s+\S+/m.test(body)) return { updated: false, piece }
    const nextBody = `\n# ${piece.title}\n${body.startsWith('\n') ? body : `\n${body}`}`
    await this.pieces().saveBody({ note: piece.note, body: nextBody, mtimeMs: piece.mtimeMs })
    return { updated: true, piece: await this.pieces().readPiece(piece.note) }
  }

  /**
   * 打包下载视频发布包（含 publish.json、三比例封面与 发布记录.json，不含大体积成片视频，跨电脑秒下）。
   */
  async exportBundleZip({ note }) {
    const saved = await this.settings.read()
    const piece = await this.pieces().readPiece(String(note ?? ''))
    if (piece.form !== '视频') throw fail(400, '只有视频稿件可以下载发布包')
    const dir = await this._bundleDirFor(piece, saved)
    let realDir
    try {
      realDir = await realpath(dir)
      await stat(join(realDir, 'publish.json'))
    } catch {
      throw fail(400, '请先准备发布包')
    }

    const folderName = safeFolderName(piece.note)
    const relFiles = await listBundleFiles(realDir)
    const entries = []

    for (const rel of [...relFiles].sort()) {
      const ext = extname(rel).toLowerCase()
      if (VIDEO_EXTS.has(ext)) continue // 视频大文件走单独流式下载或使用当前电脑本地成片
      const full = join(realDir, rel)
      const realFull = await realpath(full).catch(() => null)
      if (!realFull || (!realFull.startsWith(`${realDir}${sep}`) && realFull !== realDir)) continue
      const info = await stat(realFull)
      if (!info.isFile() || info.size > MAX_BUNDLE_ZIP_FILE_BYTES) continue
      const data = await readFile(realFull)
      entries.push({
        name: `${folderName}/${rel}`,
        data,
        mtime: info.mtime,
      })
    }

    return {
      filename: `${folderName}-发布包.zip`,
      buffer: createZipBuffer(entries),
    }
  }

  /**
   * 校验并返回发布包内的成片文件路径（供跨电脑 Range 流式下载）。
   */
  async videoFileFor({ note }) {
    const saved = await this.settings.read()
    const piece = await this.pieces().readPiece(String(note ?? ''))
    if (piece.form !== '视频') throw fail(400, '只有视频稿件可以下载成片')
    const dir = await this._bundleDirFor(piece, saved)
    let bundle
    let realDir
    try {
      realDir = await realpath(dir)
      bundle = JSON.parse(await readFile(join(realDir, 'publish.json'), 'utf8'))
    } catch {
      throw fail(400, '请先准备发布包')
    }
    const videoRel = String(bundle.video || '成片.mp4')
    if (videoRel.includes('..') || isAbsolute(videoRel)) throw fail(400, '成片路径无效')
    const full = join(realDir, videoRel)
    let realFull
    try {
      realFull = await realpath(full)
    } catch {
      throw fail(404, '发布包内还没有放入成片文件')
    }
    if (!realFull.startsWith(`${realDir}${sep}`)) throw fail(400, '成片路径无效')
    const info = await lstat(full)
    if (!info.isFile() || info.isSymbolicLink()) throw fail(400, '成片路径无效')
    return {
      file: realFull,
      filename: `${safeFolderName(piece.note)}-${basename(videoRel)}`,
    }
  }

  /**
   * 打包下载「麦田发布助手」Chrome 扩展，便于在另一台电脑或任意电脑解压安装。
   */
  async exportMaitianZip() {
    const candidates = [join(PACKAGE_ROOT, 'extensions', 'maitian-publisher')]

    for (const extDir of candidates) {
      if (await stat(join(extDir, 'manifest.json')).then(s => s.isFile(), () => false)) {
        return {
          filename: 'maitian-publisher-extension.zip',
          buffer: await buildMaitianExtensionZip(extDir),
        }
      }
    }

    const prebuilt = join(PACKAGE_ROOT, 'dist', 'maitian-publisher.zip')
    try {
      const buffer = await readFile(prebuilt)
      return { filename: 'maitian-publisher-extension.zip', buffer }
    } catch {
      throw fail(404, '未找到麦田发布助手扩展目录')
    }
  }
}

export async function buildMaitianExtensionZip(extDir) {
  const realExt = await realpath(extDir)
  const allowTopFiles = ['manifest.json', 'background.js', 'sidepanel.html', 'sidepanel.css', 'sidepanel.js', 'video.js', 'LICENSE', 'README.md']
  const allowDirs = ['icons', 'lib']
  const entries = []

  for (const name of allowTopFiles) {
    const full = join(realExt, name)
    try {
      const info = await stat(full)
      if (info.isFile()) {
        entries.push({ name: `maitian-publisher/${name}`, data: await readFile(full), mtime: info.mtime })
      }
    } catch { /* optional */ }
  }

  async function walkSub(relDir) {
    const absDir = join(realExt, relDir)
    let list = []
    try {
      list = await readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of list) {
      if (ent.name.startsWith('.')) continue
      const relPath = `${relDir}/${ent.name}`
      if (ent.isDirectory()) {
        await walkSub(relPath)
      } else if (ent.isFile()) {
        const full = join(realExt, relPath)
        const realFull = await realpath(full).catch(() => null)
        if (!realFull || !realFull.startsWith(`${realExt}${sep}`)) continue
        const info = await stat(realFull)
        entries.push({ name: `maitian-publisher/${relPath}`, data: await readFile(realFull), mtime: info.mtime })
      }
    }
  }

  for (const sub of allowDirs) {
    await walkSub(sub)
  }
  return createZipBuffer(entries)
}

export function basenameOf(p) {
  return basename(String(p || ''))
}
