import { OWN_ENDPOINTS, monidArgs } from './own-monid.js'
import { platformSpec } from './own-platforms.js'
import { countValue, errorOf, METRICS, publishedTime } from './monitor-model.js'

// These are field contracts, not a promise that every public profile exposes a count.
// 2026-11-16 inspect documents Channels fans_count; its public zero can be withheld.
const FOLLOWER_PLATFORMS = new Set(['视频号', '知乎', 'GitHub', '小红书', '抖音'])
export const PLATFORM_COVERAGE = [
  ...['X', '公众号', '视频号', '知乎', 'YouTube', 'Substack', 'LinkedIn', 'GitHub', '小红书', '抖音'].map(platform => ({
    platform, tier: 'A', posts: true, profile: Boolean(OWN_ENDPOINTS[platform]?.profile), followers: FOLLOWER_PLATFORMS.has(platform),
    reason: platform === 'X' ? 'Grok 公共帖子；粉丝端点未启用' : platform === '公众号' ? '文章端点可用；公开资料无已验证粉丝字段' : '复用登记端点，执行前核价、校验输入与响应身份',
  })),
  { platform: '今日头条', tier: 'C', posts: false, profile: true, followers: false, reason: '仅账号资料端点；内容列表与粉丝字段未验证' },
  ...['B站', 'TikTok', 'Instagram'].map(platform => ({ platform, tier: 'B', posts: false, profile: false, followers: false, reason: '旧导入器存在，监控身份与输出尚未验证，不发请求' })),
  { platform: '播客', tier: 'D', posts: false, profile: false, followers: false, reason: '缺少统一且已验证的数据源' },
]

