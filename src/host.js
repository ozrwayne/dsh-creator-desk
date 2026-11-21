// dsh-media-desk host 半片：/media-desk/* 接口、文件服务和模型调用。
import { createReadStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callModel, extractJson, withSelection } from './ai.js'
import { draftReply } from './draft-chat.js'
import { initializeDefaultGallery } from '../scripts/init-demo.mjs'
import { defaultExportDir, resolveExportDir, saveProduction } from './export.js'
import { harvest, harvestText } from './harvest.js'
import { generateImage } from './images.js'
import { generateToolImage, imageTool } from './image-tool.js'
import { applyOps, newId } from './ops.js'
import { Producer } from './produce.js'
import { computeInsights, exportSkill, proposeRules } from './learn.js'
import { createMonidRunner, fetchAccount, importPosts, monidStatus, postsToMaterial, resolveAccount, saveCovers } from './monid.js'

import { publicSettings, Settings, imageReady } from './settings.js'
import { normalizeStyle, stylePrompts } from './style.js'
import { dshHome, Store } from './store.js'
import { currentLang, platformName, tr, withLang } from './i18n.js'
import { localizeSamples, samplesNeedLocale } from './seed.js'
import { IngestQueue, presentIngest, queueAfterArchive } from './ingest.js'
import { Vault } from './vault.js'
import { Pieces } from './pieces.js'
import { buildTodo } from './todo.js'
import { loadStyles, toWechatHtml } from './wechat.js'
import { XRefresh, armRefresh } from './xrefresh.js'
import { createGrokX } from './grokx.js'
import { Bench } from './bench.js'
import { readBenchLibrary, saveBenchPrefsFile, syncBenchMedia } from './bench-library.js'
import { OwnAccounts } from './own.js'
import { Monitor } from './monitor.js'
import { PublishStore } from './publish-map.js'
import { BundleService } from './publish-bundle.js'
import { WechatsyncService } from './wechatsync.js'

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const MAX_JSON = 4_000_000
const MAX_UPLOAD = 250_000_000
const MIME = { '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.woff2': 'font/woff2' }
// SVG 字标仅随包提供；只接受被动媒体上传。
const UPLOAD_EXT = Object.fromEntries(Object.entries(MIME).filter(([ext]) => !['.jpeg', '.woff2', '.svg'].includes(ext)).map(([ext, type]) => [type, ext]))

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBuffer(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error(tr('内容太大')), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const raw = await readBuffer(req, MAX_JSON)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw Object.assign(new Error(tr('请求不是有效的 JSON')), { status: 400 })
  }
}

/** 支持 Range，视频才能正常拖动和循环。 */
async function sendFile(req, res, file) {
  const type = MIME[extname(file).toLowerCase()]
  if (!type) return json(res, 404, { error: tr('不支持的文件类型') })
  let info
  try {
    info = await stat(file)
  } catch {
    return json(res, 404, { error: tr('文件不存在') })
  }
  res.setHeader('content-type', type)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'private, max-age=3600')
  res.setHeader('x-content-type-options', 'nosniff')
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
    if (start >= info.size || start > end) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${info.size}`)
      return res.end()
    }
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${info.size}`)
    res.setHeader('content-length', end - start + 1)
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.statusCode = 200
  res.setHeader('content-length', info.size)
  if (req.method === 'HEAD') return res.end()
  return createReadStream(file).pipe(res)
}

async function extractStyle(ctx, store, body) {
  const urls = (Array.isArray(body.urls) ? body.urls : []).map(row => String(row).trim()).filter(Boolean).slice(0, 5)
  const parts = [String(body.text ?? '').trim()].filter(Boolean)
  const failures = []
  for (const url of urls) {
    try {
      const page = await harvestText(url)
      if (page.text.length >= 80) parts.push(`${page.title ?? ''}\n${page.text}`)
      else failures.push(tr('{url}：页面上几乎没有文字，可能需要登录', { url }))
    } catch (err) {
      failures.push(tr('{url}：{error}', { url, error: err.message }))
    }
  }
  const material = parts.join('\n\n---\n\n')
  if (material.length < 80) {
    throw Object.assign(new Error(failures.length ? tr('无法读取内容：{reason}。可以直接粘贴内容。', { reason: failures[0] }) : tr('内容太少，至少粘贴一段完整的文字')), { status: 400 })
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 20) : ''
  const source = urls.length && parts.length === urls.length ? tr('链接') : urls.length ? tr('内容和链接') : tr('内容')
  return styleFromMaterial(ctx, store, { material, name, source, sourceUrls: urls, failures })
}

