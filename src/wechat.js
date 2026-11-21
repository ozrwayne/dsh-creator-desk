// 把稿件正文转成可粘贴到公众号后台的 HTML。不调用模型，不改写句子。
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

export const RECOMMENDED = ['minimal', 'medium', 'stripe', 'wired', 'ft', 'course']
export const DEFAULT_STYLES = process.env.MEDIA_DESK_WECHAT_STYLES || ''

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif"
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
const DROP = new Set(['content', 'display', 'box-shadow', 'animation', 'transition', 'filter', 'transform', 'position', 'float', 'z-index', 'counter-increment', 'counter-reset', 'opacity'])
const ORDER = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'color', 'background-color', 'text-align', 'text-decoration', 'text-decoration-thickness', 'text-decoration-color', 'text-underline-offset', 'margin', 'padding', 'border', 'border-left', 'border-right', 'border-top', 'border-bottom', 'border-radius', 'max-width', 'width', 'height', 'overflow', 'white-space']
const VISIBLE = new Set(['p', 'h1', 'h2', 'h3', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'hr', 'strong'])
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr'])

const BUILTIN_RULES = {
  body: {
    'font-family': FONT,
    'font-size': '16px',
    'line-height': '1.82',
    color: '#2b2b2b',
    'max-width': '740px',
    margin: '0 auto',
    padding: '24px 22px',
    'background-color': '#ffffff',
  },
  p: { margin: '12px 0', 'font-family': FONT, 'font-size': '16px', 'line-height': '1.82', color: '#2b2b2b' },
  blockquote: {
    margin: '20px 0',
    padding: '13px 16px',
    'border-left': '3px solid #111111',
    'background-color': '#f5f5f5',
    'font-family': FONT,
    'font-size': '16px',
    'line-height': '1.82',
    'font-weight': '700',
    color: '#222222',
  },
  h1: { 'font-size': '24px', 'line-height': '1.35', 'font-weight': '800', margin: '28px 0 16px', color: '#111111' },
  h2: { 'font-size': '19px', 'line-height': '1.45', 'font-weight': '800', margin: '28px 0 12px', color: '#111111' },
  h3: { 'font-size': '17px', 'line-height': '1.5', 'font-weight': '700', margin: '22px 0 10px', color: '#222222' },
  ul: { margin: '12px 0', 'padding-left': '22px' },
  ol: { margin: '12px 0', 'padding-left': '22px' },
  li: { margin: '6px 0', 'line-height': '1.82' },
  strong: { 'font-weight': '700' },
  code: { 'font-family': MONO, 'font-size': '14px', 'background-color': '#f4f4f4', padding: '1px 4px' },
  pre: { margin: '16px 0', padding: '12px 14px', 'background-color': '#f5f5f5', 'font-family': MONO, 'font-size': '14px', 'line-height': '1.6' },
  hr: { border: 'none', 'border-top': '1px solid #111111', margin: '24px 0' },
}

function builtinMinimal() {
  return { id: 'minimal', name: '极简黑白', scene: '默认款、方法论、诊断报告', recommended: true, rules: structuredClone(BUILTIN_RULES) }
}