const LIST_PATHS = {
  公众号: ['data.articles', 'articles'], 视频号: ['data.videos', 'videos'],
  知乎: ['data.data', 'data', ''], YouTube: ['videos_results', 'data.videos_results'],
  Substack: ['posts', 'data.posts'], LinkedIn: [''], GitHub: ['data.repos', 'repos'],
  小红书: ['data.data.notes', 'data.notes', 'notes'], 抖音: ['aweme_list', 'data.aweme_list'], X: [''],
}
const METRIC_FIELDS = {
  公众号: { views: ['read_count', 'view_count'], likes: ['like_count'], comments: ['comment_count'], saves: ['fav_count'], shares: ['share_count', 'forward_count'] },
  视频号: { views: ['read_count'], likes: ['like_count'], comments: ['comment_count'], saves: ['fav_count'], shares: ['forward_count'] },
  知乎: { views: ['read_count', 'view_count'], likes: ['voteup_count'], comments: ['comment_count'], saves: ['fav_count'], shares: ['share_count'] },
  YouTube: { views: ['extracted_views', 'views', 'view_count'] },
  Substack: { likes: ['reaction_count'], comments: ['comment_count'] },
  LinkedIn: { views: ['engagement.views'], likes: ['engagement.likes'], comments: ['engagement.comments'], shares: ['engagement.shares'] },
  GitHub: { stars: ['stars'], forks: ['forks'] },
  小红书: { views: ['view_count'], likes: ['likes', 'like_count'], comments: ['comments_count', 'comment_count'], saves: ['collected_count', 'collect_count'], shares: ['share_count'] },
  抖音: { views: ['statistics.play_count'], likes: ['statistics.digg_count'], comments: ['statistics.comment_count'], saves: ['statistics.collect_count'], shares: ['statistics.share_count'] },
  X: { views: ['views'], likes: ['likes'], comments: ['replies'], saves: ['bookmarks'], shares: ['reposts'], quotes: ['quotes'] },
}
const TIME_FIELDS = {
  公众号: ['create_time'], 视频号: ['create_time'], 知乎: ['created', 'created_time', 'published_at'],
  YouTube: ['published_at', 'published_date'], Substack: ['published_at'], LinkedIn: ['postedAt.date', 'postedAt.timestamp'],
  GitHub: ['createdUtc', 'createdAt', 'created_at'], 小红书: ['create_time'], 抖音: ['create_time'], X: ['createdAt'],
}
const object = value => value != null && typeof value === 'object' && !Array.isArray(value)
const has = (value, key) => object(value) && Object.hasOwn(value, key)
const atPath = (value, path) => path ? path.split('.').reduce((node, key) => has(node, key) ? node[key] : undefined, value) : value
const pickField = (value, paths) => {
  const path = paths.find(path => atPath(value, path) != null) ?? paths.find(path => atPath(value, path) !== undefined)
  return { field: path ?? null, raw: path == null ? null : atPath(value, path) }
}
const schemaError = () => errorOf(502, '平台返回的内容格式无法识别', 'schema_unknown')
const mismatch = () => errorOf(409, '返回内容的作者与账号绑定不一致', 'identity_mismatch')
const unsafeText = /[\s\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\\`|]/

export function collectorSpec(platform, purpose = 'posts') {
  if (!['posts', 'followers'].includes(purpose)) return null
  if (purpose === 'followers' && !FOLLOWER_PLATFORMS.has(platform)) return null
  if (platform === 'X') return { collectorId: 'grok.x.posts.v1', channel: 'grok', measurementSet: 'x.public-counts.v1', cost: null }
  const spec = OWN_ENDPOINTS[platform]?.[purpose === 'followers' ? 'profile' : 'posts']
  return spec ? { ...spec, collectorId: `monid.${platform}.${purpose}.v1`, channel: 'monid', measurementSet: `${platform}.public-counts.v1` } : null
}

function identifierOf(platform, value) {
  if (typeof value !== 'string' || !value || value.length > 600 || unsafeText.test(value)) throw errorOf(409, '先补齐可验证的账号 ID 或主页链接', 'identity_missing')
  if (platform === '小红书') {
    if (/^[0-9a-f]{24}$/i.test(value)) return value.toLowerCase()
  } else if (platform === '抖音') {
    if (/^[A-Za-z0-9_-]{20,120}$/.test(value)) return value
  } else if (platform === 'LinkedIn') {
    const found = platformSpec(platform).link.parse(value)
    if (found) return found.url
  } else {
    const spec = platformSpec(platform)
    const normalized = spec?.handle.normalize(value)
    if (normalized && spec.handle.pattern.test(normalized) && !spec.handle.reserved?.has(normalized.toLowerCase())) return normalized
  }
  throw errorOf(400, '账号采集标识格式无效', 'invalid_identity')
}

function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 4000 || /[\u0000-\u0020\\]/.test(value)) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null
    const host = url.hostname.toLowerCase()
    if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || /^[\d.]+$/.test(host) || host.includes(':')) return null
    return url.toString()
  } catch { return null }
}

function sameIdentity(platform, left, right) {
  const fold = value => ['X', 'GitHub', '知乎', 'Substack', 'LinkedIn', '小红书'].includes(platform) || (platform === 'YouTube' && value.startsWith('@')) ? value.toLowerCase() : value
  return fold(left) === fold(right)
}

function identityFields(platform, node) {
  const paths = {
    公众号: ['biz_username', 'username', 'user_name', 'author.username'],
    视频号: ['username', 'user_name', 'author.username'],
    知乎: ['url_token', 'user_url_token', 'author.url_token'],
    X: ['handle', 'author.screen_name', 'author.username'],
    LinkedIn: ['author.publicIdentifier', 'author.linkedinUrl'],
    小红书: ['user_id', 'userid', 'user.user_id', 'user.userid', 'user.id', 'author.user_id'],
    抖音: ['sec_uid', 'sec_user_id', 'author.sec_uid', 'author.sec_user_id'],
    GitHub: ['login', 'handle', 'owner.login'],
    Substack: ['publication.subdomain'],
  }[platform] || []
  const entries = paths.filter(path => atPath(node, path) != null).map(path => atPath(node, path))
  if (platform === 'GitHub') {
    if (typeof node?.owner === 'string') entries.push(node.owner)
    if (typeof node?.fullName === 'string') entries.push(node.fullName.split('/')[0])
    const url = publicUrl(node?.url ?? node?.profileUrl)
    if (url && new URL(url).hostname === 'github.com') entries.push(new URL(url).pathname.split('/')[1])
  }
  if (platform === 'Substack') {
    if (typeof node?.publication === 'string') entries.push(node.publication)
    const url = publicUrl(node?.url)
    const host = url && new URL(url).hostname
    if (host?.endsWith('.substack.com')) entries.push(host.slice(0, -13))
  }
  if (platform === 'X' && node?.url != null) {
    const url = publicUrl(node.url), parsed = url && new URL(url)
    const match = parsed && /^(?:www\.)?(?:x\.com|twitter\.com)$/.test(parsed.hostname) && /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/.exec(parsed.pathname)
    if (!match) throw schemaError()
    if (node.id != null && String(node.id) !== match[2]) throw mismatch()
    entries.push(match[1])
  }
  return entries
}

function checkIdentity(platform, node, identifier) {
  const entries = identityFields(platform, node)
  for (let value of entries) {
    if (typeof value !== 'string' || !value || unsafeText.test(value)) throw schemaError()
    if (platform === 'LinkedIn') {
      if (/^https?:/.test(value)) {
        const found = platformSpec(platform).link.parse(value)
        if (!found) throw mismatch()
        value = found.url
      } else value = platformSpec(platform).link.fromHandle(value)
    }
    if (platform === 'X') value = value.replace(/^@/, '')
    if (!sameIdentity(platform, value, identifier)) throw mismatch()
  }
  return entries.length > 0
}

function youtubeIdentities(node) {
  const found = []
  for (const [path, kind] of [['channel_id', 'id'], ['handle', 'handle'], ['channel.channel_id', 'id'], ['channel.handle', 'handle']]) {
    const value = atPath(node, path)
    if (value != null) {
      if (typeof value !== 'string') throw schemaError()
      found.push([kind, kind === 'handle' ? value.replace(/^@/, '').toLowerCase() : value])
    }
  }
  for (const path of ['link', 'channel.link']) {
    const value = atPath(node, path), parsed = value && platformSpec('YouTube').link.parse(value)
    if (parsed) found.push([parsed.id.startsWith('@') ? 'handle' : 'id', parsed.id.startsWith('@') ? parsed.id.slice(1).toLowerCase() : parsed.id])
  }
  return found
}

function bindingFor(platform, output, identifier) {
  const nodes = [output, output?.data, output?.data?.data].filter(object)
  if (platform === 'YouTube') {
    const expected = new Map([[identifier.startsWith('@') ? 'handle' : 'id', identifier.startsWith('@') ? identifier.slice(1).toLowerCase() : identifier]])
    const found = nodes.flatMap(node => youtubeIdentities(node.channel_results))
    const matched = found.some(([kind, value]) => expected.get(kind) === value)
    if (found.length && !matched) throw mismatch()
    for (const [kind, value] of found) {
      if (expected.has(kind) && expected.get(kind) !== value) throw mismatch()
      expected.set(kind, value)
    }
    return raw => {
      const rowIds = youtubeIdentities(raw)
      for (const [kind, value] of rowIds) if (!expected.has(kind) || expected.get(kind) !== value) throw mismatch()
      return matched || rowIds.length ? 'response' : 'request_bound'
    }
  }
  let envelopeMatched = false
  for (const node of nodes) envelopeMatched = checkIdentity(platform, node, identifier) || envelopeMatched
  return raw => {
    const matched = checkIdentity(platform, raw, identifier)
    // An exposed opaque user ID without a comparable account identity cannot certify ownership.
    const opaque = platform === '抖音' ? raw.author?.uid : platform === 'GitHub' ? raw.owner?.id : ['X', 'LinkedIn', '知乎'].includes(platform) ? raw.author?.id : null
    if (opaque != null && !matched && !envelopeMatched) throw errorOf(409, '响应身份无法与已绑定账号核对', 'identity_unverified')
    return matched || envelopeMatched ? 'response' : 'request_bound'
  }
}

function assertOutput(output) {
  for (const node of [output, output?.data, output?.data?.data].filter(object)) {
    const code = node.status_code ?? node.code
    const failedCode = code != null && ![0, 200, '0', '200'].includes(code)
    if (node.success === false || (node.error != null && node.error !== false && node.error !== '') || (Array.isArray(node.errors) && node.errors.length) || ['error', 'failed'].includes(node.status) || failedCode || (node.baseResponse?.ret != null && node.baseResponse.ret !== 0)) {
      throw errorOf(502, '平台返回错误；不自动重试或切换收费来源', 'provider_error')
    }
  }
}

function responseRows(platform, output) {
  assertOutput(output)
  for (const path of LIST_PATHS[platform] || []) {
    const rows = atPath(output, path)
    if (Array.isArray(rows)) {
      if (rows.some(row => !object(row))) throw schemaError()
      return rows
    }
  }
  throw schemaError()
}

function idOf(platform, row) {
  const paths = platform === '公众号' ? ['app_msg_id', 'id'] : platform === '抖音' ? ['aweme_id', 'id'] : platform === 'YouTube' ? ['video_id', 'id'] : ['id']
  const raw = pickField(row, paths).raw
  if (typeof raw !== 'string' && !(Number.isSafeInteger(raw) && raw >= 0)) return ''
  const id = String(raw)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:=-]{0,199}$/.test(id)) return ''
  if (['公众号', '视频号', '知乎', 'Substack', '抖音', 'X'].includes(platform) && !/^\d+$/.test(id)) return ''
  if (platform === '小红书' && !/^[0-9a-f]{24}$/i.test(id)) return ''
  if (platform === '公众号') {
    const index = row.idx ?? 1
    if (!/^\d+$/.test(String(index)) || !Number.isSafeInteger(Number(index)) || Number(index) < 1) return ''
    return `${id}:${Number(index)}`
  }
  return id
}

function contentKind(platform, raw) {
  if (platform === 'GitHub') return 'repo'
  if (['YouTube', '抖音', '视频号'].includes(platform)) return 'video'
  if (platform === '公众号') return ({ 5: 'video', 8: 'image', 7: 'unknown' })[raw.item_show_type] || 'article'
  if (['知乎', 'Substack'].includes(platform)) return 'article'
  if (platform === 'X') return raw.kind === '引用' ? 'quote' : raw.kind === '原创' ? 'original' : 'unknown'
  if (platform === '小红书') return raw.type === 'video' ? 'video' : raw.type === 'normal' ? 'image' : 'unknown'
  if (platform === 'LinkedIn') {
    if (object(raw.postVideo)) return 'video'
    if (Array.isArray(raw.postImages) && raw.postImages.length) return 'image'
    if (!raw.document && raw.type === 'post') return 'text'
  }
  return 'unknown'
}

function normalizeResult(platform, output, identifier) {
  identifier = identifierOf(platform, identifier)
  const source = responseRows(platform, output), check = bindingFor(platform, output, identifier), rows = [], ids = new Set()
  for (const raw of source) {
    if (raw.error || raw.success === false) throw errorOf(502, '列表项返回平台错误', 'provider_error')
    if ((platform === 'LinkedIn' && raw.repostedAt) || (platform === 'X' && ['转推', '回复'].includes(raw.kind))) continue
    if (platform === 'LinkedIn' && raw.type != null && raw.type !== 'post') throw schemaError()
    const identityCheck = check(raw), id = idOf(platform, raw)
    if (!id || ids.has(id)) continue
    ids.add(id)
    const title = [raw.title, raw.name, raw.desc, raw.content, raw.text].find(value => typeof value === 'string') || ''
    const url = publicUrl(raw.url ?? raw.link ?? raw.linkedinUrl) || (platform === '小红书' ? `https://www.xiaohongshu.com/explore/${id}` : platform === '抖音' ? `https://www.douyin.com/video/${id}` : null)
    const row = { id, title: title.split('\n')[0].trim().slice(0, 500), url, quality: {}, sourceFields: {}, rawCounts: {}, identityCheck, contentKind: contentKind(platform, raw) }
    for (const key of METRICS) {
      // Explicit impressions stay distinct; public views never supply this field.
      const paths = key === 'impressions' ? ['impressions', 'engagement.impressions'] : METRIC_FIELDS[platform]?.[key] || []
      let { field, raw: value } = pickField(raw, paths)
      let sourceRaw = value
      // An extracted integer must not upgrade a rounded YouTube display to exact.
      if (platform === 'YouTube' && key === 'views' && typeof raw.views === 'string') {
        const display = raw.views.replace(/\s+views?$/i, '').trim()
        if (countValue(display).value != null) { field = 'views'; value = display; sourceRaw = raw.views }
      }
      const parsed = countValue(value)
      row[key] = value
      row.rawCounts[key] = sourceRaw
      row.quality[key] = field ? parsed.quality : key !== 'impressions' && paths.length ? 'missing' : 'unsupported'
      row.sourceFields[key] = field
      const hiddenField = ({ views: 'hideViewsCount', likes: 'hideReactionsCount', comments: 'hideCommentsCount', shares: 'hideRepostsCount' })[key]
      const hidden = platform === 'LinkedIn' && hiddenField && (raw.socialContent?.hideSocialActivityCounts === true || raw.socialContent?.[hiddenField] === true)
      if ((platform === '视频号' && key === 'views' && parsed.value === 0) || hidden) { row[key] = null; row.quality[key] = 'withheld' }
    }
    const time = pickField(raw, TIME_FIELDS[platform] || [])
    Object.assign(row, publishedTime(time.raw), { publishedSource: time.field })
    rows.push(row)
  }
  return { rows, returned: source.length, rejected: source.length - rows.length }
}

