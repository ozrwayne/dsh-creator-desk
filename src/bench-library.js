// 多平台对标资料库与真实头像/封面同步服务：
// 1. 读取知识库公众号对标与小红书对标样本；
// 2. 读取/写入持久化赛道标签与偏好（bench/prefs.json）；
// 3. 通过 Monid 拉取并本地化缓存 X 真实昵称与头像、公众号头像与封面、小红书头像与笔记封面（bench/media-index.json + files/）。
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { assertPublicUrl } from './harvest.js'
import { newId } from './ops.js'

const WECHAT_DIR = '对标/公众号'
const XHS_DIR = '对标/小红书'
const ASSET_DIR_NAMES = new Set(['_images', 'images', 'assets', 'img', 'media'])
const CACHE_TTL_MS = 30_000
const SAMPLE_PER_ACCOUNT = 10
const MAX_IMG_BYTES = 8 * 1024 * 1024

const STUDY_KEYWORDS = /教育|学习|课程/i
const AI_KEYWORDS = /AI|科技|大模型|Agent|编程|出海|SEO/i

const DISPLAY_NAME_MAP = Object.create(null)

const cache = new Map()

function inferTrack(name = '', bio = '') {
  const text = `${name} ${bio}`
  if (AI_KEYWORDS.test(text)) return 'ai'
  if (STUDY_KEYWORDS.test(text)) return 'study'
  return 'biz'
}

async function readJsonSafe(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

async function writeJsonAtomic(file, data) {
  await mkdir(resolve(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2))
  await rename(tmp, file)
}

export async function readBenchPrefsFile(dataDir) {
  if (!dataDir) return {}
  return readJsonSafe(join(dataDir, 'bench', 'prefs.json'), {})
}

export async function saveBenchPrefsFile(dataDir, accountKey, patch) {
  if (!dataDir || !accountKey || typeof accountKey !== 'string') return {}
  const file = join(dataDir, 'bench', 'prefs.json')
  const current = await readJsonSafe(file, {})
  current[accountKey] = { ...(current[accountKey] || {}), ...(patch || {}) }
  await writeJsonAtomic(file, current)
  cache.clear()
  return current
}

export async function readMediaIndex(dataDir) {
  if (!dataDir) return { accounts: {}, covers: {}, livePosts: [] }
  const raw = await readJsonSafe(join(dataDir, 'bench', 'media-index.json'), {})
  return {
    accounts: raw?.accounts && typeof raw.accounts === 'object' ? raw.accounts : {},
    covers: raw?.covers && typeof raw.covers === 'object' ? raw.covers : {},
    livePosts: Array.isArray(raw?.livePosts) ? raw.livePosts : [],
  }
}

export async function saveMediaIndex(dataDir, index) {
  if (!dataDir) return
  await writeJsonAtomic(join(dataDir, 'bench', 'media-index.json'), index)
  cache.clear()
}

function sniffImageExt(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return '.png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return '.gif'
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return '.webp'
  return null
}

export async function downloadMediaToFiles(rawUrl, filesDir, prefix = 'bm', fetchImpl = fetch) {
  if (!rawUrl || typeof rawUrl !== 'string' || !filesDir) return null
  let current = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl.replace(/^http:\/\//i, 'https://')
  if (!current.startsWith('https://')) return null
  await mkdir(filesDir, { recursive: true })
  try {
    for (let hop = 0; hop < 3; hop += 1) {
      await assertPublicUrl(current)
      const res = await fetchImpl(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
      })
      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString()
        continue
      }
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > MAX_IMG_BYTES) return null
      const ext = sniffImageExt(buf)
      if (!ext) return null
      const filename = `${prefix}-${newId('img')}${ext}`
      await writeFile(join(filesDir, filename), buf)
      return `media-desk/files/${filename}`
    }
  } catch { /* ignore */ }
  return null
}