function solidColor(value) {
  const text = String(value || '').trim()
  if (!text || /^(none|transparent|inherit|initial|unset)$/i.test(text)) return ''
  if (/gradient|url\(|expression\(/i.test(text)) return ''
  if (/^#(?:[0-9a-f]{3,8})$/i.test(text)) return text
  if (/^(?:rgb|hsl)a?\([^)]*\)$/i.test(text)) return text
  if (/^[a-z]+$/i.test(text)) return text
  return ''
}

function parseDecls(body) {
  const out = {}
  for (const part of body.split(';')) {
    const text = part.trim()
    if (!text) continue
    const colon = text.indexOf(':')
    if (colon <= 0) continue
    const key = text.slice(0, colon).trim().toLowerCase()
    const value = text.slice(colon + 1).trim().replace(/"/g, "'")
    if (!key || !value || DROP.has(key)) continue
    if (/url\(|expression\(|javascript:/i.test(value)) continue
    if (key === 'background' || key === 'background-color') {
      const color = solidColor(value)
      if (color) out['background-color'] = color
      continue
    }
    if (value === 'inherit') continue
    out[key] = value
  }
  return out
}

function parseCss(css) {
  const rules = {}
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = re.exec(css))) {
    const selector = match[1].trim().toLowerCase()
    if (!selector || selector.includes(':') || selector.includes('.') || selector.includes('#') || selector.includes('[')) continue
    rules[selector] = { ...(rules[selector] || {}), ...parseDecls(match[2]) }
  }
  return rules
}

function sortStyles(styles) {
  const rank = id => {
    const at = RECOMMENDED.indexOf(id)
    return at < 0 ? RECOMMENDED.length : at
  }
  return [...styles].sort((a, b) => rank(a.id) - rank(b.id) || a.order - b.order)
}

export async function loadStyles(file = DEFAULT_STYLES) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return [builtinMinimal()]
    throw err
  }
  const styles = []
  const re = /^## \d+ ([a-z0-9-]+)：(.+)$/gm
  const marks = []
  let match
  while ((match = re.exec(text))) marks.push({ id: match[1], name: match[2].trim(), index: match.index, end: match.index + match[0].length })
  marks.forEach((mark, index) => {
    const slice = text.slice(mark.end, marks[index + 1]?.index ?? text.length)
    const scene = /^- 适合：(.+)$/m.exec(slice)?.[1]?.trim() || ''
    const css = /```css\r?\n([\s\S]*?)```/.exec(slice)?.[1] || ''
    const rules = parseCss(css)
    if (!rules.body) return
    styles.push({
      id: mark.id,
      name: mark.name,
      scene,
      recommended: RECOMMENDED.includes(mark.id),
      order: index,
      rules,
    })
  })
  if (!styles.length) return [builtinMinimal()]
  return sortStyles(styles).map(({ order, ...style }) => style)
}

function declString(decls) {
  const keys = Object.keys(decls).sort((a, b) => {
    const ia = ORDER.indexOf(a)
    const ib = ORDER.indexOf(b)
    if (ia < 0 && ib < 0) return a < b ? -1 : 1
    if (ia < 0) return 1
    if (ib < 0) return -1
    return ia - ib
  })
  return keys.map(key => `${key}:${decls[key]}`).join(';')
}

function prepareRules(style) {
  const rules = structuredClone(style?.rules || BUILTIN_RULES)
  if (!rules.pre) {
    rules.pre = { margin: '16px 0', padding: '14px 16px', 'background-color': '#f5f5f5', 'font-family': MONO, 'font-size': '14px', 'line-height': '1.6' }
  }
  if (!rules.ol) rules.ol = { ...(rules.ul || { margin: '12px 0', 'padding-left': '22px' }) }
  if (!rules.strong) rules.strong = { 'font-weight': '700' }
  if (!rules.code) rules.code = { 'font-family': MONO, 'font-size': '14px' }
  if (!rules.hr) rules.hr = { border: 'none', 'border-top': '1px solid #111111', margin: '24px 0' }
  return rules
}

function elementStyle(rules, tag, extra = {}) {
  const body = rules.body || {}
  const base = {}
  for (const key of ['font-family', 'font-size', 'line-height', 'color']) {
    if (body[key]) base[key] = body[key]
  }
  return declString({ ...base, ...(rules[tag] || {}), ...extra })
}

function bodyStyle(rules) {
  const body = rules.body || {}
  return declString({
    'max-width': body['max-width'] || '740px',
    margin: body.margin || '0 auto',
    padding: body.padding || '24px 22px',
    'background-color': body['background-color'] || '#ffffff',
  })
}

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function decode(text) {
  return String(text ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function tag(name, style, inner) {
  const open = `<${name} style="${esc(style)}">`
  if (name === 'hr') return `<hr style="${esc(style)}">`
  return `${open}${inner}</${name}>`
}

function codeStyle(rules, insidePre) {
  const inline = rules.code || {}
  const nested = rules['pre code'] || {}
  const pre = rules.pre || {}
  const extra = insidePre ? { ...inline, ...nested } : { ...inline }
  if (insidePre) {
    extra['background-color'] = nested['background-color'] || pre['background-color'] || 'transparent'
    extra.color = nested.color || pre.color || extra.color
    extra.padding = nested.padding || '0'
    if (!extra['font-family']) extra['font-family'] = pre['font-family'] || inline['font-family'] || MONO
    extra['white-space'] = 'pre-wrap'
  }
  return elementStyle(rules, 'code', extra)
}

function imageDesc(alt, fallback) {
  const text = String(alt || '').trim()
  if (text) return text
  const name = String(fallback || '').split(/[/\\]/).pop()?.trim()
  return name || '图片'
}

function linkDest(raw) {
  const text = String(raw || '').trim()
  if (text.startsWith('<')) {
    const end = text.indexOf('>')
    if (end > 1) return text.slice(1, end)
  }
  return text.split(/\s+/)[0] || ''
}

function resolveSyncSrc(rawRef, ctx) {
  const ref = linkDest(rawRef)
  if (!ref) return ''
  if (/^(?:https?:\/\/|data:image\/)/i.test(ref)) return ref
  return ctx.resolveImage?.(ref) || ''
}

function renderSyncImg(src, alt) {
  return `<img src="${esc(src)}" alt="${esc(alt)}" style="max-width:100%;height:auto;display:block;margin:14px auto;border-radius:4px">`
}

function renderRich(src, ctx, allowLink = true) {
  let html = ''
  let i = 0
  const patterns = [
    { type: 'obs', re: /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g },
    { type: 'img', re: /!\[([^\]]*)\]\(([^)]*)\)/g },
    { type: 'link', re: /\[([^\]]+)\]\(([^)]+)\)/g },
    { type: 'wiki', re: /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g },
    { type: 'bold', re: /\*\*(.+?)\*\*/g },
  ]
  while (i < src.length) {
    let best = null
    for (const pattern of patterns) {
      if (pattern.type === 'link' && !allowLink) continue
      pattern.re.lastIndex = i
      const found = pattern.re.exec(src)
      if (!found) continue
      if (!best || found.index < best.index) best = { type: pattern.type, index: found.index, match: found }
    }
    if (!best) {
      html += esc(src.slice(i))
      break
    }
    if (best.index > i) html += esc(src.slice(i, best.index))
    const m = best.match
    if (best.type === 'obs') {
      const desc = imageDesc(m[2], m[1])
      const imgSrc = ctx.mode === 'sync' ? resolveSyncSrc(m[1], ctx) : ''
      if (imgSrc) html += renderSyncImg(imgSrc, desc)
      else {
        if (ctx.mode === 'sync') ctx.warnings.push(`未找到图片：${m[1]}`)
        html += esc(`[图片：${desc}]`)
      }
    } else if (best.type === 'img') {
      const desc = imageDesc(m[1], m[2])
      const imgSrc = ctx.mode === 'sync' ? resolveSyncSrc(m[2], ctx) : ''
      if (imgSrc) html += renderSyncImg(imgSrc, desc)
      else {
        if (ctx.mode === 'sync') ctx.warnings.push(`未找到图片：${m[2]}`)
        html += esc(`[图片：${desc}]`)
      }
    } else if (best.type === 'wiki') {
      html += esc((m[2] || m[1]).trim())
    } else if (best.type === 'bold') {
      html += tag('strong', elementStyle(ctx.rules, 'strong'), renderRich(m[1], ctx, allowLink))
    } else {
      const url = linkDest(m[2])
      const inner = renderRich(m[1], ctx, false)
      const label = decode(inner.replace(/<[^>]+>/g, '')).trim() || url
      if (ctx.mode === 'sync' && /^https?:\/\//i.test(url)) {
        html += `<a href="${esc(url)}" style="color:#576b95;text-decoration:underline">${inner}</a>`
      } else {
        if (url && ctx.mode !== 'sync') ctx.links.push({ text: label, url })
        html += inner
      }
    }
    i = m.index + m[0].length
  }
  return html
}

