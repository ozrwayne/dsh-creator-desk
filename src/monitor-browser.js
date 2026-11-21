/*
 * Optional own-account observation. No publisher imports, browser launch, login,
 * input events, arbitrary scripts, credential extraction, or existing-tab adoption.
 *
 * API (server-side configuration ONLY):
 *   new MonitorBrowser({ bindings: [{ profileRef, accountId, platform, enabled:true,
 *     cdpEndpoint:'ws://127.0.0.1:9333/devtools/browser/<browser-id>',
 *     identity:{kind:'sec_uid',value:'…'}, timeZone:'Asia/Shanghai' }],
 *     WebSocket: globalThis.WebSocket, now:()=>new Date(), timeoutMs:20000 })
 *   .collect(account, 'posts'|'followers', {sinceDays:30})
 * account.browserProfileRef and identity must match the local binding; roles must
 * include own. A new browser process needs its local pinned endpoint rebound.
 * Node 20 does not always provide WebSocket: return runtime_unavailable rather than
 * installing packages or opening another browser. A host may inject its existing
 * WHATWG-compatible WebSocket implementation through this trusted constructor.
 *
 * Result: {rows,legacyRows,spec,observedAt,coverage,price:0,source,followers?}.
 * rows contain id/url/title/contentKind, the nine scalar metrics, quality and
 * sourceFields, identityCheck:'response', publication fields (unknown stays null).
 * followers = {raw,field,quality,total,gain,loss,net,todayNet,timeZone,observedAt,
 *   source:'live',method:'observed',history:[{day,total,gain,loss,net,quality,
 *   sourceFields,source:'backfill',method:'observed',observedAt,timeZone,
 *   precision:'day',effectiveAt:null,spanDays,baseDays:[]}]}.
 * No reconstruction, storage, scheduling, fallback, or paid calls happen here.
 * Coverage is one loaded page, never a claim of complete history. price is zero
 * external API fees, not a claim about browser/maintenance costs. Errors have
 * status/code; missing credentials, identity, selectors and cleanup are failures.
 *
 * Metric selectors/endpoint facts adapted from mdldm-maitian at the pinned commit
 * below. Changes: account validation, stable IDs, no title matching, strict nulls,
 * read-only fixed operations, bounded own-tab lifecycle and explicit partial data.
 * Its Channels post collector has no stable ID; that capability is unavailable.
 * XHS personal_info's stable user_id is a guarded extension, NOT established by
 * maitian/OpenCLI's profile source (which only reads name/counts). Missing user_id
 * fails identity_unavailable; a display name never substitutes for it. No adapter
 * has been validated against a live authenticated session by this implementation.
 *
 * MIT License — Copyright (c) 2026 麦当 mdldm
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { randomUUID } from 'node:crypto'
import { countValue, errorOf, METRICS, publishedTime } from './monitor-model.js'

const COMMIT = 'f2d18d11a40dcb9d7c7c8a5d784787e0cae5aa8d'
export const BROWSER_SOURCE = Object.freeze({
  repository: 'https://github.com/CzzzzzzJ/mdldm-maitian', commit: COMMIT,
  metrics: `https://github.com/CzzzzzzJ/mdldm-maitian/blob/${COMMIT}/src/metrics.mjs`,
  metricsGitBlob: '4d3654ace1ed16eab1da67e00647aca8430ffd30',
  followers: `https://github.com/CzzzzzzJ/mdldm-maitian/blob/${COMMIT}/src/followers.mjs`,
  followersGitBlob: 'c0ec9220d0f0a08591abf295c79dc65a0adbd8c4',
  bilibiliIdentity: 'https://github.com/nbt0/bilibili-api-collect/blob/master/docs/login/login_info.md',
  channelsIdentity: 'https://github.com/jackwener/OpenCLI/blob/main/clis/wechat-channels/auth.js',
  channelsIdentityGitBlob: 'bd4c47e7fb412883e281c590dfdc2f9b9f878f97',
  xhsProfile: 'https://github.com/jackwener/OpenCLI/blob/main/clis/xiaohongshu/creator-profile.js',
  xhsProfileGitBlob: '0e3c9b95ae718a08387d590e5084d62586fc0e8a',
  liveVerified: false,
})

const PLATFORMS = {
  'B站': { id: 'bilibili', kind: 'uid', identity: /^\d{1,20}$/,
    origin: 'https://member.bilibili.com', posts: '/platform/upload-manager/article', followers: '/platform/home' },
  '抖音': { id: 'douyin', kind: 'sec_uid', identity: /^[A-Za-z0-9_-]{8,200}$/,
    origin: 'https://creator.douyin.com', posts: '/creator-micro/content/manage', followers: '/creator-micro/home' },
  '小红书': { id: 'xhs', kind: 'internal_id', identity: /^[a-fA-F0-9]{24}$/,
    origin: 'https://creator.xiaohongshu.com', posts: '/new/note-manager', followers: '/statistics/fans-data' },
  '视频号': { id: 'channels', kind: 'finder_id', identity: /^[A-Za-z0-9_-]+@finder$/,
    origin: 'https://channels.weixin.qq.com', posts: null, followers: '/platform/statistic/follower' },
  'YouTube': { id: 'youtube', kind: 'channel_id', identity: /^UC[A-Za-z0-9_-]{22}$/,
    origin: 'https://studio.youtube.com', posts: '/', followers: '/' },
}
export const BROWSER_PLATFORMS = Object.freeze(Object.entries(PLATFORMS).map(([platform, p]) => Object.freeze({
  platform, posts: Boolean(p.posts), followers: Boolean(p.followers),
  reason: p.id === 'channels' ? '粉丝需页面自然返回 auth_data 身份；作品缺少已核稳定 ID'
    : p.id === 'xhs' ? '需 personal_info 返回可核对的 user_id；该字段未获上游源码证实，缺少即停采'
      : '已实现固定后台适配器；需本机独立 profile、人工登录和响应身份核验，未做登录态实测',
})))
const API = Object.freeze({
  bilibiliIdentity: 'https://api.bilibili.com/x/web-interface/nav',
  bilibiliPosts: 'https://member.bilibili.com/x/web/archives?status=pubed&pn=1&ps=50&coop=1',
  bilibiliFollowers: 'https://member.bilibili.com/x/web/index/stat',
  bilibiliHistory: 'https://member.bilibili.com/x/web/data/v2/overview/stat/graph?period=2&s_locale=zh_CN&type=fan',
  douyinIdentity: 'https://creator.douyin.com/web/api/media/user/info/',
  xhsIdentity: 'https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info',
  xhsFollowers: 'https://creator.xiaohongshu.com/api/galaxy/creator/data/fans/overall_new',
  channelsIdentity: 'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data',
})
const MAX_BODY = 2 * 1024 * 1024
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message, status = 409) => { throw errorOf(status, message, code) }
const stableId = value => typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : ''

export function browserCollectorSpec(platform, purpose = 'posts') {
  const p = PLATFORMS[platform]
  if (!p || !['posts', 'followers'].includes(purpose)) return null
  return {
    collectorId: `cdp.${p.id}.${purpose}.v1`, channel: 'cdp', measurementSet: `${p.id}.creator-counts.v1`,
    supported: Boolean(p[purpose]), reason: p[purpose] ? null : 'stable_post_id_unavailable',
    identityKind: p.kind, identitySchema: p.id === 'xhs' ? 'guarded_unverified_user_id' : 'response_required',
    liveVerified: false,
  }
}

/** Reject DNS names, redirects, credentials, paths supplied by a web request. */
export function validateCdpEndpoint(raw) {
  let url
  try { url = new URL(raw) } catch { fail('invalid_binding', 'CDP 必须是已登记的本机浏览器 WebSocket 地址') }
  if (typeof raw !== 'string' || !['ws:', 'wss:'].includes(url.protocol)
    || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port
    || url.username || url.password || url.search || url.hash
    || !/^\/devtools\/browser\/[A-Za-z0-9-]{8,100}$/.test(url.pathname)) {
    fail('invalid_binding', 'CDP 只接受固定 loopback IP、端口和已绑定的 browser ID')
  }
  return url.href
}

