// 公共发布底座：平台映射表、设备时区排期转换、北京时间预览、发布包与草稿记录存储。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// 工作台平台名 <-> 麦田发布助手平台 id（视频多平台）
export const DESK_TO_MAITIAN = Object.freeze({
  B站: 'bilibili',
  小红书: 'xhs',
  抖音: 'douyin',
  视频号: 'channels',
  YouTube: 'youtube',
  X: 'x',
  Instagram: 'instagram',
})

export const MAITIAN_TO_DESK = Object.freeze(
  Object.fromEntries(Object.entries(DESK_TO_MAITIAN).map(([desk, id]) => [id, desk])),
)

export const MAITIAN_ORDER = ['bilibili', 'xhs', 'douyin', 'channels', 'youtube', 'x', 'instagram']

// 工作台平台名 <-> Wechatsync 平台 id（长文 / 图文草稿）
export const DESK_TO_WECHATSYNC = Object.freeze({
  公众号: 'weixin',
  知乎: 'zhihu',
  今日头条: 'toutiao',
  小红书: 'xiaohongshu',
  X: 'x',
  B站: 'bilibili',
})

export const WECHATSYNC_TO_DESK = Object.freeze(
  Object.fromEntries(Object.entries(DESK_TO_WECHATSYNC).map(([desk, id]) => [id, desk])),
)

export const WECHATSYNC_NAMES = Object.freeze({
  weixin: '公众号',
  zhihu: '知乎',
  toutiao: '今日头条',
  xiaohongshu: '小红书',
  x: 'X',
  bilibili: 'B站专栏',
  juejin: '掘金',
  csdn: 'CSDN',
  weibo: '微博',
  jianshu: '简书',
  baijiahao: '百家号',
  douban: '豆瓣',
  xueqiu: '雪球',
  yuque: '语雀',
  woshipm: '人人都是产品经理',
  sohu: '搜狐号',
  segmentfault: 'SegmentFault',
  oschina: '开源中国',
  cnblogs: '博客园',
  '51cto': '51CTO',
  aliyun: '阿里云开发者',
  imooc: '慕课手记',
  eastmoney: '财富号',
})

const SCHEDULE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/

function pad(n) {
  return String(n).padStart(2, '0')
}

export function formatOffset(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(Math.trunc(offsetMinutes))
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * 把「YYYY-MM-DD HH:mm」按设备本地时区（或显式传入的分钟偏移，供单测固定）转成带时区偏移的 ISO 字符串。
 * 例如东九区（UTC+09:00）："2026-11-20 20:00" -> "2026-11-20T20:00:00+09:00"。
 */
export function localScheduleToIso(at, fixedOffsetMinutes = null) {
  const match = SCHEDULE_RE.exec(String(at ?? '').trim())
  if (!match) return null
  const [, y, m, d, hh, mm, ss = '00'] = match
  if (typeof fixedOffsetMinutes === 'number' && Number.isFinite(fixedOffsetMinutes)) {
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}${formatOffset(fixedOffsetMinutes)}`
  }
  const local = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
  if (Number.isNaN(local.getTime())) return null
  // Check rollover (e.g. Feb 30)
  if (local.getFullYear() !== Number(y) || local.getMonth() + 1 !== Number(m) || local.getDate() !== Number(d)) {
    return null
  }
  const offsetMinutes = -local.getTimezoneOffset()
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${formatOffset(offsetMinutes)}`
}

/**
 * 把本地排期（"YYYY-MM-DD HH:mm"）或带偏移的 ISO 字符串换算为北京时间（UTC+8），用于界面核对。
 * 若日期与输入本地日期相同返回 "HH:mm"，跨日返回 "MM-DD HH:mm"。
 */
export function beijingPreview(atOrIso, fixedLocalOffsetMinutes = null) {
  const text = String(atOrIso ?? '').trim()
  if (!text) return ''
  let iso = text
  let localDay = ''
  const plain = SCHEDULE_RE.exec(text)
  if (plain) {
    localDay = `${plain[1]}-${plain[2]}-${plain[3]}`
    iso = localScheduleToIso(text, fixedLocalOffsetMinutes)
    if (!iso) return ''
  } else {
    const dayMatch = /^(\d{4}-\d{2}-\d{2})/.exec(text)
    if (dayMatch) localDay = dayMatch[1]
  }
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const bj = new Date(ms + 8 * 3600_000)
  const bjDay = `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`
  const hm = `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`
  if (localDay && bjDay !== localDay) {
    return `${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${hm}`
  }
  return hm
}

async function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(fallback)
    throw err
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

/**
 * 负责持久化：
 * - publish/bundles.json：视频发布包目录、状态与回填历史
 * - publish/sync.json：Wechatsync 各平台草稿链接与状态（不混入正式 分发）
 */
export class PublishStore {
  constructor(dataDir) {
    this.dir = join(dataDir, 'publish')
    this.bundlesFile = join(this.dir, 'bundles.json')
    this.syncFile = join(this.dir, 'sync.json')
    this._queue = Promise.resolve()
  }

  _run(fn) {
    const next = this._queue.then(fn, fn)
    this._queue = next.catch(() => {})
    return next
  }

  async readBundles() {
    const data = await readJsonSafe(this.bundlesFile, { items: {} })
    return data && typeof data.items === 'object' ? data.items : {}
  }

  async getBundle(note) {
    const items = await this.readBundles()
    return items[note] || null
  }

  async saveBundle(note, patch) {
    return this._run(async () => {
      await mkdir(this.dir, { recursive: true })
      const items = await this.readBundles()
      items[note] = { ...(items[note] || {}), ...patch, note, updatedAt: new Date().toISOString() }
      await writeJsonAtomic(this.bundlesFile, { items })
      return items[note]
    })
  }

  async readSyncAll() {
    const data = await readJsonSafe(this.syncFile, { items: {} })
    return data && typeof data.items === 'object' ? data.items : {}
  }

  async getSyncRecords(note) {
    const items = await this.readSyncAll()
    return items[note] || {}
  }

  async saveSyncRecords(note, recordsByPlatform) {
    return this._run(async () => {
      await mkdir(this.dir, { recursive: true })
      const items = await this.readSyncAll()
      items[note] = { ...(items[note] || {}), ...recordsByPlatform }
      await writeJsonAtomic(this.syncFile, { items })
      return items[note]
    })
  }
}
