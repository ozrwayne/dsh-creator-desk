// 本人账号三栏（名称、平台 ID、主页链接）的平台规则：校验、ID 与链接互推、读取标识、比较。
// 只处理字符串，不联网；小红书、抖音的短链和分享文案由调用方先解析成主页链接再交给这里。
import { tr } from './i18n.js'
import { httpError } from './vault.js'

export const NAME_MAX = 60
export const HANDLE_MAX = 120
export const URL_MAX = 600

const NAME_FORBIDDEN = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\\`]/
const UNSAFE_ID = /[\s\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069|`\\]/
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

function text(value) {
  if (value == null) return ''
  if (typeof value !== 'string') throw httpError(400, '账号资料无效')
  return value.trim()
}

/** 名称：去首尾空白，可为空；拒绝换行、制表符、控制字符、双向控制符、反斜杠和反引号。 */
export function checkName(value) {
  const name = text(value)
  if (NAME_FORBIDDEN.test(name) || LONE_SURROGATE.test(name)) throw httpError(400, '名称不能有换行、制表符、反斜杠、反引号或控制字符')
  if ([...name].length > NAME_MAX) throw httpError(400, '名称最多 60 个字')
  return name
}

/** 写进表格的 ID 只要求不破坏 Markdown；平台格式由 checkFields 负责。 */
export function checkIdText(value) {
  const id = text(value)
  if (UNSAFE_ID.test(id) || LONE_SURROGATE.test(id)) throw httpError(400, '平台 ID 格式不对')
  if ([...id].length > HANDLE_MAX) throw httpError(400, '平台 ID 最多 120 个字符')
  return id
}

function cleanHandle(spec, value) {
  const id = checkIdText(text(value).replace(/^`+|`+$/g, ''))
  if (!id) return ''
  const handle = spec.handle.normalize(id)
  if (!spec.handle.pattern.test(handle) || spec.handle.reserved?.has(handle.toLowerCase())) throw httpError(400, '平台 ID 格式不对')
  return handle
}

function tryHandle(spec, value) {
  try { return cleanHandle(spec, value) } catch { return '' }
}