function splitCode(src) {
  const parts = []
  const re = /`([^`\n]+)`/g
  let last = 0
  let match
  while ((match = re.exec(src))) {
    if (match.index > last) parts.push({ text: src.slice(last, match.index) })
    parts.push({ code: match[1] })
    last = match.index + match[0].length
  }
  if (last < src.length) parts.push({ text: src.slice(last) })
  return parts
}

function renderInline(src, ctx, insidePre = false) {
  if (insidePre) return tag('code', codeStyle(ctx.rules, true), esc(src))
  return splitCode(src).map(part => (
    part.code
      ? tag('code', codeStyle(ctx.rules, false), esc(part.code))
      : renderRich(part.text, ctx)
  )).join('')
}

function textOf(html) {
  return decode(String(html).replace(/<[^>]+>/g, ''))
}

function insideCode(html, index) {
  const before = html.slice(0, index)
  const opens = before.match(/<code\b/g)?.length || 0
  const closes = before.match(/<\/code>/g)?.length || 0
  return opens > closes
}

function stripTrailingPeriods(html) {
  let out = html
  for (;;) {
    if (!textOf(out).endsWith('。')) return out
    const at = out.lastIndexOf('。')
    if (at < 0 || insideCode(out, at)) return out
    out = out.slice(0, at) + out.slice(at + 1)
  }
}

function paragraphHtml(text, ctx, name, { period = true } = {}) {
  const rendered = renderInline(text, ctx)
  const html = period ? stripTrailingPeriods(rendered) : rendered
  if (!textOf(html).trim() && !/<img\b/i.test(html)) return ''
  return tag(name, elementStyle(ctx.rules, name), html)
}

function splitImages(text) {
  const re = /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|!\[([^\]]*)\]\(([^)]*)\)/g
  const parts = []
  let last = 0
  let match
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) })
    if (match[1] != null) parts.push({ image: imageDesc(match[2], match[1]), rawRef: match[1] })
    else parts.push({ image: imageDesc(match[3], match[4]), rawRef: match[4] })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts.length ? parts : [{ text }]
}

function emitTextBlock(text, ctx, name) {
  const out = []
  for (const part of splitImages(text)) {
    if (part.image) {
      if (ctx.mode === 'sync') {
        const imgSrc = resolveSyncSrc(part.rawRef, ctx)
        if (imgSrc) {
          out.push(tag('p', elementStyle(ctx.rules, 'p', { 'text-align': 'center' }), renderSyncImg(imgSrc, part.image)))
          continue
        }
        ctx.warnings.push(`未找到图片：${part.rawRef}`)
      }
      out.push(tag('p', elementStyle(ctx.rules, 'p'), esc(`[图片：${part.image}]`)))
      continue
    }
    const cleaned = part.text.trim()
    if (!cleaned) continue
    const html = paragraphHtml(cleaned, ctx, name)
    if (html) out.push(html)
  }
  return out
}

function isFence(line) { return /^(```|~~~)/.test(line) }
function isHr(line) { return /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) }
function isHeading(line) { return /^#{1,6}[ \t]+\S/.test(line) }
function isQuote(line) { return /^>[ \t]?/.test(line) }
function isUl(line) { return /^[ \t]*[-*+][ \t]+\S/.test(line) }
function isOl(line) { return /^[ \t]*\d+[.)][ \t]+\S/.test(line) }
function isTableSep(line) { return /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/.test(line) }
function isTableRow(line) { return line.includes('|') && !isTableSep(line) }
function isBlockStart(line) {
  return isFence(line) || isHr(line) || isHeading(line) || isQuote(line) || isUl(line) || isOl(line)
}

