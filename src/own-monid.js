// 本人账号的 Monid 端点。只收录 2026-11-12 inspect / discover 已看到输入的调用。
// 资料输出只认下面写明的字段；对不上就 profileError，不写正本。单价是预记，账本以返回的 cost 为准。
// 抖音用户搜索 v2 只有 user_id、nick_name，没有抖音号，不能证明展示号。不设解析端点，必须贴主页链接。

const WEEK = 7 * 24 * 60 * 60 * 1000

const unrecognized = () => ({ ok: false, error: '平台返回的内容格式无法识别' })
const mismatch = () => ({ ok: false, error: 'Monid 返回的不是这个账号' })

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function textOf(value, max = 60) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text || [...text].length > max) return ''
  if (/[\u0000-\u001f\u007f\u2028\u2029\\`]/.test(text)) return ''
  return text
}

function sameId(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase()
}

function observed(fields) {
  return { ok: true, displayName: fields.displayName || '', handle: fields.handle || '', url: fields.url || '' }
}

function firstText(nodes, keys, max) {
  for (const node of nodes) {
    for (const key of keys) {
      const text = textOf(node?.[key], max)
      if (text) return text
    }
  }
  return ''
}

function firstId(nodes, keys) {
  for (const node of nodes) {
    for (const key of keys) {
      const value = node?.[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return ''
}

function nodesOf(output) {
  return [output, output?.data, output?.data?.account, output?.account, output?.user].map(asObject).filter(Boolean)
}

// 2026-11-12 inspect：body {username, raw:false}，$0.01。身份只认 username / user_name，名称只认 nickname / name。
function readWechatProfile(output, username) {
  const nodes = nodesOf(output)
  if (!nodes.length) return unrecognized()
  const identity = firstId(nodes, ['username', 'user_name', 'userName'])
  if (!identity) return unrecognized()
  if (!sameId(identity, username)) return mismatch()
  return observed({ displayName: firstText(nodes, ['nickname', 'nick_name', 'name']) })
}

// 2026-11-12 inspect：query {user_url_token}。单价未单列，按同目录文章端点 $0.001 预记。
function readZhihuProfile(output, token) {
  const data = asObject(output?.data) || asObject(output)
  if (!data) return unrecognized()
  const found = data.url_token || data.user_url_token
  if (typeof found !== 'string' || !found.trim()) return unrecognized()
  if (!sameId(found, token)) return mismatch()
  return observed({ displayName: textOf(data.name || data.nickname), handle: found.trim() })
}

// 2026-11-12 inspect：anyapi /github.user，body {handle}。单价按同 provider 仓库端点 $0.0012 预记。
function readGithubProfile(output, handle) {
  const data = asObject(output?.data) || asObject(output)
  if (!data) return unrecognized()
  const login = data.login || data.handle || data.username
  if (typeof login !== 'string' || !login.trim()) return unrecognized()
  if (!sameId(login, handle)) return mismatch()
  const html = typeof data.html_url === 'string' ? data.html_url.replace(/\/$/, '') : ''
  const url = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/.test(html) ? html : ''
  return observed({ displayName: textOf(data.name), handle: login.trim(), url })
}

// 2026-11-12 实测 search_users：data.users[] = {id, red_id, name}。只认 red_id 全等且唯一。
export function readXhsSearch(output, keyword) {
  const users = output?.data?.users
  if (!Array.isArray(users)) return { state: 'unsupported', count: 0 }
  if (users.length && !users.some(row => row && typeof row === 'object' && 'red_id' in row)) return { state: 'unsupported', count: 0 }
  const hits = users.filter(row => row && String(row.red_id) === String(keyword))
  if (hits.length === 1 && /^[0-9a-f]{24}$/i.test(String(hits[0].id || ''))) {
    const id = String(hits[0].id).toLowerCase()
    return { state: 'exact', count: 1, id, name: textOf(hits[0].name), url: `https://www.xiaohongshu.com/user/profile/${id}` }
  }
  if (hits.length === 0) return { state: 'none', count: 0 }
  return { state: 'ambiguous', count: hits.length }
}