export function normalizeMonitorPosts(platform, output, identifier) {
  return normalizeResult(platform, output, identifier).rows
}

export function normalizedLegacy(platform, row) {
  return {
    ...row, id: String(row.id ?? row.tweetId ?? row.postId ?? ''),
    publishedAt: row.publishedAt || row.createdAt || null, title: row.title || row.text || '',
    likes: row.likes ?? row.favorites ?? null, comments: row.comments ?? row.replies ?? null,
    saves: row.saves ?? row.bookmarks ?? null, shares: row.shares ?? row.retweets ?? row.reposts ?? null,
    contentKind: platform === 'X' ? row.kind === '引用' ? 'quote' : row.kind === '原创' ? 'original' : 'unknown' : platform === 'GitHub' ? 'repo' : row.contentKind || 'unknown',
  }
}

function profileData(platform, output, identifier) {
  assertOutput(output)
  const paths = platform === '抖音' ? ['user', 'data.user', 'data.data.user'] : ['data.data', 'data', '']
  const identityPaths = { 小红书: ['userid', 'user_id', 'id'], GitHub: ['login', 'handle', 'username'], 知乎: ['url_token', 'user_url_token'], 视频号: ['username', 'user_name'], 抖音: ['sec_uid'] }[platform]
  const path = paths.find(path => object(atPath(output, path)) && identityPaths.some(key => atPath(output, path)[key] != null))
  if (path == null) throw schemaError()
  const node = atPath(output, path)
  if (identifier != null) {
    identifier = identifierOf(platform, identifier)
    for (const candidate of paths.map(path => atPath(output, path)).filter(object)) {
      for (const key of identityPaths) if (candidate[key] != null && (typeof candidate[key] !== 'string' || !sameIdentity(platform, candidate[key], identifier))) throw mismatch()
    }
  }
  const canonical = platform === '抖音' ? { user: node } : { data: node }
  const observed = OWN_ENDPOINTS[platform].profile.read(canonical, identifier ?? identityPaths.map(key => node[key]).find(Boolean))
  if (!observed.ok) throw schemaError()
  return { node, prefix: path ? `${path}.` : '', canonical, observed }
}