/** 提炼一张风格卡并设为当前风格。同一个账号再抓一次时更新原来那张。 */
async function styleFromMaterial(ctx, store, { material, name, source, sourceUrls = [], failures = [], accountKey = null }) {
  let style
  try {
    const { system, user } = stylePrompts(material, name)
    const { text } = await callModel(ctx, { system, user, maxTokens: 1500, light: true, signal: AbortSignal.timeout(120_000) })
    style = normalizeStyle(extractJson(text), name)
  } catch (err) {
    throw Object.assign(new Error(tr('提炼风格需要文字模型：{error}', { error: err.message })), { status: 502 })
  }
  return store.mutate(tr('提炼风格「{name}」', { name: style.name }), (draft) => {
    const existing = accountKey ? (draft.styles ?? []).find(row => row.accountKey === accountKey) : null
    const id = existing?.id ?? newId('st')
    const row = { id, ...style, source, sourceUrls, ...(accountKey ? { accountKey } : {}), createdAt: existing?.createdAt ?? new Date().toISOString() }
    draft.styles = existing ? draft.styles.map(entry => (entry.id === id ? row : entry)) : [row, ...(draft.styles ?? [])]
    draft.activeStyleId = id
    return { id, failures, state: draft }
  })
}

/** 导入用户自己的账号。钱花在 Monid 上，所以先把内容存好，提炼失败也不会白花。 */
async function importAccountRoute(ctx, store, desk, body) {
  if (desk.importing) throw Object.assign(new Error(tr('上一个账号仍在导入，请等导入结束后再试')), { status: 409 })
  desk.importing = true
  try {
    const account = await resolveAccount(body.text)
    const { posts, profile, cost } = await fetchAccount(account, desk.monid)
    const covers = await saveCovers(posts, account.platform, await store.read(), store.filesDir)
    const added = await store.mutate(tr('导入{platform}账号', { platform: platformName(account.platform) }), draft => importPosts(draft, { account, profile, posts, covers }).added)
    const nickname = profile.nickname || platformName(account.platform)
    let styleError = null
    const material = postsToMaterial(posts)
    if (material.length >= 80) {
      try {
        await styleFromMaterial(ctx, store, { material, name: nickname, source: tr('{platform}账号', { platform: platformName(account.platform) }), sourceUrls: [account.url], accountKey: `${account.platform}:${account.id}` })
      } catch (err) {
        styleError = err.message
      }
    } else {
      styleError = tr('这个账号的文字太少，无法提炼风格')
    }
    return { platform: account.platform, nickname, count: posts.length, added, cost, styleName: styleError ? null : nickname, styleError, state: await store.read() }
  } finally {
    desk.importing = false
  }
}

async function addFromUrl(ctx, store, body) {
  const url = String(body.url || '').trim()
  const info = await harvest(url)
  const op = {
    op: 'add_item', kind: 'web', title: body.title || info.title || url, body: body.note || info.description || '', url: info.url, source: info.siteName, tags: Array.isArray(body.tags) ? body.tags : [],
    media: info.image ? { src: info.image } : null,
  }
  return store.mutate(tr('收藏《{title}》', { title: op.title.slice(0, 12) }), (draft) => {
    const { receipts, errors } = applyOps(draft, [op])
    return { receipts, errors, id: receipts[0]?.target, state: draft }
  })
}

async function refreshAccount(store, body) {
  const url = String(body.url || '').trim()
  const now = new Date().toISOString()
  let patch
  try {
    const info = await harvest(url)
    patch = { url: info.url, title: info.title ?? undefined, description: info.description ?? undefined, avatar: info.image ?? undefined, fetchedAt: now, fetchError: '', ...(info.followers ? { followers: info.followers } : {}) }
  } catch (err) {
    patch = { url, fetchedAt: now, fetchError: err.message }
  }
  return store.mutate(tr('更新账号档案'), (draft) => {
    const op = body.id ? { op: 'update_account', id: body.id, ...patch } : { op: 'add_account', platform: body.platform ?? '', handle: body.handle ?? '', ...patch }
    const { errors } = applyOps(draft, [op])
    return { state: draft, errors, fetchError: patch.fetchError || null }
  })
}

async function handleUpload(req, store, res) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const ext = UPLOAD_EXT[type]
  if (!ext) return json(res, 415, { error: tr('不支持这种文件：{type}', { type: type || tr('未知') }) })
  const buffer = await readBuffer(req, MAX_UPLOAD)
  await store.read()
  const name = `${newId('f')}${ext}`
  await writeFile(join(store.filesDir, name), buffer)
  return json(res, 200, { src: `media-desk/files/${name}`, kind: type.startsWith('video/') ? 'video' : 'image' })
}