export function validateBrowserBinding(account, binding) {
  if (!account?.roles?.includes('own')) fail('own_account_required', '浏览器后台只允许已登记的本人账号')
  if (!binding || binding.enabled !== true) fail('browser_not_configured', '此账号没有启用本地浏览器绑定')
  const p = PLATFORMS[account.platform]
  if (!p) fail('unsupported_collector', '此平台没有后台浏览器适配器')
  if (!account.accountId || !account.browserProfileRef || account.accountId !== binding.accountId
    || account.platform !== binding.platform || account.browserProfileRef !== binding.profileRef) {
    fail('binding_mismatch', '本地浏览器 profile 与账号登记不一致')
  }
  const identity = binding.identity
  if (!identity || identity.kind !== p.kind || typeof identity.value !== 'string' || !p.identity.test(identity.value)
    || account.identity?.kind !== identity.kind || account.identity?.value !== identity.value) {
    fail('identity_mismatch', '浏览器绑定需要与账号登记一致的稳定平台 ID；展示名不能替代')
  }
  if (account.identity.status === 'conflict') fail('identity_mismatch', '账号身份冲突尚未解决')
  if (typeof binding.timeZone !== 'string' || !binding.timeZone) fail('invalid_binding', '请在本地绑定中指定后台统计时区')
  try { new Intl.DateTimeFormat('en', { timeZone: binding.timeZone }).format(0) }
  catch { fail('invalid_binding', '后台统计时区无效') }
  return { ...binding, identity: { ...identity }, cdpEndpoint: validateCdpEndpoint(binding.cdpEndpoint) }
}

function dayAt(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
  const g = key => parts.find(part => part.type === key).value
  return `${g('year')}-${g('month')}-${g('day')}`
}
function historyDay(raw, timeZone) {
  if (typeof raw === 'string') {
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw)
    if (m) {
      const day = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
      const date = new Date(`${day}T00:00:00Z`)
      return Number.isFinite(+date) && date.toISOString().slice(0, 10) === day ? day : null
    }
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
  const date = new Date(raw < 1e12 ? raw * 1000 : raw)
  return Number.isFinite(+date) ? dayAt(date, timeZone) : null
}
function signed(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'number' && typeof raw !== 'string') return null
  const text = String(raw).trim()
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return null
  const n = Number(text.replaceAll(',', ''))
  return Number.isSafeInteger(n) ? n : null
}
function schema(value, name) { if (!object(value)) fail('schema_changed', `后台 ${name} 格式无法识别`, 502); return value }
function apiPayload(value, name) {
  schema(value, name)
  if (value.code === -101 || value.status_code === 8 || value.data?.isLogin === false) fail('auth_required', '后台登录已失效', 401)
  if (value.success === false || (value.code != null && value.code !== 0) || (value.status_code != null && value.status_code !== 0)) {
    fail('provider_error', `后台 ${name} 返回失败状态`, 502)
  }
  return value
}