function splitCells(line) {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map(cell => cell.trim()).filter(Boolean)
}

function joinSoft(lines) {
  return lines.map((line, index) => (
    index < lines.length - 1 ? line.replace(/\\$/, '').replace(/[ \t]+$/, '') : line
  )).join(' ').trim()
}

function parseBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }
    if (isFence(line)) {
      const marker = line.startsWith('~~~') ? '~~~' : '```'
      const buf = []
      i += 1
      while (i < lines.length && !lines[i].startsWith(marker)) {
        buf.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ type: 'code', text: buf.join('\n') })
      continue
    }
    if (isHr(line)) { blocks.push({ type: 'hr' }); i += 1; continue }
    if (isHeading(line)) {
      const match = /^(#{1,6})[ \t]+(.*)$/.exec(line)
      blocks.push({ type: 'heading', level: match[1].length, text: match[2].trim() })
      i += 1
      continue
    }
    if (isQuote(line)) {
      const buf = []
      while (i < lines.length && isQuote(lines[i])) {
        buf.push(lines[i].replace(/^>[ \t]?/, ''))
        i += 1
      }
      blocks.push({ type: 'quote', text: joinSoft(buf) })
      continue
    }
    if (isTableRow(line) && isTableSep(lines[i + 1] || '')) {
      const rows = [splitCells(line)]
      i += 2
      while (i < lines.length && lines[i].trim() && isTableRow(lines[i])) {
        rows.push(splitCells(lines[i]))
        i += 1
      }
      blocks.push({ type: 'table', rows })
      continue
    }
    if (isUl(line) || isOl(line)) {
      const kind = isUl(line) ? 'ul' : 'ol'
      const items = []
      while (i < lines.length) {
        const current = lines[i]
        if (kind === 'ul' && isUl(current)) { items.push(current.replace(/^[ \t]*[-*+][ \t]+/, '')); i += 1; continue }
        if (kind === 'ol' && isOl(current)) { items.push(current.replace(/^[ \t]*\d+[.)][ \t]+/, '')); i += 1; continue }
        if (items.length && current.trim() && /^[ \t]+\S/.test(current) && !isBlockStart(current)) {
          items[items.length - 1] += ` ${current.trim()}`
          i += 1
          continue
        }
        break
      }
      blocks.push({ type: kind, items })
      continue
    }
    const buf = [line]
    i += 1
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !(isTableRow(lines[i]) && isTableSep(lines[i + 1] || ''))) {
      buf.push(lines[i])
      i += 1
    }
    blocks.push({ type: 'p', text: joinSoft(buf) })
  }
  return blocks
}