function intParam(url, key, fallback) {
  const raw = url.searchParams.get(key)
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

export function inboxDaysFrom(body) {
  const raw = body?.days
  if (raw == null || raw === '') return 3
  const n = Number(raw)
  if (!Number.isFinite(n)) return 3
  return Math.min(3660, Math.max(1, Math.trunc(n)))
}

function inboxAfter(body) {
  return new URL(`http://local/inbox?days=${inboxDaysFrom(body)}`)
}

async function vaultOf(desk) {
  const saved = await desk.settings.read()
  return new Vault(saved.vaultRoot, { attachmentIndex: saved.attachmentIndex, dataDir: desk.dataDir })
}

async function inboxPayload(desk, url) {
  const saved = await desk.settings.read()
  const vault = new Vault(saved.vaultRoot, { dataDir: desk.dataDir })
  const positions = (await desk.store.read()).cardPositions || {}
  const limitRaw = url.searchParams.get('limit')
  const daysRaw = url.searchParams.get('days')
  const inbox = await vault.inbox({
    days: daysRaw === 'all' ? 'all' : intParam(url, 'days', 14),
    q: url.searchParams.get('q') ?? '',
    offset: intParam(url, 'offset', 0),
    limit: limitRaw == null || limitRaw === '' ? undefined : intParam(url, 'limit', 30),
    positions,
  })
  return { ...inbox, ingest: presentIngest(await desk.ingest.list()) }
}
async function todoPayload(desk) {
  const board = await piecesOf(desk).board()
  const inbox = await inboxPayload(desk, new URL('http://local/inbox?days=14'))
  const x = desk.xrefresh ? await desk.xrefresh.status().catch(() => null) : null
  const bench = desk.bench ? await desk.bench.read().catch(() => null) : null
  return buildTodo({ board, inbox, now: new Date(), x, bench })
}

function piecesOf(desk) {
  if (!desk.pieces) desk.pieces = new Pieces(desk.settings, { dataDir: desk.dataDir })
  return desk.pieces
}

function xRefreshOf(desk, store) {
  if (!desk.xrefresh) {
    desk.xrefresh = new XRefresh({ dataDir: store.root, settings: desk.settings, pieces: () => piecesOf(desk), run: desk.monid, grokx: grokOf(desk) })
  }
  return desk.xrefresh
}

function grokOf(desk) {
  if (!desk.grokx) desk.grokx = createGrokX({ settings: desk.settings })
  return desk.grokx
}

function benchOf(desk, store) {
  if (!desk.bench) desk.bench = new Bench({
    dataDir: store.root, settings: desk.settings, vault: () => vaultOf(desk),
    grokx: grokOf(desk), monid: desk.monid, ingest: desk.ingest, pieces: () => piecesOf(desk),
  })
  return desk.bench
}

function ownOf(desk, store) {
  if (!desk.own) desk.own = new OwnAccounts({
    dataDir: store.root, settings: desk.settings, vault: () => vaultOf(desk),
    pieces: () => piecesOf(desk), monid: desk.monid, grokx: grokOf(desk),
  })
  return desk.own
}

function monitorOf(desk, store) {
  if (!desk.monitor) {
    const own = ownOf(desk, store), bench = benchOf(desk, store), grokx = grokOf(desk)
    desk.monitor = new Monitor({
      dataDir: store.root, settings: desk.settings, monid: desk.monid, grokx,
      ownAccounts: () => own.accounts(), benchAccounts: () => bench.accounts(),
    })
    own.monitor = desk.monitor
    bench.monitor = desk.monitor
    // 两种 Grok 读取共用采集结果；Monitor 自身保留原读取器，避免递归。
    const monitored = {
      ...grokx,
      listRecent: (handle, options) => desk.monitor.recentX(handle, options),
      readPosts: (urls, options) => desk.monitor.readXPosts(urls, options),
    }
    bench.grokx = monitored
    own.grokx = monitored
    xRefreshOf(desk, store).grokx = monitored
    desk.xrefresh.monitor = desk.monitor
  }
  return desk.monitor
}

function publishStoreOf(desk, store) {
  if (!desk.publishStore) desk.publishStore = new PublishStore(store.root)
  return desk.publishStore
}

function bundleOf(desk, store, ctx) {
  if (!desk.bundle) {
    desk.bundle = new BundleService({
      settings: desk.settings,
      pieces: () => piecesOf(desk),
      publishStore: publishStoreOf(desk, store),
      callText: (callCtx, options) => callModel(callCtx || ctx, options),
    })
  }
  return desk.bundle
}

function wechatsyncOf(desk, store) {
  if (!desk.wechatsync) {
    desk.wechatsync = new WechatsyncService({
      settings: desk.settings,
      pieces: () => piecesOf(desk),
      publishStore: publishStoreOf(desk, store),
    })
  }
  return desk.wechatsync
}

export function armDailyReaders(readers, { setTimeout: timeout = setTimeout, setInterval: interval = setInterval, clearTimeout: clearDelay = clearTimeout, clearInterval: clearRepeat = clearInterval } = {}) {
  let repeat
  let stopped = false
  const check = async () => {
    for (const reader of readers) {
      if (stopped) return
      await reader.checkDaily(new Date()).catch(() => {})
    }
  }
  const delay = timeout(() => {
    if (stopped) return
    void check()
    repeat = interval(() => { void check() }, 10 * 60_000)
    repeat?.unref?.()
  }, 60_000)
  delay?.unref?.()
  return () => { stopped = true; clearDelay(delay); if (repeat) clearRepeat(repeat) }
}

async function sendWechatHtml(res, desk, url) {
  const note = url.searchParams.get('note') ?? ''
  const styleId = url.searchParams.get('style') || 'minimal'
  const piece = await piecesOf(desk).readPiece(note)
  if (!String(piece.lineKey || '').trim() || !String(piece.stage || '').trim()) {
    throw Object.assign(new Error(tr('只能排版受管稿件')), { status: 400 })
  }
  const saved = await desk.settings.read()
  const styles = await loadStyles(saved.wechatStyles)
  const style = styles.find(item => item.id === styleId)
  if (!style) throw Object.assign(new Error(tr('没有这种风格')), { status: 400 })
  const html = toWechatHtml(piece.body || '', style)
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
  res.setHeader('cache-control', 'no-store')
  res.end(html)
}
// 本地演示采用写操作白名单；新增的联网功能不会在演示中自动开放。
const DEMO_POSTS = new Set([
  'draft/chat', 'upload', 'ops', 'undo', 'settings', 'bench/prefs', 'bench/ignore',
  'inbox/archive', 'inbox/archive-batch', 'inbox/card-pos', 'atom/confirm', 'atom/reject', 'atom/save', 'atom/rename',
  'piece/create', 'piece/merge', 'piece/unmerge', 'piece/save', 'piece/status', 'piece/publish', 'piece/unpublish',
  'piece/impressions', 'piece/schedule', 'piece/platforms', 'piece/delete', 'line/delete', 'metrics/import',
  'publish/prepare', 'publish/save-copy', 'publish/place-video', 'publish/backfill', 'publish/x-heading',
])

async function route(ctx, store, desk, req, res) {
  const url = new URL(req.url || '/', 'http://local')
  const path = url.pathname.replace(/^\/media-desk\/?/, '')
  const method = req.method || 'GET'

  if (process.env.MEDIA_DESK_INTEGRATIONS !== '1') {
    if (method === 'GET' && path === 'monid/status') return json(res, 200, { available: false })
    if (method === 'POST' && !DEMO_POSTS.has(path)) return json(res, 403, { error: tr('外部集成未启用') })
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('assets/')) {
    const name = path.slice('assets/'.length)
    if (!/^[\w.-]+$/.test(name)) return json(res, 400, { error: tr('路径无效') })
    return sendFile(req, res, join(ASSETS_DIR, name))
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('files/')) {
    const name = path.slice('files/'.length)
    if (!/^[\w.-]+$/.test(name) || extname(name).toLowerCase() === '.svg') return json(res, 400, { error: tr('路径无效') })
    await store.read()
    return sendFile(req, res, join(store.filesDir, name))
  }
  if (method === 'GET') {
    if (path === 'state') {
      if (!desk.settled) { desk.settled = true; await desk.producer.settleAll().catch(() => {}) }
      let state = await store.read()
      // 示例数据跟着界面语言走；用户自己的内容不动
      if (samplesNeedLocale(state, currentLang())) state = await store.mutate('', draft => (localizeSamples(draft, currentLang()), draft), { undoable: false })
      return json(res, 200, { state, canUndo: store.undo.length > 0 })
    }
    if (path === 'production') {
      const id = url.searchParams.get('id') ?? ''
      await desk.producer.settle(id)
      const state = await store.read()
      const item = state.items.find(row => row.id === id)
      return json(res, 200, { production: item?.production ?? null, status: item?.status, live: desk.producer.status(id) })
    }
    if (path === 'settings') return json(res, 200, { ...publicSettings(await desk.settings.read(), Boolean(imageTool(ctx))), defaultExportDir: defaultExportDir() })

    if (path === 'insights') return json(res, 200, computeInsights(await store.read()))
    if (path === 'monid/status') return json(res, 200, await monidStatus(desk.monid))
    if (path === 'inbox') return json(res, 200, await inboxPayload(desk, url))
    if (path === 'inbox/item') return json(res, 200, await (await vaultOf(desk)).item(url.searchParams.get('id') ?? ''))
    if (path === 'inbox/image') {
      const file = await new Vault((await desk.settings.read()).vaultRoot).imageFile(url.searchParams.get('name') ?? '')
      return sendFile(req, res, file)
    }
    if (path === 'board') return json(res, 200, await piecesOf(desk).board())
    if (path === 'todo') return json(res, 200, await todoPayload(desk))
    if (path === 'piece') {
      const piece = await piecesOf(desk).readPiece(url.searchParams.get('note') ?? '')
      const xSnapshot = desk.xrefresh ? await desk.xrefresh.latest(piece.note).catch(() => null) : null
      return json(res, 200, xSnapshot ? { ...piece, xSnapshot } : piece)
    }
    if (path === 'wechat/styles') {
      const saved = await desk.settings.read()
      const styles = await loadStyles(saved.wechatStyles)
      return json(res, 200, { styles: styles.map(({ id, name, scene, recommended }) => ({ id, name, scene, recommended })) })
    }
    if (path === 'wechat/html') return sendWechatHtml(res, desk, url)
    if (path === 'x/status') return json(res, 200, await xRefreshOf(desk, store).status())
    if (path === 'bench') return json(res, 200, await benchOf(desk, store).read())
    if (path === 'bench/library') {
      const saved = await desk.settings.read()
      await store.read()
      return json(res, 200, await readBenchLibrary(saved.vaultRoot, { dataDir: store.root, filesDir: store.filesDir, force: url.searchParams.get('force') === '1' }))
    }
    if (path === 'own/accounts') return json(res, 200, await ownOf(desk, store).read())
    if (path === 'own/posts') return json(res, 200, await ownOf(desk, store).posts(url.searchParams.get('id') ?? ''))
    if (path === 'own/metrics') return json(res, 200, { metrics: await ownOf(desk, store).latest(url.searchParams.get('note') ?? '') })
    if (path.startsWith('monitor/')) {
      const monitor = monitorOf(desk, store), query = Object.fromEntries(url.searchParams)
      const method = { 'monitor/accounts': 'listAccounts', 'monitor/posts': 'listPosts', 'monitor/series': 'series', 'monitor/followers': 'followers', 'monitor/cohort': 'cohort', 'monitor/status': 'status' }[path]
      if (method) return json(res, 200, await monitor[method](query))
    }
    if (path === 'publish/status') return json(res, 200, await bundleOf(desk, store, ctx).status(url.searchParams.get('note') ?? ''))
    if (path === 'publish/bundle.zip') {
      const { filename, buffer } = await bundleOf(desk, store, ctx).exportBundleZip({ note: url.searchParams.get('note') ?? '' })
      res.statusCode = 200
      res.setHeader('content-type', 'application/zip')
      res.setHeader('content-length', buffer.length)
      res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      res.setHeader('cache-control', 'no-store')
      return res.end(buffer)
    }
    if (path === 'publish/video') {
      const { file, filename } = await bundleOf(desk, store, ctx).videoFileFor({ note: url.searchParams.get('note') ?? '' })
      const inline = url.searchParams.get('inline') === '1' && MIME[extname(file).toLowerCase()]?.startsWith('video/')
      const disposition = inline ? 'inline' : 'attachment'
      res.setHeader('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`)
      return sendFile(req, res, file)
    }
    if (path === 'publish/maitian-extension.zip') {
      const { filename, buffer } = await bundleOf(desk, store, ctx).exportMaitianZip()
      res.statusCode = 200
      res.setHeader('content-type', 'application/zip')
      res.setHeader('content-length', buffer.length)
      res.setHeader('content-disposition', `attachment; filename="${filename}"`)
      res.setHeader('cache-control', 'no-store')
      return res.end(buffer)
    }
    if (path === 'wechatsync/status') {
      return json(res, 200, await wechatsyncOf(desk, store).status({
        refreshPlatforms: url.searchParams.get('refresh') === '1',
        clientId: url.searchParams.get('clientId') || '',
        callerIp: req.socket?.remoteAddress || '',
      }))
    }
    if (path === 'wechatsync/records') return json(res, 200, await wechatsyncOf(desk, store).records(url.searchParams.get('note') ?? ''))
    if (path === 'wechatsync/job') return json(res, 200, wechatsyncOf(desk, store).job(url.searchParams.get('id') ?? ''))
    return json(res, 404, { error: tr('接口不存在') })
  }
  if (method !== 'POST') return json(res, 405, { error: tr('不支持的方法') })

  // 所有写操作都拒绝跨站请求
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: tr('拒绝跨站请求') })

  if (path === 'upload') return handleUpload(req, store, res)
  const body = await readJson(req)
  switch (path) {
    case 'monitor/account': return json(res, 200, await monitorOf(desk, store).saveAccount(body))
    case 'monitor/refresh': return json(res, 200, await monitorOf(desk, store).startRefresh(body))
    case 'bench/account': return json(res, 200, await benchOf(desk, store).addAccount(body))
    case 'bench/account/toggle': return json(res, 200, await benchOf(desk, store).toggleAccount(body))
    case 'bench/refresh': return json(res, 200, await benchOf(desk, store).startRefresh(body))
    case 'bench/import-history': return json(res, 200, await benchOf(desk, store).importHistory())
    case 'bench/estimate': return json(res, 200, await benchOf(desk, store).estimateSave(body))
    case 'bench/save': return json(res, 200, await benchOf(desk, store).save(body))
    case 'bench/ignore': return json(res, 200, await benchOf(desk, store).ignore(body))
    case 'bench/wiki': return json(res, 200, await benchOf(desk, store).wiki(body))
    case 'bench/prefs': {
      await store.read()
      const prefs = await saveBenchPrefsFile(store.root, String(body.accountKey || ''), body.patch || {})
      return json(res, 200, { prefs })
    }
    case 'bench/sync-media': {
      const saved = await desk.settings.read()
      await store.read()
      const result = await syncBenchMedia({
        monid: desk.monid,
        dataDir: store.root,
        filesDir: store.filesDir,
        vaultRoot: saved.vaultRoot,
        targets: Array.isArray(body.targets) ? body.targets : [],
      })
      return json(res, 200, result)
    }
    case 'own/account': return json(res, 200, await ownOf(desk, store).saveAccount(body))
    case 'own/refresh': return json(res, 200, await ownOf(desk, store).startRefresh({ ...body, manual: true }))
    case 'ops': {
      const label = typeof body.label === 'string' ? body.label : tr('操作')
      const result = await store.mutate(label, (draft) => {
        const applied = applyOps(draft, body.ops)
        return { ...applied, state: draft }
      }, { undoable: body.undoable !== false })
      return json(res, 200, result)
    }
    case 'undo': {
      const label = await store.undoLast()
      return json(res, 200, { label, state: await store.read(), canUndo: store.undo.length > 0 })
    }
    case 'draft/chat': {
      const closed = new AbortController()
      const cancel = () => closed.abort()
      res.once('close', cancel)
      try {
        const reply = await draftReply(ctx, body, AbortSignal.any([closed.signal, AbortSignal.timeout(120000)]))
        if (!res.destroyed) return json(res, 200, reply)
        return
      } finally { res.off('close', cancel) }
    }
    case 'produce': {
      const started = await desk.producer.start(String(body.id))
      return json(res, 200, { started, state: await store.read() })
    }
    case 'produce/cancel':
      await desk.producer.cancel(String(body.id))
      return json(res, 200, { ok: true })
    case 'produce/regen':
      await desk.producer.regenerate(String(body.id), body.target)
      return json(res, 200, { state: await store.read() })
    case 'produce/save': {
      const settings = await desk.settings.read()
      const state = await store.read()
      const item = state.items.find(row => row.id === body.id)
      if (!item?.production?.article) return json(res, 400, { error: tr('还没有可以保存的成稿') })
      await store.read()
      // 视频封面由浏览器合成（画面叠大字），这里只接受 JPEG
      const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(body.videoCover ?? '')
      const videoCover = match ? Buffer.from(match[1], 'base64') : null
      if (videoCover && !(videoCover[0] === 0xff && videoCover[1] === 0xd8)) return json(res, 400, { error: tr('封面不是有效的图片') })
      const saved = await saveProduction(item.production, { filesDir: store.filesDir, exportDir: resolveExportDir(settings.exportDir), videoCover })
      const next = await store.mutate('保存成稿', (draft) => {
        const target = draft.items.find(row => row.id === body.id)
        if (target?.production) {
          target.production.savedPath = saved.path
          target.production.savedAt = new Date().toISOString()
        }
        return draft
      }, { undoable: false })
      return json(res, 200, { ...saved, state: next })
    }
    case 'produce/reveal': {
      // 路径只取自保存记录，不接受请求里传来的路径
      const state = await store.read()
      const path = state.items.find(row => row.id === body.id)?.production?.savedPath
      if (!path) return json(res, 400, { error: tr('还没有保存过') })
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
      execFile(command, [path], () => {})
      return json(res, 200, { path })
    }
    case 'style/extract': return json(res, 200, await extractStyle(ctx, store, body))
    case 'monid/import': return json(res, 200, await importAccountRoute(ctx, store, desk, body))
    case 'settings': {
      if (process.env.MEDIA_DESK_INTEGRATIONS !== '1' && (body.publish?.wechatsyncEnabled || body.publish?.wechatsyncAllowTailscale || body.xRefresh?.enabled || body.exportDir || body.publish?.bundleDir)) return json(res, 403, { error: tr('外部集成未启用') })
      const updated = await desk.settings.update(body)
      if (body.publish && (desk.wechatsync || !process.env.NODE_TEST_CONTEXT)) {
        await wechatsyncOf(desk, store).ensureStarted().catch(() => {})
      }
      return json(res, 200, { ...publicSettings(updated, Boolean(imageTool(ctx))), defaultExportDir: defaultExportDir() })
    }
    case 'settings/test': {
      const settings = await desk.settings.read()
      if (!desk.producer.ready(settings)) return json(res, 400, { error: tr(settings.image.source === 'tool' ? '未找到订阅生图工具，或默认执行器不支持直接调用；请检查插件和执行器后刷新工作台' : '先填好接口地址、模型和密钥') })
      await store.read()
      const { buffer, ext } = await desk.producer.generate(settings.image, 'A single paper boat on calm water, black and white pencil line art sketch, plain white paper background, no text.')
      const name = `${newId('t')}${ext}`
      await writeFile(join(store.filesDir, name), buffer)
      return json(res, 200, { src: `media-desk/files/${name}` })
    }
    case 'capture-url': return json(res, 200, await addFromUrl(ctx, store, body))
    case 'account/refresh': return json(res, 200, await refreshAccount(store, body))
    case 'skills/learn': {
      const proposals = proposeRules(await store.read())
      if (!proposals.length) return json(res, 200, { added: 0, state: await store.read() })
      const state = await store.mutate(tr('从数据中学习'), (draft) => {
        // 只用示例数据算出来的建议也算示例，清空示例时一起清掉，也不会被导出
        const fromSamples = !draft.metrics.some(metric => !metric.sample)
        const { receipts } = applyOps(draft, proposals.map(row => ({ op: 'add_skill', ...row, status: 'proposed' })))
        if (fromSamples) for (const receipt of receipts) { const skill = draft.skills.find(row => row.id === receipt?.target); if (skill) skill.sample = true }
        return draft
      })
      return json(res, 200, { added: proposals.length, state })
    }
    case 'skills/export': {
      const state = await store.read()
      const result = await exportSkill(state, dshHome())
      const next = await store.mutate('导出 Skill', (draft) => {
        applyOps(draft, draft.skills.filter(s => !s.sample && s.status === 'active').map(s => ({ op: 'update_skill', id: s.id, status: 'exported' })))
        return draft
      }, { undoable: false })
      return json(res, 200, { ...result, state: next })
    }
    case 'inbox/archive': {
      const vault = await vaultOf(desk)
      const moved = await vault.archive(String(body.id ?? ''))
      if (process.env.MEDIA_DESK_INTEGRATIONS === '1') await queueAfterArchive(desk.ingest, vault, moved)
      return json(res, 200, await inboxPayload(desk, inboxAfter(body)))
    }
    case 'inbox/archive-batch': {
      const vault = await vaultOf(desk)
      const { archived, failed } = await vault.archiveMany(body.ids)
      for (const moved of archived) if (process.env.MEDIA_DESK_INTEGRATIONS === '1') await queueAfterArchive(desk.ingest, vault, moved)
      return json(res, 200, { archived, failed, inbox: await inboxPayload(desk, inboxAfter(body)) })
    }
    case 'ingest/retry':
      await desk.ingest.retry(String(body.id ?? ''))
      return json(res, 200, await inboxPayload(desk, inboxAfter(body)))
    case 'atom/confirm':
      await (await vaultOf(desk)).confirm(String(body.id ?? ''))
      return json(res, 200, await inboxPayload(desk, inboxAfter(body)))
    case 'atom/reject':
      await (await vaultOf(desk)).reject(String(body.id ?? ''))
      return json(res, 200, await inboxPayload(desk, inboxAfter(body)))
    case 'atom/save':
      await (await vaultOf(desk)).save(body)
      return json(res, 200, await inboxPayload(desk, inboxAfter(body)))
    case 'atom/rename': {
      const vault = await vaultOf(desk)
      const renamed = await vault.rename(body)
      if (renamed.fromNote !== renamed.toNote) await piecesOf(desk).rewriteSources(renamed.fromNote, renamed.toNote)
      return json(res, 200, { ...(await inboxPayload(desk, inboxAfter(body))), id: renamed.id, title: renamed.title })
    }
    case 'inbox/card-pos': {
      const { id, pos } = body
      if (typeof id !== 'string' || !/^(fav|atom):/.test(id) || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) throw Object.assign(new Error(tr('位置无效')), { status: 400 })
      await store.mutate(tr('移动卡片'), state => { (state.cardPositions ??= {})[id] = { x: pos.x, y: pos.y, r: Number.isFinite(pos.r) ? pos.r : 0 } }, { undoable: false })
      return json(res, 200, { ok: true })
    }
    case 'piece/create': return json(res, 200, await piecesOf(desk).create(body))
    case 'piece/merge': return json(res, 200, await piecesOf(desk).merge(body))
    case 'piece/unmerge': return json(res, 200, await piecesOf(desk).unmerge(body))
    case 'piece/save': return json(res, 200, await piecesOf(desk).saveBody(body))
    case 'piece/status': return json(res, 200, await piecesOf(desk).setStatus(body))
    case 'piece/publish': return json(res, 200, await piecesOf(desk).publish(body))
    case 'piece/unpublish': return json(res, 200, await piecesOf(desk).unpublish(body))
    case 'piece/impressions': return json(res, 200, await piecesOf(desk).setImpressions(body))
    case 'piece/schedule': return json(res, 200, await piecesOf(desk).setSchedule(body))
    case 'piece/platforms': return json(res, 200, await piecesOf(desk).setPlatforms(body))
    case 'piece/open': return json(res, 200, await piecesOf(desk).open(body.note))
    case 'piece/delete': return json(res, 200, await piecesOf(desk).deletePiece(body.note))
    case 'line/delete': return json(res, 200, await piecesOf(desk).deleteLine(body.key))
    case 'metrics/import': {
      const imported = await piecesOf(desk).importMetrics(body.csv)
      try {
        const monitor = await monitorOf(desk, store).importCsv(body.csv, imported.pieces)
        return json(res, 200, { ...imported, monitor })
      } catch (error) {
        // 稿件导入已经成功；单独报告监控留存失败，不能让用户误以为需要重复导入。
        return json(res, 200, { ...imported, monitorError: tr(error.message) })
      }
    }
    case 'x/refresh': {
      const x = await xRefreshOf(desk, store).startRefresh({ via: body.via })
      return json(res, 200, { x, board: await piecesOf(desk).board() })
    }
    case 'x/settings': return json(res, 200, await xRefreshOf(desk, store).updateSettings(body))
    case 'x/suggestion': return json(res, 200, await xRefreshOf(desk, store).suggestion(body))
    case 'publish/prepare': {
      const result = await bundleOf(desk, store, ctx).prepare(body)
      return json(res, 200, { ...result, piece: await piecesOf(desk).readPiece(String(body.note ?? '')), board: await piecesOf(desk).board() })
    }
    case 'publish/save-copy': return json(res, 200, await bundleOf(desk, store, ctx).saveCopy(body))
    case 'publish/generate-copy': return json(res, 200, await bundleOf(desk, store, ctx).generateCopy(ctx, body))
    case 'publish/place-video': {
      if (process.env.MEDIA_DESK_INTEGRATIONS !== '1') {
        const { workspaceRoot } = await desk.settings.read()
        const source = await realpath(String(body.sourcePath ?? ''))
        if (!source.startsWith(await realpath(workspaceRoot) + sep)) return json(res, 403, { error: tr('路径无效') })
      }
      return json(res, 200, await bundleOf(desk, store, ctx).placeVideo(body))
    }
    case 'publish/reveal': return json(res, 200, await bundleOf(desk, store, ctx).reveal(body))
    case 'publish/backfill': {
      const result = await bundleOf(desk, store, ctx).backfill(body)
      return json(res, 200, { ...result, board: await piecesOf(desk).board() })
    }
    case 'publish/x-heading': {
      const result = await bundleOf(desk, store, ctx).ensureXHeading(body)
      return json(res, 200, { ...result, board: await piecesOf(desk).board() })
    }
    case 'wechatsync/token': {
      const tokenData = await wechatsyncOf(desk, store).generateToken()
      const settingsPayload = { ...publicSettings(await desk.settings.read(), Boolean(imageTool(ctx))), defaultExportDir: defaultExportDir() }
      return json(res, 200, { ...tokenData, settings: settingsPayload })
    }
    case 'wechatsync/unlock': {
      await wechatsyncOf(desk, store).resetExtensionLock()
      const settingsPayload = { ...publicSettings(await desk.settings.read(), Boolean(imageTool(ctx))), defaultExportDir: defaultExportDir() }
      return json(res, 200, { ok: true, settings: settingsPayload })
    }
    case 'wechatsync/sync': return json(res, 200, await wechatsyncOf(desk, store).startSync({ ...body, callerIp: req.socket?.remoteAddress || '' }))
    default: return json(res, 404, { error: tr('接口不存在') })
  }
}