// 只收 http(s)；拒绝账号密码、端口和 IP。已知平台的规范链接一律是 https。
function webUrl(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > URL_MAX || /[\s\x00-\x1f\x7f-\x9f]/.test(value)) return null
  let url
  try { url = new URL(value) } catch { return null }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.port) return null
  if (/^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[')) return null
  return url
}

const among = (...hosts) => host => hosts.includes(host)
const under = domain => host => host === domain || host.endsWith(`.${domain}`)

function pick(url, host, pattern, build, reserved) {
  if (!host(url.hostname)) return null
  const id = pattern.exec(url.pathname)?.[1]
  return id && !reserved?.has(id.toLowerCase()) ? { id, url: build(id) } : null
}

// 「其他」平台：任意公开域名的 https 链接。竖线、反引号、反斜杠和括号编码后写入，表格切分和链接识别都不受影响。
function publicLink(url) {
  if (url.protocol !== 'https:') return null
  const labels = url.hostname.split('.')
  if (labels.length < 2 || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels[labels.length - 1])) return null
  if (/(?:^|\.)(?:localhost|local|internal|lan|home\.arpa)$/.test(url.hostname)) return null
  return { id: '', url: url.href.replace(/[|`\\()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`) }
}

const GITHUB_RESERVED = new Set(['about', 'account', 'apps', 'blog', 'collections', 'contact', 'customer-stories', 'dashboard', 'enterprise', 'events', 'explore', 'features', 'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'orgs', 'organizations', 'pricing', 'pulls', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'sponsors', 'topics', 'trending'])
const X_RESERVED = new Set(['i', 'home', 'search', 'explore', 'intent', 'share', 'settings', 'messages', 'notifications', 'hashtag', 'compose'])
const SUBSTACK_RESERVED = new Set(['www', 'on', 'open', 'support', 'cdn', 'api', 'email', 'reader'])

const zhihu = id => `https://www.zhihu.com/people/${id}`
const youtube = id => `https://www.youtube.com/${id.startsWith('@') ? id : `channel/${id}`}`
const linkedin = id => `https://www.linkedin.com/in/${id}`
const github = id => `https://github.com/${id}`
const substack = id => `https://${id}.substack.com`
const xhs = id => `https://www.xiaohongshu.com/user/profile/${id}`
const douyin = id => `https://www.douyin.com/user/${id}`
const toutiao = token => `https://www.toutiao.com/c/user/token/${token}/`
const xcom = id => `https://x.com/${id}`

/**
 * from：读取标识取自哪一栏（'handle' | 'link' | null）。derivable：ID 和链接可确定互推。
 * unique：平台 ID 本身就能唯一指认账号，可用来查重复。
 */
function define({ handle, link = null, from = null, derivable = false, unique = true, generic = false, asIdentifier = found => found.id, sameKind = () => true }) {
  const spec = {
    handle: { normalize: value => value, reserved: null, ...handle },
    link: null,
    identifierFrom: from,
    derivable,
    handleUnique: unique,
    generic,
  }
  if (link) {
    spec.link = {
      example: link.example,
      resolvable: Boolean(link.resolvable),
      sameKind,
      parse: raw => {
        const url = webUrl(raw)
        return url ? link.match(url) : null
      },
      fromHandle: value => {
        const clean = derivable ? tryHandle(spec, value) : ''
        return clean ? link.build(clean) : ''
      },
    }
  }
  spec.identifier = ({ handle: rawHandle, url } = {}) => {
    if (!from) return ''
    const found = spec.link?.parse(url)
    const fromLink = found?.id ? asIdentifier(found) : ''
    const clean = tryHandle(spec, rawHandle)
    if (from === 'handle') return clean || fromLink
    if (fromLink) return fromLink
    const derived = clean ? spec.link.parse(spec.link.fromHandle(clean)) : null
    return derived?.id ? asIdentifier(derived) : ''
  }
  return spec
}

const GENERIC = define({
  generic: true,
  unique: false,
  handle: { pattern: /^[\p{L}\p{N}_.@+-]+$/u, label: '账号 ID', example: '' },
  link: { example: 'https://…', match: publicLink },
})

const SPECS = new Map([
  ['公众号', define({ from: 'handle', handle: { pattern: /^gh_[A-Za-z0-9]+$/, label: '原始 ID（gh_ 开头）', example: 'gh_0123456789ab' } })],
  ['视频号', define({ from: 'handle', handle: { pattern: /^v2_[0-9A-Fa-f]+@finder$/, label: '视频号 ID（v2_ 开头）', example: 'v2_060000…@finder' } })],
  ['知乎', define({
    from: 'link',
    derivable: true,
    handle: { pattern: /^[A-Za-z0-9_-]+$/, label: '个人主页里的 ID', example: 'paperplane' },
    link: { example: zhihu('paperplane'), build: zhihu, match: url => pick(url, among('zhihu.com', 'www.zhihu.com'), /^\/people\/([A-Za-z0-9_-]+)\/?$/, zhihu) },
  })],
  ['YouTube', define({
    from: 'link',
    derivable: true,
    // @handle 和 UC 频道 ID 都指同一个频道时无法离线核对，只比较同类的值。
    sameKind: (a, b) => a.startsWith('@') === b.startsWith('@'),
    handle: {
      pattern: /^(?:@[A-Za-z0-9_.-]{1,100}|UC[A-Za-z0-9_-]{22})$/,
      normalize: value => (value.startsWith('@') || /^UC[A-Za-z0-9_-]{22}$/.test(value) ? value : `@${value}`),
      label: '@handle 或 UC 开头的频道 ID',
      example: '@paperplane',
    },
    link: {
      example: youtube('@paperplane'),
      build: youtube,
      match: url => {
        if (!among('youtube.com', 'www.youtube.com', 'm.youtube.com')(url.hostname)) return null
        const found = /^\/(?:(@[A-Za-z0-9_.-]{1,100})|channel\/(UC[A-Za-z0-9_-]{22}))(?:\/[a-z]+)?\/?$/.exec(url.pathname)
        const id = found?.[1] || found?.[2]
        return id ? { id, url: youtube(id) } : null
      },
    },
  })],
  ['LinkedIn', define({
    from: 'link',
    derivable: true,
    asIdentifier: found => found.url,
    handle: { pattern: /^[A-Za-z0-9_-]{1,100}$/, label: '主页链接里的名字', example: 'paperplane' },
    link: { example: linkedin('paperplane'), build: linkedin, match: url => pick(url, host => host === 'linkedin.com' || /^(?:www|[a-z]{2})\.linkedin\.com$/.test(host), /^\/in\/([A-Za-z0-9_-]{1,100})\/?$/, linkedin) },
  })],
  ['GitHub', define({
    from: 'link',
    derivable: true,
    handle: { pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/, reserved: GITHUB_RESERVED, label: '用户名', example: 'paperplane' },
    link: { example: github('paperplane'), build: github, match: url => pick(url, among('github.com', 'www.github.com'), /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,38})\/?$/, github, GITHUB_RESERVED) },
  })],
  ['Substack', define({
    // 「平台 ID」栏是 publication 名；substack.com/@名 是个人主页，不能推出 publication。
    from: 'handle',
    derivable: true,
    handle: { pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, normalize: value => value.toLowerCase(), reserved: SUBSTACK_RESERVED, label: 'publication 名', example: 'paperplane' },
    link: {
      example: substack('paperplane'),
      build: substack,
      match: url => {
        const publication = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.substack\.com$/.exec(url.hostname)?.[1]
        if (publication && !SUBSTACK_RESERVED.has(publication)) return { id: publication, url: substack(publication) }
        const user = among('substack.com', 'www.substack.com')(url.hostname) ? /^\/@([A-Za-z0-9_.-]{1,100})\/?$/.exec(url.pathname)?.[1] : null
        return user ? { id: '', url: `https://substack.com/@${user}` } : null
      },
    },
  })],
  ['小红书', define({
    // 小红书号是展示号，内部 ID 只取自主页链接。
    from: 'link',
    handle: { pattern: /^[A-Za-z0-9_.-]{1,32}$/, label: '小红书号', example: '12345678901' },
    link: {
      example: xhs('0123456789abcdef01234567'),
      resolvable: true,
      match: url => {
        const id = under('xiaohongshu.com')(url.hostname) ? /^\/user\/profile\/([0-9a-f]{24})\/?$/i.exec(url.pathname)?.[1]?.toLowerCase() : null
        return id ? { id, url: xhs(id) } : null
      },
    },
  })],
  ['抖音', define({
    // 抖音号是展示号，sec_uid 只取自主页链接。
    from: 'link',
    handle: { pattern: /^[A-Za-z0-9_.-]{1,32}$/, label: '抖音号', example: 'paperplane' },
    link: { example: douyin('MS4wLjABAAAA…'), resolvable: true, match: url => pick(url, host => under('douyin.com')(host) || under('iesdouyin.com')(host), /^\/(?:share\/)?user\/([A-Za-z0-9_-]{20,120})\/?$/, douyin) },
  })],
  ['今日头条', define({
    // 用户 ID 和主页 token 互相推不出；没有内容端点，读取标识为空。
    handle: { pattern: /^\d{1,20}$/, label: '用户 ID（数字）', example: '1234567890' },
    link: { example: toutiao('…'), match: url => pick(url, among('toutiao.com', 'www.toutiao.com'), /^\/c\/user\/token\/([A-Za-z0-9_=-]{8,400})\/?$/, toutiao) },
  })],
  ['X', define({
    from: 'link',
    derivable: true,
    handle: { pattern: /^[A-Za-z0-9_]{1,15}$/, normalize: value => value.replace(/^@/, ''), reserved: X_RESERVED, label: '用户名', example: 'paperplane' },
    link: { example: xcom('paperplane'), build: xcom, match: url => pick(url, among('x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'), /^\/([A-Za-z0-9_]{1,15})\/?$/, xcom, X_RESERVED) },
  })],
])

/**
 * 平台规则。没列出的平台（播客等）用通用规则；平台为空时返回 null。
 * @returns {{ handle: { pattern: RegExp, label: string, example: string, normalize: Function, reserved: Set<string>|null },
 *   link: { parse(url): {id: string, url: string}|null, fromHandle(handle): string, example: string, resolvable: boolean, sameKind: Function } | null,
 *   identifier({ handle, url }): string, identifierFrom: 'handle'|'link'|null, derivable: boolean, handleUnique: boolean, generic: boolean } | null}
 */
export function platformSpec(platform) {
  if (typeof platform !== 'string' || !platform.trim()) return null
  return SPECS.get(platform.trim()) ?? GENERIC
}

/** 详情页表单的标签和示例，标签按当前语言给出。 */
export function platformForm(platform) {
  const spec = platformSpec(platform) ?? GENERIC
  return { handleLabel: tr(spec.handle.label), handleExample: spec.handle.example, linkExample: spec.link?.example || '' }
}

/** 读取标识：传给读取端点的值；读不了的平台为空。 */
export function identifierFor({ platform, handle, url } = {}) {
  return (platformSpec(platform) ?? GENERIC).identifier({ handle, url })
}

function checkLink(spec, value) {
  const raw = text(value)
  if (!raw) return null
  if (!spec.link) throw httpError(400, '这个平台的链接栏留空')
  if (raw.length > URL_MAX) throw httpError(400, '主页链接最多 600 个字符')
  const url = webUrl(raw)
  if (!url) throw httpError(400, '主页链接无效')
  const found = spec.link.parse(raw)
  if (found) {
    if (found.url.length > URL_MAX) throw httpError(400, '主页链接最多 600 个字符')
    return found
  }
  if (spec.generic) throw httpError(400, url.protocol === 'http:' ? '主页链接要用 https' : '主页链接无效')
  throw httpError(400, '请填这个平台的账号主页链接')
}

function fold(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
}

/**
 * 清洗三栏，不合规抛 400。主页链接一律换成规范链接；ID 和链接能互推的平台只填一栏时补出另一栏，两栏对不上时报错。
 * @returns {{ displayName: string, handle: string, url: string }}
 */
export function checkFields(platform, fields) {
  if (!fields || typeof fields !== 'object') throw httpError(400, '账号资料无效')
  const spec = platformSpec(platform) ?? GENERIC
  const displayName = checkName(fields.displayName)
  let handle = cleanHandle(spec, fields.handle)
  const found = checkLink(spec, fields.url)
  let url = found?.url ?? ''
  if (spec.derivable) {
    if (handle && found?.id) {
      if (spec.link.sameKind(handle, found.id) && fold(handle) !== fold(found.id)) throw httpError(400, 'ID 和主页链接对不上')
    } else if (!handle && found?.id) {
      handle = tryHandle(spec, found.id)
    } else if (handle && !url) {
      url = spec.link.fromHandle(handle)
    }
  }
  return { displayName, handle, url }
}

/**
 * 只用于判断「是否一致」，不用于写入：NFKC、去空白；ID 和链接不分大小写，链接先换成规范链接再比。
 * @param {'displayName'|'handle'|'url'} field
 */
export function comparable(platform, field, value) {
  const spec = platformSpec(platform) ?? GENERIC
  const raw = String(value ?? '').normalize('NFKC').trim()
  if (field === 'displayName') return raw.replace(/\s+/gu, '')
  if (field === 'handle') return fold(tryHandle(spec, raw) || raw.replace(/^`+|`+$/g, ''))
  if (field === 'url') return fold(spec.link?.parse(raw)?.url || raw)
  throw new TypeError(`comparable: 不认识的栏 ${field}`)
}

export function sameField(platform, field, a, b) {
  return comparable(platform, field, a) === comparable(platform, field, b)
}

/**
 * 找同平台里已经是这个账号的另一行：读取标识相同，或平台 ID 本身唯一且相同。空值不算重复。
 * @param {Array<{id: string, platform: string, handle: string, url: string}>} rows - parseOwnSource 的行。
 * @param {{id?: string, platform: string, handle: string, url: string}} candidate - 准备写入的值，id 为它自己那一行。
 */
export function duplicateOf(rows, candidate) {
  const spec = platformSpec(candidate?.platform)
  if (!spec) return null
  const identifier = fold(spec.identifier(candidate))
  const handle = spec.handleUnique ? fold(tryHandle(spec, candidate.handle)) : ''
  if (!identifier && !handle) return null
  for (const row of rows || []) {
    if (!row || row.id === candidate.id || row.platform !== candidate.platform) continue
    if (identifier && fold(spec.identifier(row)) === identifier) return row
    if (handle && fold(tryHandle(spec, row.handle)) === handle) return row
  }
  return null
}

export function assertUnique(rows, candidate) {
  if (duplicateOf(rows, candidate)) throw httpError(409, '另一行已经是这个账号')
}