// 2026-11-12：query {user_id}。单价按同目录笔记端点 $0.01 预记。没有对得上的内部 ID 就不认。
function readXhsProfile(output, userId) {
  const data = asObject(output?.data) || asObject(output)
  if (!data) return unrecognized()
  const id = data.userid || data.user_id || data.id
  if (typeof id !== 'string' || !id.trim()) return unrecognized()
  if (!sameId(id, userId)) return mismatch()
  const handle = textOf(data.red_id, 32)
  return observed({ displayName: textOf(data.nickname || data.name), handle: /^[A-Za-z0-9_.-]{1,32}$/.test(handle) ? handle : '' })
}

// 2026-11-12：query {sec_user_id}。单价按同目录视频端点 $0.001 预记。不拿昵称当抖音号。
function readDouyinProfile(output, secUid) {
  const user = asObject(output?.user) || asObject(output?.data?.user)
  if (!user || typeof user.sec_uid !== 'string' || !user.sec_uid) return unrecognized()
  if (user.sec_uid !== secUid) return mismatch()
  const handle = typeof user.unique_id === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(user.unique_id) ? user.unique_id : ''
  return observed({ displayName: textOf(user.nickname), handle })
}

// 2026-11-12 inspect：get_user_id query {user_profile_url}，get_user_info query {user_id}，各 $0.001。没有内容列表。
export function readToutiaoUserId(output) {
  const data = asObject(output?.data) || asObject(output)
  const value = data?.user_id ?? data?.userId ?? data?.id
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : ''
  return /^\d{1,20}$/.test(text) ? text : ''
}

function readToutiaoProfile(output, userId) {
  const data = asObject(output?.data) || asObject(output)
  if (!data) return unrecognized()
  const id = readToutiaoUserId(output)
  if (!id) return unrecognized()
  if (id !== String(userId)) return mismatch()
  return observed({ displayName: textOf(data.name || data.screen_name || data.nickname), handle: id })
}

function call(spec) {
  return {
    provider: spec.provider,
    endpoint: spec.endpoint,
    cost: spec.cost,
    body: Boolean(spec.body),
    input: spec.input,
    read: spec.read,
  }
}

