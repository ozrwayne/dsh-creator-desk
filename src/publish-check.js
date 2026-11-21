/*
 * 视频发布包（publish.json）校验与 MP4 faststart 检查。
 *
 * Adapted from https://github.com/CzzzzzzJ/mdldm-maitian-publisher
 * (lib/bundle.js & tools/validate.mjs), licensed under Apache License 2.0.
 *
 * Modifications for dsh-media-desk:
 * - 支持注入当前时间 now 与自定义违禁词 bannedWords，便于确定性单测与按账号配置；
 * - 移除原作者私有的 NAS 默认路径与固定分区假设；
 * - 国内平台出现模型/厂商名改为提醒（warnings），不再硬阻断科技类视频导出；
 * - 增加基于文件头的零内存占用 MP4 faststart（moov 在 mdat 前）检查。
 */
import { open } from 'node:fs/promises'

export const BUNDLE_PLATFORMS = Object.freeze({
  bilibili: { name: 'B站', fields: { title: [1, 80], desc: [0, 2000] }, tags: { max: 10, each: 20 }, links: true, defaultCovers: ['4x3'] },
  xhs: { name: '小红书', fields: { title: [1, 20], body: [1, 1000] }, topics: true, links: false, defaultCovers: ['3x4'] },
  douyin: { name: '抖音', fields: { title: [1, 30], body: [0, 1000] }, topics: true, maxTopics: 5, links: false, defaultCovers: ['4x3', '3x4'] },
  channels: { name: '视频号', fields: { shortTitle: [6, 16], body: [0, 1000] }, topics: true, links: false, defaultCovers: ['3x4', '4x3'] },
  youtube: { name: 'YouTube', fields: { title: [1, 100], desc: [0, 5000] }, tags: { total: 500 }, links: true, noAngle: true, defaultCovers: ['16x9'] },
  x: { name: 'X', fields: { text: [1, 25000] }, links: true, defaultCovers: [] },
  instagram: { name: 'Instagram', fields: { caption: [1, 2200] }, links: true, maxHashtags: 30, maxSec: 1200, defaultCovers: ['3x4', '16x9'] },
})

const LEAD_RE = /知识站|课程站|文档库|飞书|主页.{0,8}(搜|看|找)|评论区.{0,8}(链接|领|拿)|点链接|戳链接/
const MODEL_RE = /Claude|Codex|ChatGPT|GPT-?\d|Gemini|Anthropic|OpenAI|DeepSeek/i

export const codepointLen = s => [...String(s || '')].length

export function xWeight(text) {
  let n = 0
  const rest = String(text || '').replace(/https?:\/\/\S+/g, () => {
    n += 23
    return ''
  })
  for (const ch of rest) {
    n += /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1
  }
  return n
}