/** Optional identifier validates the profile binding. raw retains display precision; value is parsed.
 * field is the original response path; sourceRaw retains a withheld public zero. */
export function followerValue(platform, output, identifier) {
  if (!FOLLOWER_PLATFORMS.has(platform)) return { raw: null, value: null, field: null, quality: 'unsupported' }
  const { node, prefix } = profileData(platform, output, identifier)
  let field = { 视频号: 'fans_count', GitHub: 'followers', 知乎: 'follower_count', 抖音: 'follower_count' }[platform]
  if (platform === '小红书') {
    if (node.interactions != null && (!Array.isArray(node.interactions) || node.interactions.some(row => !object(row)))) throw schemaError()
    const fans = (node.interactions || []).map((row, index) => ({ row, index })).filter(({ row }) => row.type === 'fans')
    if (fans.length > 1) throw schemaError()
    field = fans.length ? `interactions[${fans[0].index}].count` : 'fans'
    const raw = fans.length ? fans[0].row.count ?? null : node.fans ?? null
    return { raw, ...countValue(raw), field: prefix + field }
  }
  const raw = node[field] ?? null, parsed = countValue(raw)
  if (platform === '视频号' && parsed.value === 0) return { raw: null, sourceRaw: raw, value: null, field: prefix + field, quality: 'withheld' }
  return { raw, ...parsed, field: prefix + field }
}