/** Pure decoder, also used by deterministic fixtures; payload is not a public API. */
export function verifyBrowserIdentity(platform, payload, expected) {
  let id, field
  if (platform === 'B站') {
    const d = apiPayload(payload, 'nav').data
    if (d?.isLogin !== true) fail('auth_required', 'B站后台需要人工登录', 401)
    id = stableId(d.mid); field = 'data.mid'
  } else if (platform === '抖音') {
    id = apiPayload(payload, 'user/info').user?.sec_uid; field = 'user.sec_uid'
  } else if (platform === '小红书') {
    id = apiPayload(payload, 'personal_info').data?.user_id; field = 'data.user_id'
  } else if (platform === '视频号') {
    if (payload?.base_resp?.ret !== 0) fail('auth_required', '视频号后台登录状态无法确认', 401)
    const data = payload.data?.finder_user || payload.finder_user
    id = data?.username; field = payload.data?.finder_user ? 'data.finder_user.username' : 'finder_user.username'
  } else if (platform === 'YouTube') {
    let url
    try { url = new URL(payload?.href) } catch { fail('identity_unavailable', 'YouTube Studio 尚未返回频道身份') }
    id = url.origin === PLATFORMS.YouTube.origin ? /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/.exec(url.pathname)?.[1] : null
    field = 'location.pathname/channel'
  }
  if (typeof id !== 'string' || !id) fail('identity_unavailable', '后台没有可证明账号归属的稳定 ID；未采用昵称或配置值替代')
  if (id !== expected?.value || expected?.kind !== PLATFORMS[platform]?.kind) fail('identity_mismatch', '后台当前登录账号与本地绑定不符')
  return { kind: expected.kind, value: id, field }
}

function metricRow(id, title, url, contentKind, raw, mapping) {
  const row = { id, title: String(title || '').split('\n')[0].slice(0, 500), url, contentKind,
    publishedAt: null, publishedDay: null, publishedPrecision: 'unknown', publishedSource: null,
    quality: {}, sourceFields: {}, identityCheck: 'response' }
  for (const key of METRICS) {
    const pair = mapping[key], value = pair ? raw[pair[0]] : null
    const parsed = countValue(value)
    row[key] = parsed.value
    row.quality[key] = pair ? parsed.quality : 'unsupported'
    row.sourceFields[key] = pair ? pair[1] : null
  }
  return row
}
function postRows(platform, payload, identity) {
  let input, decode
  if (platform === 'B站') {
    input = apiPayload(payload.posts, 'archives').data?.arc_audits
    decode = item => {
      const a = item?.Archive, id = a?.bvid
      if (typeof id !== 'string' || !/^BV[\w]{10}$/.test(id) || !object(item.stat)) return null
      // The request selects pubed. If an explicit state contradicts it, exclude it.
      if (a.state != null && a.state !== 0) return null
      if (a.author?.mid != null && stableId(a.author.mid) !== identity.value) fail('identity_mismatch', 'B站返回其他账号的合作作品')
      return metricRow(id, a.title, `https://www.bilibili.com/video/${id}`, 'video', item.stat, {
        views: ['view', 'data.arc_audits[].stat.view'], likes: ['like', 'data.arc_audits[].stat.like'],
        comments: ['reply', 'data.arc_audits[].stat.reply'], saves: ['favorite', 'data.arc_audits[].stat.favorite'], shares: ['share', 'data.arc_audits[].stat.share'],
      })
    }
  } else if (platform === '抖音') {
    input = payload.posts
    decode = item => {
      const id = stableId(item?.aweme_id)
      if (!/^\d{6,30}$/.test(id) || !object(item.statistics)) return null
      if (item.author?.sec_uid && item.author.sec_uid !== identity.value) fail('identity_mismatch', '抖音作品作者与后台账号不符')
      const row = metricRow(id, item.item_title || item.desc, `https://www.douyin.com/video/${id}`, 'video', item.statistics, {
        views: ['play_count', 'react.aweme.statistics.play_count'], likes: ['digg_count', 'react.aweme.statistics.digg_count'],
        comments: ['comment_count', 'react.aweme.statistics.comment_count'], saves: ['collect_count', 'react.aweme.statistics.collect_count'], shares: ['share_count', 'react.aweme.statistics.share_count'],
      })
      if (typeof item.create_time === 'number' && item.create_time > 0) Object.assign(row, publishedTime(item.create_time), { publishedSource: 'react.aweme.create_time' })
      return row
    }
  } else if (platform === '小红书') {
    input = payload.posts
    decode = item => {
      if (!/^[a-fA-F0-9]{24}$/.test(item?.id || '') || !Array.isArray(item.stats) || item.stats.length !== 5 || /定时发布|审核|草稿/.test(item.statusText || '')) return null
      return metricRow(item.id, item.title, `https://www.xiaohongshu.com/explore/${item.id}`, 'unknown', item.stats, {
        views: [0, '.note-card__stat[0]'], comments: [1, '.note-card__stat[1]'], likes: [2, '.note-card__stat[2]'], saves: [3, '.note-card__stat[3]'], shares: [4, '.note-card__stat[4]'],
      })
    }
  } else if (platform === 'YouTube') {
    input = payload.posts
    decode = item => {
      let url
      try { url = new URL(item?.href) } catch { return null }
      const id = url.origin === PLATFORMS.YouTube.origin ? /^\/video\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(url.pathname)?.[1] : null
      if (!id || /草稿|Draft|预定|已安排|Scheduled/i.test(`${item.visibility || ''} ${item.date || ''}`)) return null
      return metricRow(id, item.title, `https://www.youtube.com/watch?v=${id}`, 'video', item, {
        views: ['views', 'ytcp-video-row .tablecell-views'], comments: ['comments', 'ytcp-video-row .tablecell-comments'], likes: ['likes', 'ytcp-video-row .tablecell-likes'],
      })
    }
  } else fail('stable_post_id_unavailable', '视频号上游仅按标题识别作品，未启用作品后台采集')
  if (!Array.isArray(input)) fail('schema_changed', '后台作品列表结构无法识别', 502)
  const rows = [], seen = new Set()
  let rejected = 0
  for (const item of input) {
    const row = decode(item)
    if (!row || seen.has(row.id) || !METRICS.some(key => row[key] != null)) { rejected++; continue }
    seen.add(row.id); rows.push(row)
  }
  // Empty DOM is also the symptom of login walls and selector changes. Do not
  // manufacture an empty successful collection, including for an empty account.
  if (!rows.length) fail(input.length ? 'schema_changed' : 'no_data', '后台没有可核对稳定 ID 和指标的作品；未写入空成功结果', 502)
  return { rows, rejected }
}