function headingPlain(text) {
  return text
    .replace(/!\[\[[^\]|]+(?:\|([^\]]*))?\]\]/g, (_, alt) => alt || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, note, alias) => (alias || note).trim())
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim()
}

export function toWechatHtml(markdown, style, options = {}) {
  const rules = prepareRules(style)
  const warnings = Array.isArray(options.warnings) ? options.warnings : []
  const ctx = { rules, links: [], mode: options.mode || 'paste', resolveImage: options.resolveImage, warnings }
  const blocks = parseBlocks(markdown)
  let title = ''
  let usedH1 = false
  const parts = []
  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 1 && !usedH1) {
      title = headingPlain(block.text)
      usedH1 = true
      continue
    }
    if (block.type === 'heading') {
      if (block.level > 3) {
        parts.push(...emitTextBlock(`${'#'.repeat(block.level)} ${block.text}`, ctx, 'p'))
        continue
      }
      const level = block.level === 1 ? 'h2' : (block.level === 2 ? 'h2' : 'h3')
      const html = paragraphHtml(block.text, ctx, level, { period: false })
      if (html) parts.push(html)
      continue
    }
    if (block.type === 'hr') {
      parts.push(tag('hr', elementStyle(rules, 'hr')))
      continue
    }
    if (block.type === 'code') {
      const pre = elementStyle(rules, 'pre', { 'white-space': 'pre-wrap' })
      parts.push(tag('pre', pre, renderInline(block.text, ctx, true)))
      continue
    }
    if (block.type === 'quote') {
      parts.push(...emitTextBlock(block.text, ctx, 'blockquote'))
      continue
    }
    if (block.type === 'ul' || block.type === 'ol') {
      const items = block.items.map(item => {
        const html = stripTrailingPeriods(renderInline(item, ctx))
        if (!textOf(html).trim() && !/<img\b/i.test(html)) return ''
        return tag('li', elementStyle(rules, 'li'), html)
      }).filter(Boolean)
      if (items.length) parts.push(tag(block.type, elementStyle(rules, block.type), items.join('')))
      continue
    }
    if (block.type === 'table') {
      const items = block.rows.map(row => {
        const cells = row.map(cell => textOf(stripTrailingPeriods(renderInline(cell, ctx))).trim()).filter(Boolean)
        if (!cells.length) return ''
        return tag('li', elementStyle(rules, 'li'), esc(cells.join(' · ')))
      }).filter(Boolean)
      if (items.length) parts.push(tag('ul', elementStyle(rules, 'ul'), items.join('')))
      continue
    }
    parts.push(...emitTextBlock(block.text, ctx, 'p'))
  }
  if (ctx.links.length) {
    const items = ctx.links.map(link => tag('li', elementStyle(rules, 'li'), `${esc(link.text)} ${esc(link.url)}`))
    parts.push(tag('p', elementStyle(rules, 'p'), esc('链接')))
    parts.push(tag('ul', elementStyle(rules, 'ul'), items.join('')))
  }
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${esc(title)}</title>`,
    '</head>',
    `<body style="${esc(bodyStyle(rules))}">`,
    parts.map(part => `  ${part}`).join('\n'),
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function bodyInner(html) {
  const match = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)
  return match ? match[1] : html
}

function titleText(html) {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html)
  return match ? decode(match[1]).trim() : ''
}

function validateStructure(html) {
  const problems = []
  const stack = []
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\s*(\/)?>/g
  let match
  while ((match = re.exec(html))) {
    if (match[0].startsWith('<!--') || match[0].startsWith('<!')) continue
    if (match[1]) {
      const name = match[1].toLowerCase()
      const open = stack.pop()
      if (open !== name) problems.push(`标签不配对：${name}`)
      continue
    }
    const name = match[2].toLowerCase()
    if (match[4] || VOID.has(name)) continue
    stack.push(name)
  }
  if (stack.length) problems.push('有未闭合的标签')
  return problems
}

export function checkWechatHtml(html) {
  const problems = []
  const src = String(html ?? '')
  if (/<style[\s>]/i.test(src)) problems.push('包含 style 标签')
  if (/(?:^|[\s<])class\s*=/i.test(src)) problems.push('包含 class')
  if (/(?:^|[\s<])id\s*=/i.test(src)) problems.push('包含 id')
  if (/:before|:after/i.test(src)) problems.push('包含伪元素')
  if (/<script[\s>]/i.test(src)) problems.push('包含脚本')
  if (/@import/i.test(src)) problems.push('包含 @import')
  if (/\b(?:src|href)\s*=\s*['"]?\s*(?:https?:)?\/\//i.test(src) || /url\s*\(/i.test(src)) problems.push('包含外部 URL')
  const styles = [...src.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map(item => item[1])
  if (styles.some(value => /https?:\/\/|url\s*\(/i.test(value))) problems.push('样式里有外部 URL')
  const inner = bodyInner(src).trim()
  if (/^<(?:div|section|article)\b/i.test(inner) && /<\/(?:div|section|article)>\s*$/i.test(inner)) {
    problems.push('正文包在最外层容器里')
  }
  const body = bodyInner(src)
  const tags = [...body.matchAll(/<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\s*(\/)?>/g)]
  for (const found of tags) {
    const name = found[1].toLowerCase()
    if (!VISIBLE.has(name)) continue
    const attrs = found[2] || ''
    if (!/\sstyle\s*=\s*"[^"]+"/i.test(` ${attrs}`)) problems.push(`${name} 缺少 style`)
    if (name === 'p') {
      const style = /\sstyle\s*=\s*"([^"]*)"/i.exec(` ${attrs}`)?.[1] || ''
      for (const key of ['font-size', 'line-height', 'color']) {
        if (!style.includes(`${key}:`)) problems.push(`段落缺少 ${key}`)
      }
    }
  }
  problems.push(...validateStructure(src))
  const title = titleText(src)
  if (/<h1[\s>]/i.test(body)) problems.push('正文含有 h1')
  if (title && textOf(body).includes(title)) problems.push('正文重复了标题')
  return [...new Set(problems)]
}

const execFileAsync = promisify(execFile)
const SYNC_IMAGE_MIMES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
})
const SKIP_WALK_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.claude'])
const MAX_DIRECT_IMAGE_BYTES = 2.5 * 1024 * 1024
const MAX_FALLBACK_IMAGE_BYTES = 12 * 1024 * 1024

function isInsideRoot(realRoot, realTarget) {
  return realTarget === realRoot || realTarget.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)
}

async function verifyLocalImage(candidate, allowedRoots) {
  if (!candidate || !allowedRoots.length) return null
  const ext = extname(candidate).toLowerCase()
  if (!SYNC_IMAGE_MIMES[ext]) return null
  try {
    const real = await realpath(candidate)
    if (!allowedRoots.some(root => isInsideRoot(root, real))) return null
    const info = await stat(real)
    return info.isFile() ? real : null
  } catch {
    return null
  }
}

async function buildImageNameIndex(allowedRoots) {
  const byName = new Map()
  async function walk(root, dir, depth) {
    if (depth > 8) return
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_WALK_DIRS.has(entry.name)) await walk(root, full, depth + 1)
        continue
      }
      const ext = extname(entry.name).toLowerCase()
      if (!SYNC_IMAGE_MIMES[ext]) continue
      const real = await verifyLocalImage(full, allowedRoots)
      if (!real) continue
      const key = entry.name.toLowerCase()
      const relLen = relative(root, full).length
      const list = byName.get(key) || []
      list.push({ real, relLen })
      byName.set(key, list)
    }
  }
  for (const root of allowedRoots) {
    await walk(root, root, 0)
  }
  return byName
}

function collectMarkdownImageRefs(markdown) {
  const refs = []
  const scanText = (text) => {
    const re = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(([^)]*)\)/g
    let m
    while ((m = re.exec(text))) {
      const ref = linkDest(m[1] != null ? m[1] : m[2])
      if (ref) refs.push(ref)
    }
  }
  for (const block of parseBlocks(markdown)) {
    if (block.type === 'code' || block.type === 'hr') continue
    if (block.type === 'ul' || block.type === 'ol') {
      for (const item of block.items) scanText(item)
    } else if (block.type === 'table') {
      for (const row of block.rows) for (const cell of row) scanText(cell)
    } else if (block.text) {
      scanText(block.text)
    }
  }
  return refs
}

async function fileToDataUri(realFile, getTempDir, warnings) {
  const ext = extname(realFile).toLowerCase()
  const mime = SYNC_IMAGE_MIMES[ext]
  if (!mime) return ''
  const info = await stat(realFile)
  if (ext !== '.webp' && info.size <= MAX_DIRECT_IMAGE_BYTES) {
    const buf = await readFile(realFile)
    return `data:${mime};base64,${buf.toString('base64')}`
  }
  if (process.platform === 'darwin') {
    try {
      const dir = await getTempDir()
      const outFile = join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`)
      await execFileAsync('/usr/bin/sips', ['-Z', '2000', '-s', 'format', 'jpeg', realFile, '--out', outFile], { timeout: 10_000 })
      const compressed = await readFile(outFile)
      if (compressed.length > 0) {
        return `data:image/jpeg;base64,${compressed.toString('base64')}`
      }
    } catch {
      // 测试合成文件或无 sips 时回退原图读取
    }
  }
  if (info.size <= MAX_FALLBACK_IMAGE_BYTES) {
    const buf = await readFile(realFile)
    return `data:${mime};base64,${buf.toString('base64')}`
  }
  warnings.push(`图片过大无法内嵌：${basename(realFile)}`)
  return ''
}

