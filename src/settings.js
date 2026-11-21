// 工作台设置。密钥和内容数据分开存放，文件权限 600，也不会返回给浏览器。
import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tr } from './i18n.js'
import { normalizeCap, normalizeXRefresh, XREFRESH_DEFAULTS } from './xrefresh.js'

const DEFAULTS = {
  image: { source: 'http', baseUrl: '', model: '', apiKey: '', size: '1536x1024', quality: '', toolSize: '1536x1024', toolQuality: '', extra: '' },
  voice: '',
  exportDir: '',
  imageCount: 2,
  shotCount: 6,
  language: 'auto',
  fontScale: 1,
  xRefresh: structuredClone(XREFRESH_DEFAULTS),
  monidMonthlyCapUsd: 0,
  publish: {
    bundleDir: '',
    requiredTags: [],
    bannedWords: [],
    wechatsyncEnabled: false,
    wechatsyncAllowTailscale: false,
    wechatsyncPort: 9537,
    wechatsyncToken: '',
    wechatsyncLockedExtId: '',
  },
}

function normalizeStringList(value, maxItems = 40, maxLen = 40) {
  if (typeof value === 'string') {
    return value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean).slice(0, maxItems).map(item => item.slice(0, maxLen))
  }
  if (!Array.isArray(value)) return []
  return value.map(item => String(item ?? '').trim()).filter(Boolean).slice(0, maxItems).map(item => item.slice(0, maxLen))
}