export const OWN_ENDPOINTS = {
  公众号: {
    posts: call({ provider: 'tikhub', endpoint: '/api/v1/wechat_mp/v2/fetch_account_articles', cost: 0.01, body: true, input: id => ({ username: id, raw: false }) }),
    profile: call({ provider: 'tikhub', endpoint: '/api/v1/wechat_mp/v2/fetch_account_profile', cost: 0.01, body: true, input: id => ({ username: id, raw: false }), read: readWechatProfile }),
  },
  视频号: {
    posts: call({ provider: 'tikhub', endpoint: '/api/v1/wechat_channels/v2/fetch_user_videos', cost: 0.01, body: true, input: id => ({ username: id, raw: false }) }),
    profile: call({ provider: 'tikhub', endpoint: '/api/v1/wechat_channels/v2/fetch_user_profile', cost: 0.01, body: true, input: id => ({ username: id, raw: false }), read: readWechatProfile }),
  },
  知乎: {
    posts: call({ provider: 'tikhub', endpoint: '/api/v1/zhihu/web/fetch_user_articles', cost: 0.001, input: id => ({ user_url_token: id, limit: '20', offset: '0' }) }),
    profile: call({ provider: 'tikhub', endpoint: '/api/v1/zhihu/web/fetch_user_info', cost: 0.001, input: id => ({ user_url_token: id }), read: readZhihuProfile }),
  },
  YouTube: {
    posts: call({ provider: 'litescrape', endpoint: '/youtube/channel', cost: 0.00015, input: id => ({ channel_id: id, tab: 'videos' }) }),
  },
  Substack: {
    posts: call({ provider: 'litescrape', endpoint: '/substack/posts', cost: 0.00015, input: id => ({ publication: id, limit: 20 }) }),
  },
  LinkedIn: {
    posts: call({ provider: 'apify', endpoint: '/harvestapi/linkedin-profile-posts', cost: 0.01205, body: true, input: id => ({ targetUrls: [id], maxPosts: 5, includeReposts: false, scrapeComments: false, scrapeReactions: false }) }),
  },
  GitHub: {
    posts: call({ provider: 'anyapi', endpoint: '/github.user_repositories', cost: 0.0012, body: true, input: id => ({ handle: id, sort: 'updated' }) }),
    profile: call({ provider: 'anyapi', endpoint: '/github.user', cost: 0.0012, body: true, input: id => ({ handle: id }), read: readGithubProfile }),
  },
  小红书: {
    posts: call({ provider: 'tikhub', endpoint: '/api/v1/xiaohongshu/app_v2/get_user_posted_notes', cost: 0.01, input: id => ({ user_id: id }) }),
    profile: call({ provider: 'tikhub', endpoint: '/api/v1/xiaohongshu/app_v2/get_user_info', cost: 0.01, input: id => ({ user_id: id }), read: readXhsProfile }),
    resolve: call({ provider: 'tikhub', endpoint: '/api/v1/xiaohongshu/app_v2/search_users', cost: 0.01, input: keyword => ({ keyword, page: 1 }), read: readXhsSearch }),
  },
  抖音: {
    posts: call({ provider: 'tikhub', endpoint: '/api/v1/douyin/app/v3/fetch_user_post_videos', cost: 0.001, input: id => ({ sec_user_id: id, count: 20 }) }),
    profile: call({ provider: 'tikhub', endpoint: '/api/v1/douyin/app/v3/handler_user_profile', cost: 0.001, input: id => ({ sec_user_id: id }), read: readDouyinProfile }),
  },
  今日头条: {
    profile: {
      cost: 0.002,
      steps: [
        call({ provider: 'tikhub', endpoint: '/api/v1/toutiao/app/get_user_id', cost: 0.001, input: url => ({ user_profile_url: url }), read: readToutiaoUserId }),
        call({ provider: 'tikhub', endpoint: '/api/v1/toutiao/app/get_user_info', cost: 0.001, input: id => ({ user_id: id }), read: readToutiaoProfile }),
      ],
    },
  },
}

export function monidArgs(spec, input) {
  return ['run', '-p', spec.provider, '-e', spec.endpoint, spec.body ? '-i' : '--query', JSON.stringify(spec.input(input)), '-w', '120', '-j']
}

export function readResolve(platform, output, keyword) {
  const read = OWN_ENDPOINTS[platform]?.resolve?.read
  return read ? read(output, keyword) : { state: 'unsupported', count: 0 }
}

/** 负结果 7 天内、展示号没变，就不再搜索。 */
export function resolveStillFresh(resolve, handle, now) {
  if (!resolve || resolve.handle !== handle) return false
  if (!['none', 'ambiguous', 'unsupported'].includes(resolve.state)) return false
  const at = Date.parse(resolve.at || '')
  const current = now instanceof Date ? now.getTime() : Date.parse(now)
  return Number.isFinite(at) && Number.isFinite(current) && current - at < WEEK
}

/** 一次手动读取的预记上限。小红书尚未解析时，把搜索成功后的内容和资料也算进去。 */
export function estimateManual(accounts) {
  let total = 0
  for (const account of accounts || []) {
    const spec = OWN_ENDPOINTS[account.platform]
    if (!spec) continue
    if (spec.posts && account.identifier) total += spec.posts.cost
    if (spec.resolve && !account.identifier && account.handle) {
      total += spec.resolve.cost + (spec.posts?.cost || 0) + (spec.profile?.cost || 0)
    } else if (spec.profile && (account.identifier || (account.platform === '今日头条' && account.url))) {
      total += spec.profile.cost
    }
  }
  return Math.round(total * 1e6) / 1e6
}
