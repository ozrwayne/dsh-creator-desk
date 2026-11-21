// Inspected 2026-11-12: tweet_id detail ($0.001); timeline screen_name + cursor ($0.001).
// Detail's output.text includes the long note; output.display_text is only its preview.
// Evidence: https://docs.tikhub.io/191321709e0.
import { MonidBudget, X_ENDPOINT, PAGE_COST } from './xrefresh.js'
import { tr } from './i18n.js'

export const ORIGINAL_ENDPOINT = '/api/v1/twitter/web/fetch_tweet_detail'
export const ORIGINAL_COST = 0.001
export const ORIGINAL_MAX_PAGES = 5
const fail = (status, message, vars) => Object.assign(new Error(tr(message, vars)), { status })
const amount = value => value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Number(value)

function requestsFor(urls) {
  if (!Array.isArray(urls)) throw fail(400, '请选择推文')
  const requests = new Map()
  for (const url of urls) {
    const match = /^https:\/\/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/.exec(url)
    if (!match) throw fail(400, '推文链接无效')
    const [, handle, id] = match
    if (requests.has(id) && requests.get(id).handle.toLowerCase() !== handle.toLowerCase()) throw fail(400, '推文账号不一致')
    requests.set(id, { id, handle, url: `https://x.com/${handle}/status/${id}` })
  }
  return [...requests.values()]
}

/** Only inspected top-level fields; never substitute display_text, quoted, or model text. */
export function normalizeOriginalPost(row, request, { strategy = 'single' } = {}) {
  const id = strategy === 'single' ? row?.id : row?.tweet_id
  const handle = row?.author?.screen_name
  if (typeof id !== 'string' || id !== request.id || typeof handle !== 'string' || handle.toLowerCase() !== request.handle.toLowerCase()) throw fail(502, 'Monid 未返回指定推文：{id}', { id: request.id })
  if ((row.status != null && row.status !== 'active') || typeof row.text !== 'string' || !row.text.trim() || !Number.isFinite(Date.parse(row.created_at))) throw fail(502, 'Monid 推文正文不可用：{id}', { id: request.id })
  const textComplete = row.truncated !== true && !/(?:…|\.{3})\s*$/u.test(row.text) && !row.article
  return {
    ...request, text: row.text, createdAt: new Date(row.created_at).toISOString(), textComplete,
    truncated: row.truncated === true, source: 'Monid', sourceField: strategy === 'single' ? 'output.text' : 'output.timeline[].text',
    views: amount(row.views), likes: amount(strategy === 'single' ? row.likes : row.favorites), replies: amount(row.replies),
    reposts: amount(row.retweets), quotes: amount(row.quotes), bookmarks: amount(row.bookmarks),
    kind: row.retweeted ? '转推' : row.reply_to ? '回复' : row.quoted ? '引用' : '原创',
  }
}

function outputOf(result) {
  if (result == null) throw fail(503, '还没有安装 Monid')
  if (result.error) throw fail(502, 'Monid：{message}', { message: String(result.error.message || result.error.code || tr('读取失败')).slice(0, 160) })
  if (result.status === 'BLOCKED') throw fail(402, 'Monid 后台预算限制拒绝了本次读取')
  if (result.status !== 'COMPLETED') throw fail(502, 'Monid 本次运行未完成（{status}）', { status: String(result.status || tr('未知状态')).slice(0, 20) })
  if (result.providerResponse?.httpStatus >= 400 || result.providerResponse?.error || result.output?.error) {
    const error = result.providerResponse?.error || result.output?.error
    const reason = typeof error === 'string' ? error : error?.detail?.message_zh || error?.detail?.message || error?.message || tr('读取失败')
    throw fail(502, 'Monid 原文读取失败（HTTP {status}）：{reason}', {
      status: result.providerResponse?.httpStatus ?? tr('未知状态'), reason: String(reason).slice(0, 200),
    })
  }
  if (!result.output || typeof result.output !== 'object') throw fail(502, 'Monid 未返回原文')
  return result.output
}