function followerData(platform, payload) {
  if (platform === 'B站') {
    const d = apiPayload(payload.followers, 'index/stat').data
    const graph = apiPayload(payload.history, 'overview/stat/graph').data?.tendency
    if (!Array.isArray(graph)) fail('schema_changed', 'B站粉丝趋势格式无法识别', 502)
    return { raw: d?.total_fans, field: 'data.total_fans', todayNet: signed(d?.incr_fans),
      history: graph.map(x => ({ day: x.date_key, net: x.total_inc, fields: { net: 'data.tendency[].total_inc' } })) }
  }
  if (platform === '抖音') return { raw: payload.identity?.user?.follower_count, field: 'user.follower_count', history: [] }
  if (platform === '小红书') {
    const d = apiPayload(payload.followers, 'fans/overall_new').data?.thirty
    if (!object(d) || !Array.isArray(d.fans_list) || !Array.isArray(d.rise_fans_list) || !Array.isArray(d.leave_fans_list)) fail('schema_changed', '小红书粉丝趋势格式无法识别', 502)
    const gain = new Map(d.rise_fans_list.map(x => [x.date, x.count])), loss = new Map(d.leave_fans_list.map(x => [x.date, x.count]))
    return { raw: d.fans_count, field: 'data.thirty.fans_count', history: d.fans_list.map(x => ({ day: x.date, total: x.count, gain: gain.get(x.date), loss: loss.get(x.date),
      fields: { total: 'data.thirty.fans_list[].count', gain: 'data.thirty.rise_fans_list[].count', loss: 'data.thirty.leave_fans_list[].count' } })) }
  }
  if (platform === '视频号') {
    const text = payload.followers?.text
    if (typeof text !== 'string') fail('schema_changed', '视频号统计面板不可读', 502)
    const raw = /关注者总数 \| ([\d,.万亿kKmM]+)/.exec(text)?.[1]
    const history = [...text.matchAll(/(\d{4}\/\d{1,2}\/\d{1,2}) \| (-?[\d,]+) \| ([\d,]+) \| ([\d,]+) \| ([\d,]+)/g)]
      .map(m => ({ day: m[1], net: m[2], gain: m[3], loss: m[4], total: m[5], fields: {
        total: 'wujie-app.shadowRoot/follower-table.total', gain: 'wujie-app.shadowRoot/follower-table.gain', loss: 'wujie-app.shadowRoot/follower-table.loss', net: 'wujie-app.shadowRoot/follower-table.net',
      } }))
    return { raw, field: 'wujie-app.shadowRoot/关注者总数', history }
  }
  const text = payload.followers?.text
  if (typeof text !== 'string') fail('schema_changed', 'YouTube 订阅人数面板不可读', 502)
  return { raw: /(?:当前订阅人数|Current subscribers)\s*\n?\s*([\d,.]+\s*[万KM]?)(?=\s|$)/i.exec(text)?.[1], field: 'body.innerText/Current subscribers', history: [] }
}