// Validate the inspected JSON-schema keywords used by the registered endpoints.
// Unknown constraints fail closed rather than paying for a guessed input contract.
function validSchema(schema, value) {
  const known = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'oneOf', 'allOf', 'enum', 'const', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'title', 'description', 'default', 'example', 'examples', 'editor', 'prefill', 'schemaVersion', 'sectionCaption', 'x-readme-ref-name', 'x-aliases'])
  if (!object(schema) || Object.keys(schema).some(key => !known.has(key))) return false
  if (schema.anyOf && (!Array.isArray(schema.anyOf) || !schema.anyOf.some(part => validSchema(part, value)))) return false
  if (schema.oneOf && (!Array.isArray(schema.oneOf) || schema.oneOf.filter(part => validSchema(part, value)).length !== 1)) return false
  if (schema.allOf && (!Array.isArray(schema.allOf) || !schema.allOf.every(part => validSchema(part, value)))) return false
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.includes(value))) return false
  if (has(schema, 'const') && schema.const !== value) return false
  const typeMatches = type => type === 'object' ? object(value) : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : type === 'null' ? value === null : ['string', 'boolean'].includes(type) && typeof value === type
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(typeMatches)) return false
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength || schema.maxLength != null && value.length > schema.maxLength) return false
    if (schema.pattern != null) { try { if (!new RegExp(schema.pattern).test(value)) return false } catch { return false } }
  }
  if (typeof value === 'number' && (schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum || schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum || schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum || schema.multipleOf != null && (!schema.multipleOf || !Number.isInteger(value / schema.multipleOf)))) return false
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems || schema.maxItems != null && value.length > schema.maxItems || schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false
    if (schema.items && !value.every(item => validSchema(schema.items, item))) return false
  }
  if (object(value)) {
    if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => !has(value, key)))) return false
    // Even additionalProperties:true cannot silently remove a field's registered meaning.
    for (const [key, item] of Object.entries(value)) if (!has(schema.properties, key) || !validSchema(schema.properties[key], item)) return false
  }
  return true
}