/**
 * Web 服务不会替插件路由鉴权，所以每个请求都要自己走一遍 Host/Origin 和登录凭证检查。
 * 拿不到鉴权服务时一律拒绝。
 * @param {object} ctx - Cordis 上下文。
 * @param {{headers: object}} req - HTTP 请求。
 * @returns {number|undefined} 拒绝时的状态码；可以继续时为 undefined。
 */
export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
  return connection.requestRejection({ headers: req.headers })
}

export const name = 'dsh-media-desk'

export default {
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const store = new Store()
    const settings = new Settings(store.root)
    let galleryReady
    const producer = new Producer({
      store, settings, callText: options => callModel(ctx, options),
      ready: saved => imageReady(saved, Boolean(imageTool(ctx))),
      generate: (image, prompt, options) => image.source === 'tool' ? generateToolImage(ctx, image, prompt, options) : generateImage(image, prompt, options),
    })
    const monid = createMonidRunner()
    const ingest = new IngestQueue({
      dataDir: store.root,
      context: async () => {
        const saved = await settings.read()
        return { logDir: saved.logDir, script: saved.ingestScript }
      },
    })
    const desk = { store, dataDir: store.root, settings, producer, monid, ingest }
    desk.xrefresh = new XRefresh({ dataDir: store.root, settings, pieces: () => piecesOf(desk), run: monid, grokx: grokOf(desk) })
    benchOf(desk, store)
    ownOf(desk, store)
    monitorOf(desk, store)
    // 测试进程里不武装定时器，避免扫到真实知识库并调用外部接口
    if (!process.env.NODE_TEST_CONTEXT && process.env.MEDIA_DESK_INTEGRATIONS === '1') {
      desk.monitor.bootstrap().catch(() => {}) // 错误通过 monitor/status 呈现；不触发网络采集
      ctx.effect(() => armRefresh(desk.xrefresh), 'dsh-media-desk: x refresh')
      ctx.effect(() => armDailyReaders([desk.monitor]), 'dsh-media-desk: daily checks')
      ctx.effect(() => {
        wechatsyncOf(desk, store).ensureStarted().catch(() => {})
        return () => { desk.wechatsync?.stop().catch(() => {}) }
      }, 'dsh-media-desk: wechatsync')
    } else {
      ctx.effect(() => () => { desk.wechatsync?.stop().catch(() => {}) }, 'dsh-media-desk: wechatsync')
    }
    if (process.env.MEDIA_DESK_INTEGRATIONS === '1') {
      ingest.recover().catch(() => {})
    }
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/media-desk',
      handler: async (req, res) => {
        try {
          const rejection = requestRejection(ctx, req)
          if (rejection) {
            json(res, rejection, { error: tr('未授权') })
            return
          }
          await (galleryReady ??= initializeDefaultGallery())
          await withLang(req.headers['x-media-desk-lang'], () => withSelection(req.headers['x-media-desk-selection'], () => route(ctx, store, desk, req, res)))
        } catch (err) {
          if (res.headersSent) {
            res.end()
            return
          }
          // pieces.js 等模块抛出的是中文原文，这里按请求的语言查英文词典
          json(res, err.status || 500, { error: withLang(req.headers['x-media-desk-lang'], () => tr(err.message)) })
        }
      },
    }), 'dsh-media-desk: /media-desk routes')
  },
}