function normalizePublish(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const port = Number(src.wechatsyncPort)
  return {
    bundleDir: typeof src.bundleDir === 'string' ? src.bundleDir.trim().slice(0, 500) : '',
    requiredTags: normalizeStringList(src.requiredTags, 20, 20),
    bannedWords: normalizeStringList(src.bannedWords, 50, 40),
    wechatsyncEnabled: typeof src.wechatsyncEnabled === 'boolean' ? src.wechatsyncEnabled : false,
    wechatsyncAllowTailscale: typeof src.wechatsyncAllowTailscale === 'boolean' ? src.wechatsyncAllowTailscale : false,
    wechatsyncPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 9537,
    wechatsyncToken: typeof src.wechatsyncToken === 'string' ? src.wechatsyncToken.trim().slice(0, 200) : '',
    wechatsyncLockedExtId: typeof src.wechatsyncLockedExtId === 'string' ? src.wechatsyncLockedExtId.trim().slice(0, 80) : '',
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

export class Settings {
  constructor(root) {
    const workspaceRoot = join(root, 'workspace')
    this.paths = { workspaceRoot, vaultRoot: join(workspaceRoot, '知识库'), logDir: join(workspaceRoot, '日志'), attachmentIndex: join(workspaceRoot, '素材', '索引.md'), ingestScript: process.env.MEDIA_DESK_INGEST_SCRIPT || '', wechatStyles: join(workspaceRoot, 'styles.md'), exportDir: join(workspaceRoot, 'exports') }
    this.file = join(root, 'settings.json')
    this.value = null
  }

  async read() {
    // 每次都读文件：桌面版和 Web 版可能同时运行
    try {
      const { assistant: retiredModelPreference, ...saved } = JSON.parse(await readFile(this.file, 'utf8'))
      this.value = {
        ...DEFAULTS,
        ...this.paths,
        ...saved,
        image: { ...DEFAULTS.image, ...saved.image },
        xRefresh: normalizeXRefresh(saved.xRefresh),
        monidMonthlyCapUsd: normalizeCap(saved.monidMonthlyCapUsd),
        publish: normalizePublish(saved.publish),
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      this.value = { ...structuredClone(DEFAULTS), ...this.paths }
    }
    return this.value
  }

  /** 空密钥表示不修改，clearKey 才会删除。 */
  async update(patch) {
    const current = await this.read()
    const next = structuredClone(current)
    const image = patch.image ?? {}
    if (image.source !== undefined) {
      if (!['http', 'tool'].includes(image.source)) throw Object.assign(new Error(tr('生图来源无效')), { status: 400 })
      next.image.source = image.source
    }
    for (const key of ['model', 'size', 'quality']) {
      if (typeof image[key] === 'string') next.image[key] = image[key].trim().slice(0, 200)
    }
    for (const [key, values, message] of [
      ['toolSize', ['', '1024x1024', '1024x1536', '1536x1024', 'auto'], '订阅生图工具不支持这个尺寸'],
      ['toolQuality', ['', 'low', 'medium', 'high', 'auto'], '订阅生图工具不支持这个质量'],
    ]) {
      if (image[key] !== undefined) {
        if (typeof image[key] !== 'string' || !values.includes(image[key].trim())) throw Object.assign(new Error(tr(message)), { status: 400 })
        next.image[key] = image[key].trim()
      }
    }
    if (typeof image.baseUrl === 'string') {
      const url = image.baseUrl.trim().replace(/\/+$/, '').replace(/\/images\/generations$/, '')
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw Object.assign(new Error(tr('接口地址要以 http:// 或 https:// 开头')), { status: 400 })
      next.image.baseUrl = url
    }
    if (typeof image.extra === 'string') {
      const extra = image.extra.trim()
      if (extra) {
        let parsed
        try {
          parsed = JSON.parse(extra)
        } catch {
          parsed = null
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error(tr('附加参数要是一个 JSON 对象')), { status: 400 })
      }
      next.image.extra = extra
    }
    if (typeof image.apiKey === 'string' && image.apiKey.trim()) next.image.apiKey = image.apiKey.trim()
    if (image.clearKey === true) next.image.apiKey = ''
    if (typeof patch.voice === 'string') next.voice = patch.voice.slice(0, 8000)
    if (typeof patch.exportDir === 'string') next.exportDir = patch.exportDir.trim().slice(0, 500)
    if (patch.imageCount !== undefined) next.imageCount = clamp(patch.imageCount, 0, 4, current.imageCount)
    if (['auto', 'zh', 'en'].includes(patch.language)) next.language = patch.language
    if (patch.fontScale !== undefined) {
      const scale = Number(patch.fontScale)
      if (!Number.isFinite(scale) || scale < 0.8 || scale > 1.6) throw Object.assign(new Error(tr('字号无效')), { status: 400 })
      next.fontScale = Math.round(scale * 100) / 100
    }
    if (patch.shotCount !== undefined) next.shotCount = clamp(patch.shotCount, 0, 12, current.shotCount)
    if (patch.xRefresh && typeof patch.xRefresh === 'object') {
      if (typeof patch.xRefresh.enabled === 'boolean') next.xRefresh.enabled = patch.xRefresh.enabled
      if (patch.xRefresh.everyHours !== undefined) next.xRefresh.everyHours = clamp(patch.xRefresh.everyHours, 1, 168, next.xRefresh.everyHours)
    }
    if (patch.monidMonthlyCapUsd !== undefined) next.monidMonthlyCapUsd = normalizeCap(patch.monidMonthlyCapUsd)
    if (patch.publish && typeof patch.publish === 'object') {
      const pub = patch.publish
      const merged = { ...next.publish }
      if (pub.bundleDir !== undefined) merged.bundleDir = String(pub.bundleDir ?? '').trim().slice(0, 500)
      if (pub.requiredTags !== undefined) merged.requiredTags = normalizeStringList(pub.requiredTags, 20, 20)
      if (pub.bannedWords !== undefined) merged.bannedWords = normalizeStringList(pub.bannedWords, 50, 40)
      if (typeof pub.wechatsyncEnabled === 'boolean') merged.wechatsyncEnabled = pub.wechatsyncEnabled
      if (typeof pub.wechatsyncAllowTailscale === 'boolean') merged.wechatsyncAllowTailscale = pub.wechatsyncAllowTailscale
      if (pub.wechatsyncPort !== undefined) {
        const port = Number(pub.wechatsyncPort)
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Object.assign(new Error(tr('端口号必须在 1024 到 65535 之间')), { status: 400 })
        merged.wechatsyncPort = port
      }
      if (typeof pub.wechatsyncToken === 'string' && pub.wechatsyncToken.trim()) merged.wechatsyncToken = pub.wechatsyncToken.trim().slice(0, 200)
      if (pub.clearWechatsyncToken === true) merged.wechatsyncToken = ''
      if (typeof pub.wechatsyncLockedExtId === 'string') merged.wechatsyncLockedExtId = pub.wechatsyncLockedExtId.trim().slice(0, 80)
      next.publish = normalizePublish(merged)
    }
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.file)
    this.value = next
    return next
  }
}

export function imageReady(settings, toolAvailable = false) {
  if (settings.image.source === 'tool') return toolAvailable
  return Boolean(settings.image.baseUrl && settings.image.model && settings.image.apiKey)
}

/** 发给浏览器的版本：只告诉它有没有密钥和末四位。 */
export function publicSettings(settings, toolAvailable = false) {
  const { apiKey, ...image } = settings.image
  const { wechatsyncToken, ...publish } = settings.publish ?? normalizePublish({})
  const { vaultRoot, workspaceRoot, logDir, ingestScript, attachmentIndex, wechatStyles, publish: _pub, ...rest } = settings
  return {
    ...rest,
    image: { ...image, hasKey: Boolean(apiKey), keyHint: apiKey ? apiKey.slice(-4) : '' },
    publish: { ...publish, hasToken: Boolean(wechatsyncToken), tokenHint: wechatsyncToken ? wechatsyncToken.slice(-4) : '' },
    imageToolAvailable: toolAvailable,
    imageReady: imageReady(settings, toolAvailable),
  }
}