function usd(amount) {
  if (!object(amount) || amount.currency !== 'USD' || !Number.isFinite(amount.value) || amount.value < 0) throw errorOf(409, '端点价格不明确，已阻止付费请求', 'price_unknown')
  return amount.value
}

function estimatePrice(spec, detail, payload) {
  const unknown = () => errorOf(409, '端点价格无法确定上限，已阻止付费请求', 'price_unknown')
  let price = detail.price
  if (!object(price)) throw unknown()
  if (price.type === 'PER_UNIT_MATRIX') {
    if (spec.provider !== 'anyapi' || !['/github.user', '/github.user_repositories'].includes(spec.endpoint)) throw unknown()
    if (!Array.isArray(price.selectors) || price.selectors.length !== 1 || price.selectors[0].key !== 'route' || price.selectors[0].in !== 'body' || !Array.isArray(price.variants)) throw unknown()
    if (Object.keys(price).some(key => !['type', 'amount', 'selectors', 'variants', 'notes'].includes(key))) throw unknown()
    if (price.amount != null) usd(price.amount)
    const matches = price.variants.filter(variant => object(variant.when) && Object.keys(variant.when).length === 1 && variant.when.route === (has(payload, 'route') ? payload.route : false))
    if (matches.length !== 1 || matches[0].price?.type !== 'PER_CALL') throw unknown()
    price = matches[0].price
  }
  if (Object.keys(price).some(key => !['type', 'amount', 'flatFee', 'notes'].includes(key))) throw unknown()
  const amount = usd(price.amount), flatFee = price.flatFee == null ? 0 : usd(price.flatFee)
  let estimate
  if (price.type === 'PER_CALL') estimate = amount + flatFee
  else if (price.type === 'PER_RESULT' && spec.provider === 'apify' && spec.endpoint === '/harvestapi/linkedin-profile-posts') {
    if (price.flatFee == null) throw unknown()
    if (!Array.isArray(payload.targetUrls) || payload.targetUrls.length !== 1 || !Number.isSafeInteger(payload.maxPosts) || payload.maxPosts < 1 || payload.maxPosts > 5 || payload.includeReposts !== false || payload.scrapeComments !== false || payload.scrapeReactions !== false) throw unknown()
    if (!platformSpec('LinkedIn').link.parse(payload.targetUrls[0])) throw unknown()
    estimate = amount * payload.targetUrls.length * payload.maxPosts + flatFee
  } else throw unknown()
  estimate = Number(estimate.toFixed(12))
  if (!Number.isFinite(estimate) || !Number.isFinite(spec.cost) || spec.cost < 0) throw unknown()
  if (estimate > spec.cost + 1e-9) throw errorOf(409, '端点价格高于登记预记，需重新确认价格', 'price_changed')
  return estimate
}