export function normalizeBrowserObservation(platform, purpose, payload, { observedAt, timeZone, expectedIdentity, sinceDays = 30 }) {
  const spec = browserCollectorSpec(platform, purpose)
  if (!spec?.supported) fail(spec?.reason || 'unsupported_collector', '此平台的这类后台采集尚不可用')
  if (!Number.isFinite(Date.parse(observedAt))) fail('invalid_input', '实际观测时间无效', 400)
  const identity = verifyBrowserIdentity(platform, payload?.identity, expectedIdentity)
  const base = { rows: [], legacyRows: [], spec, observedAt, price: 0,
    source: { ...BROWSER_SOURCE, identity, mode: 'owned_tab', identitySchema: spec.identitySchema },
    coverage: { returned: 0, rejected: 0, complete: false, cursor: null, pages: 1, reason: 'loaded_page_only' } }
  if (purpose === 'posts') {
    const result = postRows(platform, payload, identity)
    return { ...base, rows: result.rows, legacyRows: result.rows.map(row => ({ ...row })), coverage: { ...base.coverage, returned: result.rows.length, rejected: result.rejected } }
  }
  const data = followerData(platform, payload), parsed = countValue(data.raw)
  if (parsed.value == null) fail('schema_changed', '后台未返回有效粉丝总数；未写入零值', 502)
  const today = dayAt(observedAt, timeZone), cutoff = new Date(`${today}T00:00:00Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - sinceDays)
  const from = cutoff.toISOString().slice(0, 10), history = [], seen = new Set()
  for (const raw of data.history) {
    const day = historyDay(raw.day, timeZone)
    if (!day || seen.has(day)) { base.coverage.rejected++; continue }
    seen.add(day)
    if (day >= today || day < from) continue
    const total = countValue(raw.total), gain = countValue(raw.gain), loss = countValue(raw.loss)
    let net = signed(raw.net)
    if (net == null && gain.quality === 'exact' && loss.quality === 'exact') net = gain.value - loss.value
    if (total.value == null && gain.value == null && loss.value == null && net == null) { base.coverage.rejected++; continue }
    const sourceFields = { total: raw.fields?.total || null, gain: raw.fields?.gain || null, loss: raw.fields?.loss || null,
      net: raw.fields?.net || (net != null ? 'derived:gain-loss' : null) }
    history.push({ day, total: total.value, gain: gain.value, loss: loss.value, net,
      quality: total.value != null ? total.quality : net != null ? 'exact' : 'missing',
      sourceFields, source: 'backfill', method: 'observed', observedAt, timeZone, precision: 'day', effectiveAt: null, spanDays: net == null ? null : 1, baseDays: [] })
  }
  history.sort((a, b) => a.day.localeCompare(b.day))
  return { ...base, coverage: { ...base.coverage, returned: 1 + history.length, reason: history.length ? 'platform_history_window' : 'live_total_only' },
    followers: { raw: data.raw, field: data.field, quality: parsed.quality, total: parsed.value, gain: null, loss: null, net: null,
      todayNet: data.todayNet ?? null, observedAt, timeZone, source: 'live', method: 'observed', history } }
}

// The expressions below are fixed application code, never accepted from callers.
// A separate isolated JS world is used for DOM reads and fixed GETs; Douyin's
// React data requires its page world. None installs hooks or changes application state.
function readDouyinPosts() {
  const rows = []
  for (const node of document.querySelectorAll('[class*=video-card-info]')) {
    let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber'))]
    for (let depth = 0; fiber && depth < 25; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps
      if (!props) continue
      const value = Object.values(props).find(v => v && typeof v === 'object' && v.aweme_id && v.desc !== undefined)
      if (!value) continue
      rows.push({ aweme_id: value.aweme_id, item_title: value.item_title, desc: String(value.desc || '').slice(0, 500),
        create_time: value.create_time, author: { sec_uid: value.author?.sec_uid }, statistics: value.statistics })
      break
    }
  }
  return rows
}
function readXhsPosts() {
  return [...document.querySelectorAll('.note-card')].map(card => {
    let id = ''
    try { id = JSON.parse(card.getAttribute('data-impression')).noteTarget.value.noteId } catch {}
    return { id, title: (card.querySelector('.note-card__title')?.innerText || '').trim(), statusText: card.innerText.slice(0, 2000),
      stats: [...card.querySelectorAll('.note-card__stat')].map(e => e.innerText.trim()) }
  })
}
function readYoutubePosts() {
  return [...document.querySelectorAll('ytcp-video-row')].map(row => {
    const cell = key => (row.querySelector('.tablecell-' + key)?.innerText || '').trim()
    return { href: row.querySelector('a[href*="/video/"]')?.href || '', title: (row.querySelector('#video-title')?.innerText || '').trim(),
      visibility: cell('visibility'), date: cell('date'), views: cell('views'), comments: cell('comments'), likes: cell('likes') }
  })
}
function readChannelsFollowers() {
  const root = document.querySelector('wujie-app')?.shadowRoot
  if (!root) return { text: '' }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), rows = []
  let node
  while ((node = walker.nextNode())) {
    if (/^(STYLE|SCRIPT)$/.test(node.parentElement?.tagName || '')) continue
    const text = node.textContent.trim().replace(/\s+/g, ' ')
    if (text) rows.push(text)
  }
  return { text: rows.join(' | ').slice(0, 200000) }
}
const DOM_READERS = { douyin: readDouyinPosts, xhs: readXhsPosts, youtube: readYoutubePosts }
const PAGE_STATE = `({href:location.href,ready:document.readyState,login:!!document.querySelector('input[type="password"]')})`

function allowedPage(platform, raw) {
  let url
  try { url = new URL(raw) } catch { return false }
  const p = PLATFORMS[platform]
  if (url.origin !== p.origin || url.username || url.password) return false
  if (p.id === 'youtube') return url.pathname === '/' || /^\/channel\/UC[A-Za-z0-9_-]{22}(?:\/(?:dashboard|videos(?:\/upload)?))?\/?$/.test(url.pathname)
  return [p.posts, p.followers].includes(url.pathname)
}

class CdpConnection {
  constructor(WebSocket, endpoint, timeoutMs) { this.WebSocket = WebSocket; this.endpoint = endpoint; this.timeoutMs = timeoutMs; this.sequence = 0; this.pending = new Map(); this.listeners = new Set() }
  async open() {
    const socket = new this.WebSocket(this.endpoint)
    this.socket = socket
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(errorOf(503, '本机 CDP 连接超时', 'browser_unavailable')) }, this.timeoutMs)
      socket.onopen = () => { clearTimeout(timer); resolve() }
      socket.onerror = () => { clearTimeout(timer); reject(errorOf(503, '无法连接已绑定的本机 CDP', 'browser_unavailable')) }
      socket.onclose = () => { clearTimeout(timer); reject(errorOf(503, '本机 CDP 在连接时断开', 'browser_disconnected')) }
    })
    socket.onmessage = event => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { this.abort(errorOf(502, 'CDP 消息格式错误', 'browser_protocol_error')); return }
      if (message.id != null) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id); clearTimeout(pending.timer)
        message.error ? pending.reject(errorOf(502, `CDP ${pending.method} 失败`, 'browser_protocol_error')) : pending.resolve(message.result || {})
      } else for (const listener of this.listeners) listener(message)
    }
    socket.onclose = () => this.abort(errorOf(503, '本机 CDP 已断开', 'browser_disconnected'))
    socket.onerror = () => this.abort(errorOf(503, '本机 CDP 连接异常', 'browser_disconnected'))
  }
  send(method, params = {}, sessionId) {
    if (this.socket?.readyState !== 1) return Promise.reject(errorOf(503, '本机 CDP 未连接', 'browser_disconnected'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { this.pending.delete(id); reject(errorOf(504, `CDP ${method} 超时`, 'browser_timeout')) }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch { clearTimeout(timer); this.pending.delete(id); reject(errorOf(503, 'CDP 命令发送失败', 'browser_disconnected')) }
    })
  }
  abort(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
  close() {
    this.abort(errorOf(503, 'CDP 会话结束', 'browser_disconnected')); this.listeners.clear()
    if (this.socket) {
      this.socket.onclose = null; this.socket.onerror = null; this.socket.onmessage = null
      this.socket.close()
    }
  }
}

class OwnedPage {
  constructor(connection, platform, timeoutMs) {
    this.cdp = connection; this.platform = platform; this.timeoutMs = timeoutMs
    this.passive = null; this.passiveRequest = null; this.fatal = null; this.context = null; this.owned = false
    this.createdUrl = `about:blank#dsh-monitor-${randomUUID()}`
    this.createAttempted = false
  }
  async open() {
    this.createAttempted = true
    const created = await this.cdp.send('Target.createTarget', { url: this.createdUrl, background: true })
    if (typeof created.targetId !== 'string' || !created.targetId) fail('browser_protocol_error', 'CDP 没有返回新标签页 ID', 502)
    this.targetId = created.targetId; this.owned = true
    this.sessionId = (await this.cdp.send('Target.attachToTarget', { targetId: this.targetId, flatten: true })).sessionId
    if (!this.sessionId) fail('browser_protocol_error', 'CDP 没有返回本次标签页会话', 502)
    this.listener = message => { if (message.sessionId === this.sessionId) this.onEvent(message) }
    this.cdp.listeners.add(this.listener)
    await this.send('Page.enable')
    await this.send('Network.enable', { maxTotalBufferSize: MAX_BODY * 2, maxResourceBufferSize: MAX_BODY })
    // Document redirects are intercepted only in this owned target. No login or
    // publishing page is allowed; passive subresource traffic is not manipulated.
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] })
  }
  send(method, params = {}) { return this.cdp.send(method, params, this.sessionId) }
  onEvent(message) {
    const p = message.params || {}
    if (message.method === 'Page.javascriptDialogOpening') this.fatal = errorOf(409, '后台出现对话框，采集已停止；没有自动接受', 'dialog_blocked')
    if (message.method === 'Fetch.requestPaused') {
      const allowed = p.request?.method === 'GET' && allowedPage(this.platform, p.request.url)
      if (!allowed) this.fatal = errorOf(401, '后台跳转到未授权页面或登录页；请人工检查登录', 'auth_required')
      void this.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'Aborted' })
        .catch(error => { this.fatal ||= error })
    }
    if (this.platform !== '视频号') return
    if (message.method === 'Network.responseReceived') {
      let url
      try { url = new URL(p.response?.url) } catch { return }
      if (`${url.origin}${url.pathname}` === API.channelsIdentity) {
        this.passive = null; this.passiveRequest = p.requestId
        if (p.response.status === 401 || p.response.status === 403) this.fatal = errorOf(401, '视频号需要人工登录', 'auth_required')
        else if (p.response.status === 429) this.fatal = errorOf(429, '视频号后台限流；未重试', 'rate_limited')
        else if (p.response.status !== 200) this.fatal = errorOf(502, '视频号身份端点未成功返回', 'provider_error')
      }
    }
    if (message.method === 'Network.loadingFinished' && p.requestId === this.passiveRequest) {
      if (p.encodedDataLength > MAX_BODY) { this.fatal = errorOf(502, '后台身份响应过大', 'schema_changed'); return }
      void this.send('Network.getResponseBody', { requestId: p.requestId }).then(result => {
        if (p.requestId !== this.passiveRequest) return
        const text = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
        if (typeof text !== 'string' || text.length > MAX_BODY) fail('schema_changed', '后台身份响应过大', 502)
        const raw = JSON.parse(text), user = raw.data?.finder_user || raw.finder_user
        // Keep only identity, never auth tokens or the rest of auth_data.
        this.passive = { base_resp: { ret: raw.base_resp?.ret }, finder_user: { username: user?.username } }
      }).catch(error => { this.fatal = error.code ? error : errorOf(502, '后台身份响应格式无法识别', 'schema_changed') })
    }
  }
  check() { if (this.fatal) throw this.fatal }
  async evaluate(expression, { pageWorld = false } = {}) {
    this.check()
    const p = PLATFORMS[this.platform]
    const pathGuard = p.id === 'youtube'
      ? String.raw`(location.pathname==='/'||/^\/channel\/UC[A-Za-z0-9_-]{22}(?:\/(?:dashboard|videos(?:\/upload)?))?\/?$/.test(location.pathname))`
      : `${JSON.stringify([p.posts, p.followers].filter(Boolean))}.includes(location.pathname)`
    const guarded = `(()=>{if(location.origin!==${JSON.stringify(p.origin)}||!${pathGuard})return {__monitorError:'unsafe_navigation'};return (${expression})})()`
    const result = await this.send('Runtime.evaluate', { expression: guarded, returnByValue: true, awaitPromise: true,
      ...(pageWorld ? {} : { contextId: this.context }), timeout: this.timeoutMs, userGesture: false })
    this.check()
    if (result.exceptionDetails) fail('schema_changed', '后台只读提取失败，页面结构或权限可能已变化', 502)
    if (result.result?.value?.__monitorError === 'unsafe_navigation') fail('unsafe_navigation', '采集标签页已离开已授权的统计页，已停止读取', 409)
    return result.result?.value
  }
  async navigate(url) {
    if (!allowedPage(this.platform, url)) fail('unsafe_navigation', '仅允许固定后台统计页', 400)
    this.context = null
    const result = await this.send('Page.navigate', { url })
    this.check()
    if (result.errorText) fail('browser_navigation_failed', '后台统计页加载失败', 502)
    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      this.check()
      const tree = await this.send('Page.getFrameTree'), frame = tree.frameTree?.frame
      if (frame && allowedPage(this.platform, frame.url)) {
        this.context = (await this.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'dsh-monitor-readonly' })).executionContextId
        if (!this.context) fail('browser_protocol_error', '无法创建后台只读上下文', 502)
        const state = await this.evaluate(PAGE_STATE)
        if (state?.login) fail('auth_required', '后台需要人工登录', 401)
        if (state && allowedPage(this.platform, state.href) && ['interactive', 'complete'].includes(state.ready)) return state
      }
      await sleep(200)
    }
    fail('browser_timeout', '后台统计页未在期限内就绪', 504)
  }
  async get(key) {
    const url = API[key]
    if (!url || key === 'channelsIdentity') fail('unsafe_request', '未授权的后台读取', 400)
    // redirect:error prevents a GET helper from following an authentication or
    // unexpected cross-origin redirect. URL is a closed constant, not user input.
    const result = await this.evaluate(`(async()=>{const r=await fetch(${JSON.stringify(url)},{method:'GET',credentials:'include',redirect:'error'});if(!r.ok)return {status:r.status};const text=await r.text();if(text.length>${MAX_BODY})return {status:0,oversized:true};try{return {status:r.status,data:JSON.parse(text)}}catch{return {status:0,invalid:true}}})()`)
    if (result?.status === 401 || result?.status === 403) fail('auth_required', '后台需要人工登录或重新授权', 401)
    if (result?.status === 429) fail('rate_limited', '后台限流；未自动重试', 429)
    if (result?.status !== 200 || !object(result.data)) fail('schema_changed', '后台未返回有效 JSON 数据', 502)
    return result.data
  }
  async waitFor(read, ready) {
    const deadline = Date.now() + this.timeoutMs
    do {
      this.check()
      const value = await read()
      if (ready(value)) return value
      await sleep(250)
    } while (Date.now() < deadline)
    fail('schema_changed', '后台登录身份或数据选择器未就绪；没有写入空成功结果', 502)
  }
  async identity() {
    if (this.platform === '视频号') {
      try { return await this.waitFor(async () => this.passive, value => value != null) }
      catch (error) {
        if (error.code === 'schema_changed') fail('identity_unavailable', '没有自然捕获到视频号 auth_data 身份；请人工检查登录，采集器不会发送认证 POST')
        throw error
      }
    }
    if (this.platform === 'YouTube') return this.waitFor(() => this.evaluate(PAGE_STATE), value => /\/channel\/UC[A-Za-z0-9_-]{22}(?:\/|$)/.test(value?.href || ''))
    const key = `${PLATFORMS[this.platform].id}Identity`
    const data = await this.get(key)
    // The caller checks this fresh response before reading any metrics.
    return data
  }
  async close() {
    this.cdp.listeners.delete(this.listener)
    if (!this.createAttempted) return
    // A disconnected transport must not turn a known owned tab into an orphan.
    // Reconnect only to the same pinned local browser, solely for cleanup.
    if (this.cdp.socket?.readyState !== 1) {
      this.cdp.close()
      await this.cdp.open()
    }
    if (!this.owned) {
      // A create timeout can lose its reply after Chrome created the blank tab.
      // Inspect metadata only to recover our unguessable marker; never attach to
      // or close another target, even if its URL belongs to the same platform.
      const inventory = await this.cdp.send('Target.getTargets')
      const matches = (inventory.targetInfos || []).filter(target => target.type === 'page' && target.url === this.createdUrl)
      if (matches.length !== 1) fail('browser_cleanup_uncertain', '创建标签页的结果不确定；请在本机检查', 503)
      this.targetId = matches[0].targetId; this.owned = true
    }
    const result = await this.cdp.send('Target.closeTarget', { targetId: this.targetId })
    if (result.success !== true) fail('browser_cleanup_failed', '本次采集标签页未确认关闭，请在本机检查', 503)
    this.owned = false; this.createAttempted = false
  }
}