async function findSyncCoverFile(piece, allowedRoots) {
  if (!piece?.file || !piece.file.endsWith('.md')) return null
  const assetsDir = `${piece.file.slice(0, -3)}-assets`
  let entries = []
  try {
    entries = await readdir(assetsDir, { withFileTypes: true })
  } catch {
    return null
  }
  const names = entries
    .filter(e => e.isFile() && SYNC_IMAGE_MIMES[extname(e.name).toLowerCase()])
    .map(e => e.name)
  const picked = names.find(n => /^(cover|video-cover|封面)/i.test(n)) || null
  if (!picked) return null
  return verifyLocalImage(join(assetsDir, picked), allowedRoots)
}

/**
 * 为 Wechatsync 生成带内联样式 HTML 与内嵌 data URI 图片的文章载荷。
 * 不传 markdown，保留公众号排版样式，同时用 realpath 限制只读取库内合法图片。
 */
export async function prepareSyncArticle(piece, style, { vaultRoot = '' } = {}) {
  const warnings = []
  const allowedRoots = []
  if (vaultRoot) {
    const realVault = await realpath(vaultRoot).catch(() => null)
    if (realVault) allowedRoots.push(realVault)
    if (basename(vaultRoot) === '知识库') {
      const realSibling = await realpath(join(dirname(vaultRoot), '素材')).catch(() => null)
      if (realSibling && !allowedRoots.includes(realSibling)) allowedRoots.push(realSibling)
    }
  }

  let tempDir = null
  const getTempDir = async () => {
    if (!tempDir) tempDir = await mkdtemp(join(tmpdir(), 'md-wxsync-'))
    return tempDir
  }

  try {
    const refs = collectMarkdownImageRefs(piece?.body || '')
    const resolvedMap = new Map()
    const fileUriCache = new Map()
    let nameIndex = null
    let firstBodyImage = ''

    const resolveOne = async (ref) => {
      if (/^(?:https?:\/\/|data:image\/)/i.test(ref)) {
        if (!firstBodyImage) firstBodyImage = ref
        return ref
      }
      if (resolvedMap.has(ref)) return resolvedMap.get(ref)

      let clean = ref.replace(/^\.?\//, '')
      try { clean = decodeURIComponent(clean) } catch { /* 保留原串 */ }
      clean = clean.replace(/^\.?\//, '').trim()
      if (!clean || isAbsolute(clean)) {
        resolvedMap.set(ref, '')
        return ''
      }

      const candidates = []
      if (piece?.file) {
        candidates.push(resolve(dirname(piece.file), clean))
        if (piece.file.endsWith('.md')) {
          const assetsDir = `${piece.file.slice(0, -3)}-assets`
          candidates.push(resolve(assetsDir, clean))
          candidates.push(resolve(assetsDir, basename(clean)))
        }
      }
      if (vaultRoot) {
        candidates.push(resolve(vaultRoot, clean))
        if (basename(vaultRoot) === '知识库' && clean.startsWith('素材/')) {
          candidates.push(resolve(dirname(vaultRoot), clean))
        }
      }
      for (const root of allowedRoots) {
        candidates.push(resolve(root, clean))
      }

      let realHit = null
      for (const cand of candidates) {
        realHit = await verifyLocalImage(cand, allowedRoots)
        if (realHit) break
      }

      if (!realHit && allowedRoots.length) {
        if (!nameIndex) nameIndex = await buildImageNameIndex(allowedRoots)
        const hits = nameIndex.get(basename(clean).toLowerCase()) || []
        if (hits.length) {
          realHit = [...hits].sort((a, b) => a.relLen - b.relLen)[0].real
        }
      }

      if (!realHit) {
        resolvedMap.set(ref, '')
        return ''
      }

      let dataUri = fileUriCache.get(realHit)
      if (dataUri === undefined) {
        dataUri = await fileToDataUri(realHit, getTempDir, warnings)
        fileUriCache.set(realHit, dataUri)
      }
      resolvedMap.set(ref, dataUri)
      if (dataUri && !firstBodyImage) firstBodyImage = dataUri
      return dataUri
    }

    for (const ref of refs) {
      await resolveOne(ref)
    }

    let cover = ''
    const coverFile = await findSyncCoverFile(piece, allowedRoots)
    if (coverFile) {
      cover = fileUriCache.get(coverFile) ?? await fileToDataUri(coverFile, getTempDir, warnings)
    }
    if (!cover && firstBodyImage) {
      cover = firstBodyImage
    }

    const fullHtml = toWechatHtml(piece?.body || '', style, {
      mode: 'sync',
      resolveImage: raw => resolvedMap.get(linkDest(raw)) || '',
      warnings,
    })
    const title = titleText(fullHtml) || String(piece?.title || piece?.note || '').trim()
    const content = bodyInner(fullHtml).trim()
    return {
      title,
      content,
      ...(cover ? { cover } : {}),
      warnings: [...new Set(warnings)],
    }
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