function chargedCost(result, estimate) {
  let cost = result?.cost?.value
  const charged = result?.billing?.reportedCost ?? result?.billing?.charged
  if (!Number.isFinite(cost) && Number.isFinite(charged?.value)) cost = charged.unit === 'MICRO_DOLLAR' ? charged.value / 1e6 : charged.value
  return result == null ? 0 : Number.isFinite(cost) && cost >= 0 ? cost : estimate
}

/** Timeline is an explicit capability choice, never a retry after a failed detail read. */
export function createOriginalReader({ dataDir, settings, monid, now = () => new Date(), strategy = 'single', singlePostAvailable = true }) {
  if (!['single', 'timeline'].includes(strategy) || (strategy === 'timeline' && singlePostAvailable !== false) || (strategy === 'single' && !singlePostAvailable)) throw fail(400, '原文读取端点配置无效')
  const endpoint = strategy === 'single' ? ORIGINAL_ENDPOINT : X_ENDPOINT
  const perCallUSD = strategy === 'single' ? ORIGINAL_COST : PAGE_COST
  const budget = new MonidBudget({ dataDir, settings, now })
  const estimate = urls => {
    const requests = requestsFor(urls)
    const maxCalls = strategy === 'single' ? requests.length : new Set(requests.map(row => row.handle.toLowerCase())).size * ORIGINAL_MAX_PAGES
    return { costUSD: Math.round(maxCalls * perCallUSD * 1e6) / 1e6, endpoint, strategy, perCallUSD, maxCalls,
      maxPages: strategy === 'single' ? 1 : ORIGINAL_MAX_PAGES, postCount: requests.length }
  }
  return {
    estimate,
    async readPosts(urls) {
      const requests = requestsFor(urls)
      const found = new Map()
      let costUSD = 0
      let calls = 0
      const call = async query => {
        if (typeof monid !== 'function') throw fail(503, '还没有安装 Monid')
        const result = await budget.run(perCallUSD, () => monid(['run', '-p', 'tikhub', '-e', endpoint, '--query', JSON.stringify(query), '-w', '120', '-j'], 150), now())
        costUSD = Math.round((costUSD + chargedCost(result, perCallUSD)) * 1e6) / 1e6
        calls += 1
        return outputOf(result)
      }
      if (strategy === 'single') {
        for (const request of requests) found.set(request.id, normalizeOriginalPost(await call({ tweet_id: request.id }), request))
      } else {
        const handles = new Map()
        for (const request of requests) {
          const key = request.handle.toLowerCase()
          if (!handles.has(key)) handles.set(key, [])
          handles.get(key).push(request)
        }
        for (const group of handles.values()) {
          let cursor
          const cursors = new Set()
          for (let page = 0; page < ORIGINAL_MAX_PAGES; page += 1) {
            const output = await call({ screen_name: group[0].handle, ...(cursor ? { cursor } : {}) })
            if (!Array.isArray(output.timeline) || (output.status != null && output.status !== 'ok')) throw fail(502, 'Monid 账号时间线不可用')
            // Quoted/pinned snippets are not the requested timeline original.
            for (const request of group) {
              const row = output.timeline.find(row => row.tweet_id === request.id)
              if (row && !found.has(request.id)) found.set(request.id, normalizeOriginalPost(row, request, { strategy }))
            }
            if (group.every(row => found.has(row.id))) break
            cursor = output.next_cursor
            if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) break
            cursors.add(cursor)
          }
          const missing = group.filter(row => !found.has(row.id))
          if (missing.length) throw fail(502, 'Monid 未找到推文（最多读取 {pages} 页）：{ids}', { pages: ORIGINAL_MAX_PAGES, ids: missing.map(row => row.id).join(', ') })
        }
      }
      const posts = requests.map(row => found.get(row.id))
      posts.costUSD = costUSD
      posts.calls = calls
      posts.endpoint = endpoint
      return posts
    },
  }
}