const activeProfiles = new Set()
export class MonitorBrowser {
  #bindings
  #WebSocket
  #now
  #timeoutMs
  constructor({ bindings = [], WebSocket = globalThis.WebSocket, now = () => new Date(), timeoutMs = 20000 } = {}) {
    if (!Array.isArray(bindings)) fail('invalid_binding', '本地浏览器绑定必须为数组', 400)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) fail('invalid_input', '浏览器超时范围为 100–60000 毫秒', 400)
    this.#bindings = new Map()
    for (const value of bindings) {
      if (!object(value) || typeof value.profileRef !== 'string' || !value.profileRef || this.#bindings.has(value.profileRef)) fail('invalid_binding', '本地 profile 引用缺失或重复', 400)
      this.#bindings.set(value.profileRef, structuredClone(value))
    }
    this.#WebSocket = WebSocket; this.#now = now; this.#timeoutMs = timeoutMs
  }
  async collect(account, purpose = 'posts', options = {}) {
    if (!object(options) || Object.keys(options).some(key => key !== 'sinceDays')) fail('invalid_input', '浏览器采集只接受 sinceDays 参数', 400)
    const sinceDays = options.sinceDays ?? 30
    if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 366) fail('invalid_input', 'sinceDays 必须为 1–366 的整数', 400)
    const binding = validateBrowserBinding(account, this.#bindings.get(account?.browserProfileRef))
    const spec = browserCollectorSpec(account.platform, purpose)
    if (!spec?.supported) fail(spec?.reason || 'unsupported_collector', '此平台的这类后台采集尚不可用')
    if (typeof this.#WebSocket !== 'function') fail('runtime_unavailable', '当前 Node 运行时缺少 WebSocket；请由宿主配置现有实现或使用支持内置 WebSocket 的 Node', 503)
    if (activeProfiles.has(binding.cdpEndpoint)) fail('browser_busy', '这个浏览器 profile 正在采集，请稍后重试')
    activeProfiles.add(binding.cdpEndpoint)
    const connection = new CdpConnection(this.#WebSocket, binding.cdpEndpoint, this.#timeoutMs)
    const page = new OwnedPage(connection, account.platform, this.#timeoutMs)
    let result, failure
    try {
      await connection.open()
      await page.open()
      const p = PLATFORMS[account.platform]
      await page.navigate(p.origin + p[purpose])
      const before = await page.identity()
      verifyBrowserIdentity(account.platform, before, binding.identity)
      if (p.id === 'youtube' && purpose === 'posts') await page.navigate(`${p.origin}/channel/${binding.identity.value}/videos/upload`)
      const payload = { identity: before }
      if (purpose === 'posts') {
        if (p.id === 'bilibili') payload.posts = await page.get('bilibiliPosts')
        else payload.posts = await page.waitFor(() => page.evaluate(`(${DOM_READERS[p.id].toString()})()`, { pageWorld: p.id === 'douyin' }), value => Array.isArray(value) && value.length > 0)
      } else if (p.id === 'bilibili') {
        payload.followers = await page.get('bilibiliFollowers'); payload.history = await page.get('bilibiliHistory')
      } else if (p.id === 'xhs') payload.followers = await page.get('xhsFollowers')
      else if (p.id === 'channels') payload.followers = await page.waitFor(() => page.evaluate(`(${readChannelsFollowers.toString()})()`), value => /关注者总数 \| \d/.test(value?.text || ''))
      else if (p.id === 'youtube') payload.followers = await page.waitFor(() => page.evaluate(`({text:(document.body?.innerText||'').slice(0,200000)})`), value => /当前订阅人数|Current subscribers/.test(value?.text || ''))
      let observedAt = this.#now().toISOString()
      // Detect account switches while the same page was loading metrics.
      const after = await page.identity()
      verifyBrowserIdentity(account.platform, after, binding.identity)
      payload.identity = after
      if (p.id === 'douyin' && purpose === 'followers') observedAt = this.#now().toISOString()
      page.check()
      result = normalizeBrowserObservation(account.platform, purpose, payload, { observedAt, timeZone: binding.timeZone, expectedIdentity: binding.identity, sinceDays })
    } catch (error) { failure = error.code ? error : errorOf(502, '后台浏览器采集失败', 'browser_failed') }
    finally {
      try { await page.close() }
      catch (error) { failure = Object.assign(errorOf(503, '本次采集标签页未确认关闭；没有操作其他标签页', 'browser_cleanup_failed'), { cleanup: { targetId: page.targetId || null, causeCode: error.code || 'unknown', collectionCode: failure?.code || null } }) }
      connection.close(); activeProfiles.delete(binding.cdpEndpoint)
    }
    if (failure) throw failure
    return result
  }
}