function runError(result) {
  if (!result) return errorOf(503, 'Monid 命令不可用', 'collector_unavailable')
  if (result.status === 'BLOCKED') return Object.assign(errorOf(402, 'Monid 预算、余额或单次限额阻止了请求', 'budget_blocked'), { controls: result.controls })
  const http = result.providerResponse?.httpStatus
  if ([401, 403].includes(http)) return errorOf(403, '平台拒绝访问或要求认证', 'collector_auth_required')
  if (http === 429 || result.error?.code === 'RATE_LIMITED') return errorOf(429, '平台限流；不自动重试', 'collector_rate_limited')
  if (['READY', 'RUNNING', 'STOPPING', 'TIMED_OUT'].includes(result.status)) return Object.assign(errorOf(504, '采集结果未确定；不重新发起付费请求', 'collector_uncertain'), { runId: result.id ?? result.runId ?? null })
  if (result.status !== 'COMPLETED' || result.error || (http != null && (!Number.isInteger(http) || http < 200 || http >= 300))) return errorOf(502, '平台采集失败；不自动重试或切换收费来源', 'collector_failed')
  return null
}

function coverageOf(platform, output, normalized) {
  const pagination = {
    公众号: { end: ['data.is_end', 'is_end'], cursor: ['data.next_offset', 'next_offset'] },
    视频号: { more: ['data.up_continue', 'up_continue'], cursor: ['data.last_buffer', 'last_buffer'] },
    知乎: { end: ['data.paging.is_end', 'paging.is_end'], cursor: ['data.paging.next', 'paging.next'] },
    YouTube: { cursor: ['pagination.next_page_token', 'data.pagination.next_page_token'] },
    GitHub: { more: ['data.hasMore', 'hasMore'], cursor: ['data.nextCursor', 'nextCursor'] },
    小红书: { more: ['data.data.has_more', 'data.has_more'], cursor: ['data.data.cursor', 'data.cursor'] },
    抖音: { more: ['has_more', 'data.has_more'], cursor: ['max_cursor', 'data.max_cursor'] },
  }[platform] || {}
  const end = pickField(output, pagination.end || []).raw, more = pickField(output, pagination.more || []).raw
  const cursorValue = pickField(output, pagination.cursor || []).raw
  const cursor = typeof cursorValue === 'string' ? cursorValue : Number.isSafeInteger(cursorValue) ? String(cursorValue) : null
  const complete = normalized.rejected === 0 && ([true, 1].includes(end) || [false, 0].includes(more))
  return { returned: normalized.returned, rejected: normalized.rejected, complete, pages: 1, cursor: complete ? null : cursor, reason: complete ? null : cursor || [true, 1].includes(more) ? 'page_limit' : normalized.rejected ? 'rejected_items' : 'single_page' }
}

export class MonitorCollectors {
  constructor({ monid, grokx, budget, now = () => new Date() }) { this.monid = monid; this.grokx = grokx; this.budget = budget; this.now = now; this.prices = new Map() }