async function resolveWechatArticleMeta(articleUrl, fetchImpl = fetch) {
  if (!articleUrl || !/^https?:\/\/mp\.weixin\.qq\.com\/s/i.test(articleUrl)) return null
  try {
    let current = articleUrl.replace(/^http:\/\//i, 'https://')
    for (let hop = 0; hop < 3; hop += 1) {
      await assertPublicUrl(current)
      const res = await fetchImpl(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
      })
      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString()
        continue
      }
      if (!res.ok) return null
      const html = await res.text()
      const username = html.match(/user_name\s*[:=]\s*["'](gh_[A-Za-z0-9_]+)["']/)?.[1] || null
      const avatar = (
        html.match(/hd_head_img\s*[:=]\s*["'](https?:\/\/[^"']+)["']/)?.[1] ||
        html.match(/round_head_img\s*[:=]\s*["'](https?:\/\/[^"']+)["']/)?.[1] ||
        html.match(/ori_head_img_url\s*[:=]\s*["'](https?:\/\/[^"']+)["']/)?.[1] ||
        null
      )?.replace(/\\x26amp;/g, '&').replace(/&amp;/g, '&')
      const cover = (
        html.match(/msg_cdn_url\s*[:=]\s*["'](https?:\/\/[^"']+)["']/)?.[1] ||
        html.match(/property=["']og:image["']\s+content=["'](https?:\/\/[^"']+)["']/)?.[1] ||
        null
      )?.replace(/\\x26amp;/g, '&').replace(/&amp;/g, '&')
      return { username, avatar, cover }
    }
  } catch { /* ignore */ }
  return null
}

async function safeSubpath(vaultRoot, rel) {
  if (!vaultRoot || typeof rel !== 'string' || rel.includes('\\') || rel.includes('\0') || rel.startsWith('/')) return null
  const parts = rel.split('/').filter(Boolean)
  if (parts.some(p => p === '.' || p === '..')) return null
  let root
  try { root = await realpath(vaultRoot) } catch { return null }
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      const st = await lstat(current)
      if (st.isSymbolicLink()) return null
      const actual = await realpath(current)
      const child = relative(root, actual)
      if (child === '..' || child.startsWith(`..${sep}`) || resolve(root, child) !== actual) return null
    } catch {
      return null
    }
  }
  return current
}

function cleanWechatBody(raw = '', title = '') {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && line !== '图片' && !/^点击蓝字|^随时跟进最新|^关注公众号|^原创\s/.test(line))
  if (lines[0] && title && lines[0].replace(/\s+/g, '') === title.replace(/\s+/g, '')) lines.shift()
  const text = lines.join('\n\n').slice(0, 2800)
  const excerpt = lines.slice(0, 3).join(' ').replace(/[#>*`!\[\]]/g, '').slice(0, 140)
  return { text, excerpt }
}

async function readWechatArticleDir(dirPath, dirName, accountKey, accountName, relBase) {
  let meta = null
  try {
    meta = JSON.parse(await readFile(join(dirPath, 'metadata.json'), 'utf8'))
  } catch { /* optional */ }
  let bodyRaw = ''
  try {
    bodyRaw = await readFile(join(dirPath, 'content.txt'), 'utf8')
  } catch {
    try {
      const files = await readdir(dirPath)
      const md = files.find(f => f.endsWith('.md'))
      if (md) bodyRaw = await readFile(join(dirPath, md), 'utf8')
    } catch { /* ignore */ }
  }
  if (!meta && !bodyRaw) return null
  const fallbackTitle = dirName.replace(/^\d+[-_.\s]*/, '').trim() || dirName
  const title = String(meta?.title || fallbackTitle).trim()
  const { text, excerpt } = cleanWechatBody(bodyRaw, title)
  const dateStr = meta?.published_date || dirName.match(/^(\d{4})[_-](\d{2})[_-](\d{2})/)?.slice(1, 4).join('-') || null
  const createdAt = dateStr && Number.isFinite(Date.parse(dateStr)) ? new Date(`${dateStr}T12:00:00+08:00`).toISOString() : null
  const mpUrlInBody = bodyRaw.match(/https?:\/\/mp\.weixin\.qq\.com\/s[^\s)"<>]+/)?.[0] || null
  const rawUrl = /^https?:\/\//i.test(meta?.url || '') ? meta.url : mpUrlInBody

  return {
    id: `wx:${accountKey}:${dirName}`,
    platform: '公众号',
    accountKey,
    handle: accountKey,
    displayName: accountName,
    title,
    excerpt: excerpt || text.slice(0, 120),
    text: text || title,
    cover: null,
    url: rawUrl,
    createdAt,
    publishedDay: dateStr || null,
    status: '已存入',
    library: true,
    vaultPath: `${relBase}/${dirName}`,
  }
}

async function scanWechatAccount(vaultRoot, folderName) {
  const relBase = `${WECHAT_DIR}/${folderName}`
  const dir = await safeSubpath(vaultRoot, relBase)
  if (!dir) return null
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return null }
  const visible = entries.filter(e => !e.name.startsWith('.') && !e.name.includes('sync-conflict'))
  const accountKey = `wx-${folderName}`
  const displayName = folderName

  let articleDirs = visible.filter(e => e.isDirectory() && !ASSET_DIR_NAMES.has(e.name.toLowerCase()))
  let mdFiles = visible.filter(e => e.isFile() && e.name.endsWith('.md'))
  let nestedPrefix = relBase

  if (articleDirs.length === 1 && mdFiles.length === 0) {
    const subRel = `${relBase}/${articleDirs[0].name}`
    const subDir = await safeSubpath(vaultRoot, subRel)
    if (subDir) {
      try {
        const subEntries = (await readdir(subDir, { withFileTypes: true })).filter(e => !e.name.startsWith('.'))
        const subDirs = subEntries.filter(e => e.isDirectory() && !ASSET_DIR_NAMES.has(e.name.toLowerCase()))
        const subMds = subEntries.filter(e => e.isFile() && e.name.endsWith('.md'))
        if (subDirs.length > 1 || subMds.length > 0) {
          articleDirs = subDirs.map(e => ({ name: e.name, fullDir: join(subDir, e.name) }))
          mdFiles = subMds.map(e => ({ name: e.name, fullFile: join(subDir, e.name) }))
          nestedPrefix = subRel
        }
      } catch { /* ignore */ }
    }
  }

  const totalCount = articleDirs.length + mdFiles.length
  if (totalCount === 0) return null

  const posts = []
  const sortedAllDirs = [...articleDirs].sort((a, b) => b.name.localeCompare(a.name, 'zh-CN', { numeric: true }))
  const sortedDirs = sortedAllDirs.slice(0, SAMPLE_PER_ACCOUNT)
  for (let idx = 0; idx < sortedDirs.length; idx += 1) {
    const item = sortedDirs[idx]
    const itemDir = item.fullDir || join(dir, item.name)
    const parsed = await readWechatArticleDir(itemDir, item.name, accountKey, displayName, nestedPrefix)
    if (parsed) posts.push(parsed)
  }

  if (posts.length < SAMPLE_PER_ACCOUNT && mdFiles.length > 0) {
    const sortedMds = [...mdFiles].sort((a, b) => b.name.localeCompare(a.name, 'zh-CN', { numeric: true })).slice(0, SAMPLE_PER_ACCOUNT - posts.length)
    for (const item of sortedMds) {
      const fullFile = item.fullFile || join(dir, item.name)
      try {
        const raw = await readFile(fullFile, 'utf8')
        const stem = item.name.replace(/\.md$/i, '')
        const dateMatch = stem.match(/^(\d{4})[_-](\d{2})[_-](\d{2})\s*(.*)$/)
        const title = (dateMatch?.[4] || stem).trim()
        const dateStr = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null
        const { text, excerpt } = cleanWechatBody(raw, title)
        const mpUrl = raw.match(/https?:\/\/mp\.weixin\.qq\.com\/s[^\s)"<>]+/)?.[0] || null
        posts.push({
          id: `wx:${accountKey}:${stem}`,
          platform: '公众号',
          accountKey,
          handle: accountKey,
          displayName,
          title,
          excerpt: excerpt || text.slice(0, 120),
          text: text || title,
          url: mpUrl,
          createdAt: dateStr && Number.isFinite(Date.parse(dateStr)) ? new Date(`${dateStr}T12:00:00+08:00`).toISOString() : null,
          publishedDay: dateStr,
          status: '已存入',
          library: true,
          vaultPath: `${nestedPrefix}/${item.name}`,
        })
      } catch { /* skip unreadable */ }
    }
  }

  const latestAt = posts.map(p => p.createdAt).filter(Boolean).sort().at(-1) || null
  const track = inferTrack(displayName, posts[0]?.title || '')
  let sampleUrl = posts.find(p => p.url)?.url || null
  if (!sampleUrl && sortedAllDirs.length > SAMPLE_PER_ACCOUNT) {
    for (const item of sortedAllDirs.slice(SAMPLE_PER_ACCOUNT, SAMPLE_PER_ACCOUNT + 80)) {
      const itemDir = item.fullDir || join(dir, item.name)
      try {
        const meta = JSON.parse(await readFile(join(itemDir, 'metadata.json'), 'utf8'))
        if (/^https?:\/\/mp\.weixin\.qq\.com\/s/i.test(meta?.url || '')) {
          sampleUrl = meta.url
          break
        }
      } catch { /* skip */ }
    }
  }
  return {
    account: {
      accountKey,
      handle: accountKey,
      displayName,
      platform: '公众号',
      track,
      enabled: true,
      library: true,
      totalCount,
      sampleCount: posts.length,
      sampleArticleUrl: sampleUrl,
      lastReadAt: latestAt,
      path: relBase,
      reason: `知识库已收录 ${totalCount} 篇公众号历史对标文章`,
    },
    posts,
  }
}

function parseXhsRawText(raw, folderName, relPath) {
  const cleanName = folderName.replace(/_分析$/, '').trim()
  const displayName = raw.match(/(?:博主名称|昵称)[：:]\s*([^\r\n]+)/)?.[1]?.trim() || cleanName
  const xhsId = raw.match(/小红书号[：:]\s*([^\r\n]+)/)?.[1]?.trim() || cleanName
  const accountKey = `xhs-${cleanName}`
  const bioMatch = raw.match(/##\s*账号简介\s*([\s\S]*?)(?=^##\s|^---)/m)?.[1]
    || raw.match(/账号介绍[：:]\s*([\s\S]*?)(?=^---)/m)?.[1] || ''
  const bio = bioMatch.split(/\r?\n/).map(s => s.replace(/^[-*\t ]+/, '').trim()).filter(Boolean).join(' · ').slice(0, 180)
  const posts = []

  const blocks = raw.split(/^---\s*$/m).slice(1)
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const title = block.match(/^(?:\*\*)?标题[：:](?:\*\*)?\s*([^\r\n]+)/m)?.[1]?.trim()
    if (!title) continue
    const coverText = block.match(/^(?:\*\*)?封面(?:\/导语)?[：:](?:\*\*)?\s*([^\r\n]+)/m)?.[1]?.trim() || title
    const tagLine = block.match(/^Tag[：:]\s*([^\r\n]+)/im)?.[1]?.trim() || ''
    const tags = [...tagLine.matchAll(/#([^\s#]+)/g)].map(m => m[1]).slice(0, 6)
    const body = block.match(/^正文[：:]\s*([\s\S]*)$/m)?.[1]?.trim() || block.trim()
    posts.push({
      id: `xhs:${accountKey}:${i + 1}`,
      platform: '小红书',
      accountKey,
      handle: xhsId,
      displayName,
      title,
      coverText,
      tags,
      excerpt: body.replace(/\s+/g, ' ').slice(0, 110),
      text: body.slice(0, 2800),
      status: '已存入',
      library: true,
      vaultPath: relPath,
    })
  }

  if (!posts.length) {
    const samples = raw.split(/^###\s+样本\d+[：:]/m).slice(1)
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i]
      const kindLabel = sample.split(/\r?\n/, 1)[0]?.trim() || ''
      const title = sample.match(/\*\*标题[：:]\*\*\s*([^\r\n]+)/)?.[1]?.trim() || kindLabel
      if (!title) continue
      const coverSection = sample.match(/\*\*封面\/导语[：:]\*\*\s*([\s\S]*?)(?=\*\*|$)/)?.[1]?.trim() || ''
      const coverText = coverSection.split(/\r?\n/).filter(Boolean)[0] || title
      const body = sample.replace(/^[^\r\n]+\r?\n/, '').replace(/\*\*/g, '').trim()
      const tags = [...sample.matchAll(/#([^\s#]+)/g)].map(m => m[1]).slice(0, 6)
      posts.push({
        id: `xhs:${accountKey}:s${i + 1}`,
        platform: '小红书',
        accountKey,
        handle: xhsId,
        displayName,
        title,
        coverText,
        tags,
        kind: kindLabel.includes('视频') ? '视频' : '图文',
        excerpt: (coverSection || body).replace(/\s+/g, ' ').slice(0, 110),
        text: body.slice(0, 2800),
        status: '已存入',
        library: true,
        vaultPath: relPath,
      })
    }
  }

  if (!posts.length) return null
  return {
    account: {
      accountKey,
      handle: xhsId,
      displayName,
      platform: '小红书',
      track: inferTrack(displayName, bio),
      enabled: true,
      library: true,
      totalCount: posts.length,
      sampleCount: posts.length,
      lastReadAt: null,
      path: `${XHS_DIR}/${folderName}`,
      reason: bio || `小红书对标拆解样本 ${posts.length} 篇`,
    },
    posts,
  }
}

export async function readBenchLibrary(vaultRoot, { dataDir = null, filesDir = null, force = false } = {}) {
  if (!vaultRoot) return { accounts: [], posts: [], media: { accounts: {}, covers: {} }, prefs: {} }
  const cacheKey = `${vaultRoot}::${dataDir || ''}`
  const hit = cache.get(cacheKey)
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data

  const [media, prefs] = await Promise.all([
    readMediaIndex(dataDir),
    readBenchPrefsFile(dataDir),
  ])

  const accounts = Object.values(media.accounts).filter(account => account?.publicSample === true)
  const posts = []

  const wxRoot = await safeSubpath(vaultRoot, WECHAT_DIR)
  if (wxRoot) {
    try {
      const entries = (await readdir(wxRoot, { withFileTypes: true }))
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      const results = await Promise.all(entries.map(e => scanWechatAccount(vaultRoot, e.name)))
      for (const item of results) {
        if (!item) continue
        const mAcc = media.accounts[item.account.accountKey]
        if (mAcc?.avatar) item.account.avatar = mAcc.avatar
        if (mAcc?.username) item.account.username = mAcc.username
        accounts.push(item.account)
        for (const p of item.posts) {
          if (media.covers[p.id]) p.cover = media.covers[p.id]
          posts.push(p)
        }
      }
    } catch { /* ignore */ }
  }

  const xhsRoot = await safeSubpath(vaultRoot, XHS_DIR)
  if (xhsRoot) {
    try {
      const entries = (await readdir(xhsRoot, { withFileTypes: true }))
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      for (const entry of entries) {
        const relFile = `${XHS_DIR}/${entry.name}/原始数据.txt`
        const rawFile = await safeSubpath(vaultRoot, relFile)
        if (!rawFile) continue
        try {
          const raw = await readFile(rawFile, 'utf8')
          const parsed = parseXhsRawText(raw, entry.name, relFile)
          if (parsed) {
            const mAcc = media.accounts[parsed.account.accountKey]
            if (mAcc?.avatar) parsed.account.avatar = mAcc.avatar
            if (mAcc?.userId) parsed.account.userId = mAcc.userId
            accounts.push(parsed.account)
            for (const p of parsed.posts) {
              if (media.covers[p.id]) p.cover = media.covers[p.id]
              posts.push(p)
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // 合并通过 Monid 实时抓回来的最新带封面笔记/文章（去重）
  const existingIds = new Set(posts.map(p => p.id))
  for (const live of media.livePosts) {
    if (!existingIds.has(live.id)) {
      posts.unshift(live)
      existingIds.add(live.id)
    }
  }

  const data = { accounts, posts, media: { accounts: media.accounts, covers: media.covers }, prefs }
  cache.set(cacheKey, { at: Date.now(), data })
  return data
}

function pickAvatarUrl(obj) {
  if (!obj || typeof obj !== 'object') return null
  for (const key of ['avatar', 'head_img', 'headimg', 'ori_head_img_url', 'round_head_img', 'imageb', 'images', 'image', 'profile_pic', 'profile_image_url_https']) {
    const val = obj[key]
    if (typeof val === 'string' && /^https?:\/\//i.test(val) && !val.includes('default_profile')) return val
  }
  return null
}

/**
 * 按当前选中的账号列表增量同步头像、昵称与最新作品真实封面（遵循平台与赛道筛选范围）。
 */
export async function syncBenchMedia({ monid, dataDir, filesDir, vaultRoot, targets = [] }) {
  if (typeof monid !== 'function' || !dataDir || !filesDir) return { updated: 0 }
  const media = await readMediaIndex(dataDir)
  let updated = 0

  for (const target of targets.slice(0, 12)) {
    const { accountKey, platform, handle, displayName, userId, username, sampleArticleUrl } = target || {}
    if (!accountKey || !platform) continue
    const existing = media.accounts[accountKey] || {}

    try {
      if (platform === 'X' && handle) {
        const clean = String(handle).replace(/^@/, '').trim()
        const res = await monid(['run', '-p', 'tikhub', '-e', '/api/v1/twitter/web/fetch_user_post_tweet', '--query', JSON.stringify({ screen_name: clean }), '-w', '90', '-j'], 110)
        const user = res?.output?.user
        if (user) {
          const realName = typeof user.name === 'string' && user.name.trim() ? user.name.trim() : existing.displayName
          let avatar = existing.avatar
          const rawAv = pickAvatarUrl(user)
          if (rawAv && !avatar) {
            // 把 _normal 换成 _400x400 获取高清推特头像
            const hdAv = rawAv.replace(/_normal(\.[a-z]+)$/i, '_400x400$1')
            avatar = (await downloadMediaToFiles(hdAv, filesDir, `av-x-${clean}`)) || (await downloadMediaToFiles(rawAv, filesDir, `av-x-${clean}`))
          }
          media.accounts[accountKey] = { ...existing, displayName: realName, avatar, handle: clean, updatedAt: new Date().toISOString() }
          updated += 1
        }
      } else if (platform === '小红书') {
        let uid = userId || existing.userId || (/^[0-9a-f]{24}$/i.test(handle || '') ? handle : '')
        if (!uid) {
          const kw = handle && /^\d{6,}$/.test(handle) ? handle : (displayName || handle)
          const searchRes = await monid(['run', '-p', 'tikhub', '-e', '/api/v1/xiaohongshu/app_v2/search_users', '--query', JSON.stringify({ keyword: kw, page: 1 }), '-w', '90', '-j'], 110)
          const users = searchRes?.output?.data?.users || searchRes?.output?.users || []
          const hit = users.find(u => String(u.red_id) === String(kw) || String(u.name || '').includes(displayName || '')) || users[0]
          if (hit?.id && /^[0-9a-f]{24}$/i.test(String(hit.id))) {
            uid = String(hit.id).toLowerCase()
            const rawAv = pickAvatarUrl(hit)
            if (rawAv && !existing.avatar) existing.avatar = await downloadMediaToFiles(rawAv, filesDir, 'av-xhs')
          }
        }
        if (uid) {
          if (!existing.avatar) {
            const profRes = await monid(['run', '-p', 'tikhub', '-e', '/api/v1/xiaohongshu/app_v2/get_user_info', '--query', JSON.stringify({ user_id: uid }), '-w', '90', '-j'], 110)
            const pData = profRes?.output?.data || profRes?.output
            const rawAv = pickAvatarUrl(pData)
            if (rawAv) existing.avatar = await downloadMediaToFiles(rawAv, filesDir, 'av-xhs')
            if (pData?.nickname) existing.displayName = pData.nickname
          }
          const notesRes = await monid(['run', '-p', 'tikhub', '-e', '/api/v1/xiaohongshu/app_v2/get_user_posted_notes', '--query', JSON.stringify({ user_id: uid }), '-w', '90', '-j'], 110)
          const notes = notesRes?.output?.data?.notes || notesRes?.output?.notes || []
          for (const note of notes.slice(0, 8)) {
            if (!note?.id) continue
            const postId = `xhs:${accountKey}:live-${note.id}`
            let cover = media.covers[postId]
            const rawCover = note.images_list?.[0]?.url_size_large || note.images_list?.[0]?.url || note.cover?.url_default || note.cover?.url
            if (rawCover && !cover) {
              cover = await downloadMediaToFiles(rawCover, filesDir, 'cov-xhs')
              if (cover) media.covers[postId] = cover
            }
            const item = {
              id: postId,
              platform: '小红书',
              accountKey,
              handle: handle || uid,
              displayName: existing.displayName || displayName,
              title: note.title || note.display_title || (note.desc || '').split('\n')[0]?.slice(0, 48) || '小红书笔记',
              coverText: note.title || note.display_title || '',
              cover: cover || null,
              kind: note.type === 'video' ? '视频' : '图文',
              excerpt: String(note.desc || '').replace(/\s+/g, ' ').slice(0, 120),
              text: String(note.desc || note.title || ''),
              likes: Number(note.likes ?? note.liked_count) || 0,
              url: `https://www.xiaohongshu.com/explore/${note.id}`,
              createdAt: note.create_time ? new Date(note.create_time * 1000).toISOString() : new Date().toISOString(),
              status: '新',
            }
            media.livePosts = [item, ...media.livePosts.filter(p => p.id !== postId)]
          }
          media.accounts[accountKey] = { ...existing, userId: uid, updatedAt: new Date().toISOString() }
          updated += 1
        }
      } else if (platform === '公众号') {
        let gh = username || existing.username || (/^gh_[A-Za-z0-9_]+$/.test(handle || '') ? handle : '')
        if ((!gh || !existing.avatar) && sampleArticleUrl) {
          const parsedMeta = await resolveWechatArticleMeta(sampleArticleUrl)
          if (parsedMeta?.username && !gh) gh = parsedMeta.username
          if (parsedMeta?.avatar && !existing.avatar) {
            existing.avatar = await downloadMediaToFiles(parsedMeta.avatar, filesDir, 'av-wx')
          }
        }
        if (gh) {
          if (!existing.avatar) {
            const profRes = await monid(['run', '-p', 'tikhub', '-e', '/api/v1/wechat_mp/v2/fetch_account_profile', '-i', JSON.stringify({ username: gh, raw: false }), '-w', '90', '-j'], 110)
            const pNode = profRes?.output?.data?.account || profRes?.output?.data || profRes?.output
            const rawAv = pickAvatarUrl(pNode)
            if (rawAv) existing.avatar = await downloadMediaToFiles(rawAv, filesDir, 'av-wx')
          }
          const artRes = await monid(['run', '-p', 'tikhub', '-e', '/api/v1/wechat_mp/v2/fetch_account_articles', '-i', JSON.stringify({ username: gh, raw: false }), '-w', '90', '-j'], 110)
          const articles = artRes?.output?.data?.articles || artRes?.output?.articles || []
          for (const art of articles.slice(0, 6)) {
            const aid = art.app_msg_id || art.id
            if (!aid) continue
            const postId = `wx:${accountKey}:live-${aid}-${art.idx || 1}`
            let cover = media.covers[postId]
            const rawCover = art.cover || art.cover_url || art.thumb_url || art.pic_url
            if (rawCover && !cover) {
              cover = await downloadMediaToFiles(rawCover, filesDir, 'cov-wx')
              if (cover) media.covers[postId] = cover
            }
            const item = {
              id: postId,
              platform: '公众号',
              accountKey,
              handle: gh,
              displayName: existing.displayName || displayName,
              title: art.title || '公众号文章',
              excerpt: art.digest || art.title || '',
              text: art.digest || art.title || '',
              cover: cover || null,
              url: art.url || art.content_url || null,
              createdAt: art.create_time ? new Date(art.create_time * 1000).toISOString() : new Date().toISOString(),
              publishedDay: art.create_time ? new Date(art.create_time * 1000).toISOString().slice(0, 10) : null,
              views: art.read_count ?? art.view_count ?? null,
              status: '新',
            }
            media.livePosts = [item, ...media.livePosts.filter(p => p.id !== postId)]
          }
          media.accounts[accountKey] = { ...existing, username: gh, updatedAt: new Date().toISOString() }
          updated += 1
        } else if (existing.avatar) {
          media.accounts[accountKey] = { ...existing, updatedAt: new Date().toISOString() }
          updated += 1
        }
      }
    } catch { /* 单个账号失败不阻断其余账号 */ }
  }

  await saveMediaIndex(dataDir, media)
  return { updated, library: await readBenchLibrary(vaultRoot, { dataDir, filesDir, force: true }) }
}