/**
 * 校验 publish.json 内容与文件集合。
 * @param {object} b - publish.json 对象。
 * @param {{files?: Set<string>|null, now?: number, bannedWords?: string[]}} options
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateBundle(b, { files = null, now = Date.now(), bannedWords = [] } = {}) {
  const errors = []
  const warnings = []
  if (!b || typeof b !== 'object') return { errors: ['publish.json 不是有效的对象'], warnings }
  const has = p => !files || files.has(p)

  if (b.version !== 1) errors.push(`不认识的 version：${b.version}`)
  if (!b.video) errors.push('缺少 video')
  else if (!has(b.video)) errors.push(`找不到视频：${b.video}`)

  for (const [k, p] of Object.entries(b.covers || {})) {
    if (!has(p)) errors.push(`找不到封面 ${k}：${p}`)
  }

  if (b.schedule) {
    const ts = Date.parse(b.schedule)
    if (Number.isNaN(ts)) errors.push(`定时发布时间格式无效：${b.schedule}`)
    else if (ts < now + 2 * 3600_000) errors.push(`定时发布要晚于现在 2 小时以上：${b.schedule}`)
    else if (ts > now + 14 * 86_400_000) errors.push(`定时发布最多 14 天以内：${b.schedule}`)
  }

  const customBanned = (Array.isArray(bannedWords) ? bannedWords : [])
    .map(w => String(w || '').trim())
    .filter(Boolean)

  for (const [id, p] of Object.entries(b.platforms || {})) {
    const spec = BUNDLE_PLATFORMS[id]
    if (!spec) {
      warnings.push(`未知平台 ${id}，会跳过`)
      continue
    }
    const tag = spec.name
    if (!p || typeof p !== 'object') continue
    if (p.skip) {
      warnings.push(`${tag}：跳过（${p.skip}）`)
      continue
    }
    for (const c of p.covers || []) {
      if (!(b.covers || {})[c]) errors.push(`${tag}：封面 ${c} 没有在 covers 里定义`)
    }
    if (p.video && !has(p.video)) errors.push(`${tag}：找不到单独指定的视频 ${p.video}`)

    for (const [field, [min, max]] of Object.entries(spec.fields)) {
      const n = codepointLen(p[field])
      if (n < min) errors.push(`${tag}：${field} ${n ? `只有 ${n} 字，至少 ${min} 字` : '为空'}`)
      if (n > max) errors.push(`${tag}：${field} ${n} 字，超过上限 ${max}`)
    }

    const all = Object.keys(spec.fields).map(f => p[f] || '').join('\n') + ' ' + (p.topics || []).join(' ')
    if (!spec.links) {
      if (/https?:\/\/|www\.|\.(com|cn|club|net)\b/i.test(all)) errors.push(`${tag}：正文里有链接，这个平台不能放`)
      if (/(微信|vx|v信|wx)\s*[:：号]?\s*[A-Za-z][-_A-Za-z0-9]{5,}|加微/i.test(all)) errors.push(`${tag}：正文里有微信号，这个平台不能放`)
      else if (/微信/.test(all)) warnings.push(`${tag}：正文提到了「微信」，请确认不是引流`)
      const lead = all.match(LEAD_RE)
      if (lead) errors.push(`${tag}：正文含引流词「${lead[0]}」`)
      const model = all.match(MODEL_RE)
      if (model) warnings.push(`${tag}：出现了模型/厂商名「${model[0]}」，国内平台可视情况替换代称`)
    }

    for (const word of customBanned) {
      if (all.includes(word)) errors.push(`${tag}：包含自定义禁词「${word}」`)
    }

    const list = p.tags || p.topics
    if (list) {
      for (const reqTag of b.requiredTags || []) {
        if (!list.includes(reqTag)) errors.push(`${tag}：缺少必带标签「${reqTag}」`)
      }
    }
    if (spec.maxTopics && (p.topics || []).length > spec.maxTopics) {
      errors.push(`${tag}：话题 ${(p.topics || []).length} 个，最多 ${spec.maxTopics} 个`)
    }
    if (spec.noAngle && /[<>]/.test(all)) errors.push(`${tag}：标题或简介里不能有 < 或 >`)
    if (spec.tags) {
      const t = p.tags || []
      if (spec.tags.max && t.length > spec.tags.max) errors.push(`${tag}：标签 ${t.length} 个，最多 ${spec.tags.max} 个`)
      if (spec.tags.each) {
        for (const item of t) {
          if (codepointLen(item) > spec.tags.each) errors.push(`${tag}：标签「${item}」超过 ${spec.tags.each} 字`)
        }
      }
      if (spec.tags.total && t.join(',').length > spec.tags.total) errors.push(`${tag}：标签总长超过 ${spec.tags.total}`)
    }
    if (spec.maxHashtags && (all.match(/#[^\s#]+/g) || []).length > spec.maxHashtags) {
      errors.push(`${tag}：话题标签超过 ${spec.maxHashtags} 个`)
    }
    if (spec.maxSec && b.durationSec > spec.maxSec) {
      errors.push(`${tag}：视频 ${Math.round(b.durationSec / 60)} 分钟，网页上传最长 ${spec.maxSec / 60} 分钟`)
    }
    if (id === 'instagram' && /https?:\/\//.test(all)) {
      warnings.push('Instagram：配文里的链接不可点击，可改为引导看主页简介')
    }
    if (id === 'x') {
      const w = xWeight(p.text || '')
      if (w > 280) warnings.push(`X：正文计 ${w}，超过 280，需要 X Premium 才能发`)
    }
  }
  return { errors, warnings }
}

/**
 * 扫描 MP4 顶层 box 顺序，检查 moov 是否位于 mdat 之前（faststart）。
 * 只读每个 box 的 8~16 字节头，不把大视频读进内存。
 */
export async function checkMp4Faststart(filePath) {
  let fh
  try {
    fh = await open(filePath, 'r')
    const info = await fh.stat()
    const total = info.size
    if (total < 16) return { ok: false, reason: '视频文件太小或不是有效的 MP4' }
    const header = Buffer.alloc(16)
    let offset = 0
    let moovAt = -1
    let mdatAt = -1
    let seenFtyp = false
    let guard = 0
    while (offset + 8 <= total && guard < 4096) {
      guard += 1
      const { bytesRead } = await fh.read(header, 0, Math.min(16, total - offset), offset)
      if (bytesRead < 8) break
      let boxSize = header.readUInt32BE(0)
      const type = header.subarray(4, 8).toString('latin1')
      if (type === 'ftyp') seenFtyp = true
      if (type === 'moov' && moovAt < 0) moovAt = offset
      if (type === 'mdat' && mdatAt < 0) mdatAt = offset
      if (boxSize === 1) {
        if (bytesRead < 16) break
        boxSize = Number(header.readBigUInt64BE(8))
      } else if (boxSize === 0) {
        break
      }
      if (!Number.isFinite(boxSize) || boxSize < 8) break
      offset += boxSize
    }
    if (!seenFtyp && moovAt < 0 && mdatAt < 0) {
      return { ok: true, skipped: true }
    }
    if (moovAt >= 0 && mdatAt >= 0 && moovAt > mdatAt) {
      return { ok: false, reason: '视频未开启 faststart（moov 在 mdat 后面），建议导出时勾选「Web 优化 / faststart」' }
    }
    return { ok: true }
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, missing: true, reason: '还没有放入 成片.mp4' }
    return { ok: false, reason: err.message }
  } finally {
    await fh?.close().catch(() => {})
  }
}