  async verifiedPrice(spec, input, payload = spec.input(input)) {
    const key = `${spec.provider}:${spec.endpoint}`, current = +this.now(), saved = this.prices.get(key)
    let detail = saved && current >= saved.at && current - saved.at < 86400000 ? saved.detail : null
    if (!detail) {
      detail = await this.monid(['inspect', '-p', spec.provider, '-e', spec.endpoint, '-j'], 30)
      if (detail?.error) throw errorOf(502, '端点资料读取失败，未发起付费请求', 'inspect_failed')
      if (detail?.provider !== spec.provider || detail?.endpoint !== spec.endpoint) throw errorOf(409, '端点资料与登记不符', 'schema_changed')
      this.prices.set(key, { detail, at: current })
    }
    const schema = spec.body ? detail.input?.body : detail.input?.queryParams
    if (detail.method !== (spec.body ? 'POST' : 'GET') || (spec.body && detail.input?.bodyType !== 'json') || detail.input?.pathParams?.required?.length || !object(payload) || !validSchema(schema, payload)) throw errorOf(409, '端点输入契约与登记不符，已阻止请求', 'schema_changed')
    return estimatePrice(spec, detail, payload)
  }

  async call(spec, input) {
    const payload = spec.input(input), price = await this.verifiedPrice(spec, input, payload)
    const result = await this.budget.run(price, () => this.monid(monidArgs({ ...spec, input: () => payload }, input), 150), this.now())
    const failure = runError(result)
    if (failure) throw failure
    if (result.output == null) throw schemaError()
    assertOutput(result.output)
    return { output: result.output, price }
  }

  async collect(account, purpose = 'posts', { sinceDays = 30 } = {}) {
    const spec = collectorSpec(account.platform, purpose)
    if (!spec) throw errorOf(409, '此平台尚无已验证的这类采集器', 'unsupported_collector')
    const identifier = identifierOf(account.platform, account.identity?.value)
    if (account.homeUrl) {
      const linkSpec = platformSpec(account.platform)?.link, found = linkSpec?.parse(account.homeUrl)
      const publicHome = !linkSpec && publicUrl(account.homeUrl)
      if (!found && !(publicHome && ['mp.weixin.qq.com', 'channels.weixin.qq.com'].includes(new URL(publicHome).hostname))) throw errorOf(400, '账号主页链接无效', 'invalid_identity')
      const linked = account.platform === 'LinkedIn' ? found?.url : found?.id || ''
      const sameKind = account.platform !== 'YouTube' || linked.startsWith('@') === identifier.startsWith('@')
      if (linked && sameKind && !sameIdentity(account.platform, linked, identifier)) throw mismatch()
    }
    if (spec.channel === 'grok') {
      if (!Number.isSafeInteger(sinceDays) || sinceDays < 1 || sinceDays > 90) throw errorOf(400, '读取天数需为 1 至 90 的整数')
      const output = await this.grokx.listRecent(identifier, { sinceDays }), normalized = normalizeResult(account.platform, output, identifier)
      const selected = new Set(normalized.rows.map(row => row.id))
      return { rows: normalized.rows, legacyRows: output.filter(raw => !['转推', '回复'].includes(raw.kind) && selected.delete(String(raw.id))), spec, observedAt: this.now().toISOString(), coverage: { returned: normalized.returned, rejected: normalized.rejected, complete: false, pages: 1, cursor: null, missed: Number.isSafeInteger(output.missed) && output.missed >= 0 ? output.missed : 0, failed: Array.isArray(output.failed) ? output.failed : [], reason: 'search_not_exhaustive' }, price: null }
    }
    const { output, price } = await this.call(spec, identifier), observedAt = this.now().toISOString()
    if (purpose === 'followers') {
      const profile = profileData(account.platform, output, identifier), followers = followerValue(account.platform, output, identifier)
      // Cache shape: original output + the existing OwnAccounts observed() display shape.
      // Missing/withheld totals still retain the valid paid profile without inventing a sample.
      return { spec, price, observedAt, rows: [], legacyRows: [], followers, profile: { identifier, output, observed: profile.observed, identityCheck: 'response' }, coverage: { returned: 1, rejected: 0, complete: false, pages: 1, cursor: null, reason: followers.value == null ? `followers_${followers.quality}` : 'profile_snapshot' } }
    }
    const normalized = normalizeResult(account.platform, output, identifier)
    return { spec, price, observedAt, rows: normalized.rows, legacyRows: normalized.rows.map(row => ({ ...row, ...Object.fromEntries(METRICS.map(key => [key, ['exact', 'rounded'].includes(row.quality[key]) ? countValue(row[key]).value : null])) })), coverage: coverageOf(account.platform, output, normalized) }
  }
}
