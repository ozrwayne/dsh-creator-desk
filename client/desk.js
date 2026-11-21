import { selectedRoute } from './dsh.js'
// 浏览器侧的状态：Host 状态的本地镜像，加上只属于界面的选中、视图等。
import React from 'react'
import { coverDataUrl } from './cover.js'
import { lang, plural, setLanguagePreference, t } from './i18n.js'

const BASE = 'media-desk/'
const PALETTE_KEY = 'dsh-media-desk-palette'

export const PALETTES = [
  { id: 'warm', zh: '大地暖调', en: 'Warm Earth', subZh: '燕麦暖驼 · 焦糖鞍皮', subEn: 'Warm Oat & Cognac Leather', c1: '#DFD1BD', c2: '#B45522' },
  { id: 'jade', zh: '翡翠松石', en: 'Celadon Jade', subZh: '香槟暖石 · 深翠铜金', subEn: 'Champagne Stone & Deep Jade', c1: '#D6D3C9', c2: '#006564' },
  { id: 'jacaranda', zh: '蓝花楹', en: 'Jacaranda', subZh: '暖金砂岩 · 暮紫鎏金', subEn: 'Warm Sandstone & Royal Violet', c1: '#DED3C4', c2: '#51247A' },
  { id: 'cool', zh: '极简基准', en: 'Minimal Base', subZh: '冷灰底板 · 石板曜黑', subEn: 'Cool Slate & Crisp White', c1: '#E2E8F0', c2: '#0F172A' },
]

function readSavedPalette() {
  try {
    const saved = localStorage.getItem(PALETTE_KEY)
    return PALETTES.some(p => p.id === saved) ? saved : 'warm'
  } catch {
    return 'warm'
  }
}

let snapshot = {
  state: null, canUndo: false, error: null,
  palette: readSavedPalette(),
  view: 'home', mode: 'scatter', focusId: null, sheetOrigin: null, studioDock: false, chatQuote: null, query: '', kindFilter: 'all', related: null,
  inbox: null, atomOpen: null, atomTab: 'fav', pendingQ: '', pendingTraffic: 'all', pendingValue: 'all', pendingSort: 'new', atomLine: 'all',
  flowFocus: null, ownOpen: null, todo: null,
  live: {}, settings: null, settingsOpen: false, thinking: false, toast: null, capture: null, dialog: null,
}
const listeners = new Set()

export function getDesk() {
  return snapshot
}

export function setDesk(patch) {
  snapshot = { ...snapshot, ...(typeof patch === 'function' ? patch(snapshot) : patch) }
  listeners.forEach(fn => fn())
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// 选择器里写 `x || []` 每次都返回新数组，useSyncExternalStore 会判定状态一直在变而无限重渲染。
// 空数组统一换成同一个对象，数据还没加载时页面才不会崩。
const EMPTY = Object.freeze([])

export function useDesk(selector) {
  return React.useSyncExternalStore(subscribe, () => {
    const value = selector(snapshot)
    return Array.isArray(value) && value.length === 0 ? EMPTY : value
  })
}

const MODEL_ACTIONS = new Set(['draft/chat', 'produce', 'produce/regen', 'publish/generate-copy', 'style/extract'])
export async function request(path, body, signal) {
  const route = body !== undefined && MODEL_ACTIONS.has(path) ? await selectedRoute() : null
  const res = await fetch(BASE + path, body === undefined ? { headers: { 'x-media-desk-lang': lang() } } : {
    method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-media-desk-lang': lang(), ...(route && { 'x-media-desk-selection': encodeURIComponent(JSON.stringify(route)) }) }, body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || t('请求失败（{status}）', { status: res.status }))
    err.status = res.status
    throw err
  }
  return data
}

let toastTimer = null
export function toast(text, { undo = false, error = false } = {}) {
  clearTimeout(toastTimer)
  setDesk({ toast: { text, undo, error, key: Date.now() } })
  toastTimer = setTimeout(() => setDesk({ toast: null }), undo || text.length > 24 ? 6000 : 3200)
}

export function report(err) {
  toast(err.message || String(err), { error: true })
}

function leafFolder(folder) {
  const parts = String(folder || '').split('/').filter(Boolean)
  return parts.at(-1) || ''
}
export async function loadDesk() {
  try {
    // 先读设置拿到语言偏好，示例数据按这个语言返回
    const settings = await request('settings')
    setLanguagePreference(settings.language)
    const data = await request('state')
    setDesk({ settings, state: data.state, canUndo: data.canUndo, error: null })
  } catch (err) {
    setDesk({ error: err.message })
  }
}

export async function dispatchOps(ops, { label = t('操作'), undoable = true, silent = false } = {}) {
  try {
    const data = await request('ops', { ops, label, undoable })
    setDesk({ state: data.state, canUndo: undoable || snapshot.canUndo })
    if (data.errors?.length) toast(data.errors[0], { error: true })
    else if (!silent && data.receipts?.[0]) toast(data.receipts[0].text, { undo: undoable })
    return data
  } catch (err) {
    report(err)
    return null
  }
}

export async function undo() {
  try {
    const data = await request('undo', {})
    setDesk({ state: data.state, canUndo: data.canUndo, toast: null })
    if (data.label) toast(t('已撤销：{label}', { label: data.label }))
  } catch (err) {
    report(err)
  }
}

export function openItem(id, origin = null) {
  setDesk({ focusId: id, sheetOrigin: origin })
}

export function closeItem() {
  setDesk({ focusId: null, sheetOrigin: null, studioDock: false, chatQuote: null })
}

/** 一键成稿停用：按钮和已有成稿都留着，改造完成前不发请求。助手里的 produce 动作也走这里。 */
export async function runProduce() {
  toast(t('一键成稿正在改造，暂不可用'))
}

export async function cancelProduce(id) {
  try {
    await request('produce/cancel', { id })
  } catch (err) {
    report(err)
  }
}

/** 重画停用，和一键成稿同一个原因。 */
export async function regenAsset() {
  toast(t('一键成稿正在改造，暂不可用'))
}

function mergeProduction(id, production, status) {
  setDesk(s => ({ state: { ...s.state, items: s.state.items.map(item => (item.id === id ? { ...item, production, ...(status ? { status } : {}) } : item)) } }))
}

/** 轮询进度，返回停止函数。 */
export function watchProduction(id) {
  let stopped = false
  const tick = async () => {
    while (!stopped) {
      try {
        const data = await request(`production?id=${encodeURIComponent(id)}`)
        if (stopped) return
        setDesk(s => ({ live: { ...s.live, [id]: data.live } }))
        if (data.production) mergeProduction(id, data.production, data.status)
      } catch {
        // 连接抖动时下一轮再试
      }
      await new Promise(r => setTimeout(r, 700))
    }
  }
  tick()
  return () => { stopped = true }
}

export async function saveSettings(payload, { quiet = false } = {}) {
  try {
    const settings = await request('settings', payload)
    setLanguagePreference(settings.language)
    setDesk({ settings })
    if (!quiet) toast(t('设置已保存'))
    return true
  } catch (err) {
    report(err)
    return false
  }
}

const FONT_STEPS = [0.9, 1, 1.15, 1.3]

export function stepFontScale(dir) {
  const current = Number(snapshot.settings?.fontScale) || 1
  const idx = FONT_STEPS.reduce((best, value, i) => (Math.abs(value - current) < Math.abs(FONT_STEPS[best] - current) ? i : best), 0)
  const next = FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, idx + dir))]
  if (next === current) return
  setDesk({ settings: { ...snapshot.settings, fontScale: next } })
  saveSettings({ fontScale: next }, { quiet: true })
}

export function toggleLanguage() {
  const next = lang() === 'en' ? 'zh' : 'en'
  setLanguagePreference(next)
  setDesk({ settings: { ...snapshot.settings, language: next } })
  saveSettings({ language: next }, { quiet: true })
}

export function selectPalette(id) {
  const found = PALETTES.find(p => p.id === id) || PALETTES[0]
  try { localStorage.setItem(PALETTE_KEY, found.id) } catch { /* ignore */ }
  setDesk({ palette: found.id })
  toast(lang() === 'en' ? `Palette: ${found.en}` : `已切换配色：「${found.zh}」（${found.subZh}）`)
}

export function stepPalette(dir = 1) {
  const idx = PALETTES.findIndex(p => p.id === snapshot.palette)
  const nextIdx = ((idx < 0 ? 0 : idx) + dir + PALETTES.length) % PALETTES.length
  selectPalette(PALETTES[nextIdx].id)
}

export function togglePalette() {
  stepPalette(1)
}

export async function testImage(payload) {
  try {
    const settings = await request('settings', payload)
    setLanguagePreference(settings.language)
    setDesk({ settings })
    const { src } = await request('settings/test', {})
    return src
  } catch (err) {
    report(err)
    return null
  }
}


export async function saveProduced(id) {
  try {
    const production = snapshot.state.items.find(row => row.id === id)?.production
    // 视频封面在浏览器里合成，一起存进文件夹
    const videoCover = await coverDataUrl({ src: production.cover?.src, text: production.coverText || production.title }).catch(() => undefined)
    const data = await request('produce/save', { id, videoCover })
    setDesk({ state: data.state })
    toast(t('已保存到 {path}', { path: data.path }))
  } catch (err) {
    report(err)
  }
}

export async function revealSaved(id) {
  try {
    await request('produce/reveal', { id })
  } catch (err) {
    report(err)
  }
}


export async function captureUrl(url, extra = {}) {
  try {
    const data = await request('capture-url', { url, ...extra })
    setDesk({ state: data.state, canUndo: true })
    toast(t('已收藏到灵感墙'), { undo: true })
    return data.id
  } catch (err) {
    report(err)
    return null
  }
}

export async function uploadFile(file) {
  const res = await fetch(`${BASE}upload`, { method: 'POST', headers: { 'content-type': file.type, 'x-media-desk-lang': lang() }, body: file })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || t('上传失败'))
  return data
}

export async function captureFiles(files) {
  for (const file of files) {
    try {
      const { src, kind } = await uploadFile(file)
      const title = file.name.replace(/\.[^.]+$/, '')
      await dispatchOps([{ op: 'add_item', kind, title, media: { src } }], { label: t('收藏 {title}', { title }), silent: true })
      toast(t('已放到灵感墙'), { undo: true })
    } catch (err) {
      report(err)
    }
  }
}

export async function refreshAccount(payload) {
  try {
    const data = await request('account/refresh', payload)
    setDesk({ state: data.state, canUndo: true })
    if (data.fetchError) toast(t('读取主页失败：{error}', { error: data.fetchError }), { error: true })
    else toast(t('已更新账号档案'))
    return data
  } catch (err) {
    report(err)
    return null
  }
}

export async function extractStyle(payload) {
  try {
    const data = await request('style/extract', payload)
    setDesk({ state: data.state, canUndo: true })
    const missed = data.failures?.length ?? 0
    toast(missed ? t(plural(missed, '风格已提炼，有 1 个链接未能读取', '风格已提炼，有 {n} 个链接未能读取'), { n: missed }) : t('风格已提炼，后续按此风格写作'), { undo: true })
    return true
  } catch (err) {
    report(err)
    return false
  }
}

export async function monidStatus() {
  try {
    return await request('monid/status')
  } catch (err) {
    return { state: 'error', message: err.message }
  }
}

export async function importAccount(payload) {
  try {
    const data = await request('monid/import', payload)
    setDesk({ state: data.state, canUndo: true })
    const spent = data.cost ? t('，花费 ${cost}', { cost: data.cost.toFixed(3) }) : ''
    const what = t(plural(data.count, '读到 {name} 的 1 条内容，新增 {added} 条', '读到 {name} 的 {count} 条内容，新增 {added} 条'), { name: data.nickname, count: data.count, added: data.added })
    toast(data.styleError ? t('{what}{spent}。风格没提炼成：{error}', { what, spent, error: data.styleError }) : t('{what}，已提炼成风格{spent}', { what, spent }), { error: Boolean(data.styleError), undo: !data.styleError })
    return true
  } catch (err) {
    report(err)
    return false
  }
}

export async function learnSkills() {
  try {
    const data = await request('skills/learn', {})
    setDesk({ state: data.state, canUndo: true })
    toast(data.added ? t(plural(data.added, '从数据中提炼出 1 条新规则，待确认', '从数据中提炼出 {n} 条新规则，待确认'), { n: data.added }) : t('现有数据不足以提炼新规则'))
  } catch (err) {
    report(err)
  }
}

export async function exportSkills() {
  try {
    const data = await request('skills/export', {})
    setDesk({ state: data.state })
    toast(t(plural(data.rules, '已导出 Skill：{name}（1 条规则）', '已导出 Skill：{name}（{n} 条规则）'), { name: data.name, n: data.rules }))
  } catch (err) {
    report(err)
  }
}

export function fetchInsights() {
  return request('insights')
}

export function wallCard(row) {
  if (String(row.id).startsWith('fav:')) {
    return {
      id: row.id, external: 'fav', badge: '收藏', badgeKey: '收藏（素材）',
      kind: row.image ? 'image' : 'note', title: row.title, body: row.excerpt || '',
      source: [row.source, row.author].filter(Boolean).join(' · '),
      when: (row.saved || row.date || '').slice(0, 10),
      createdAt: row.saved ? row.saved.replace(' ', 'T') : `${row.date || '1970-01-01'}T00:00:00`,
      pos: row.pos || null,
      media: row.image ? { src: `media-desk/inbox/image?name=${encodeURIComponent(row.image)}` } : null,
      status: 'idea',
    }
  }
  const pending = row.place !== 'atom'
  return {
    id: row.id, external: pending ? 'pending' : 'atom', badge: pending ? '待确认' : '知识原子', kind: 'quote', title: row.title, body: row.excerpt || '',
    source: row.origin === 'bench' && row.handle ? `@${row.handle}` : (row.group || ''), when: row.date || '',
    meta: row.meta || null, origin: row.origin || '', handle: row.handle || '', group: row.group || '',
    createdAt: row.date ? `${row.date}T12:00:00` : row.id,
    pos: row.pos || null, status: 'idea',
  }
}

export function openExternal(item) {
  setDesk({ view: 'atoms', focusId: null, atomOpen: item.id, atomTab: item.external === 'fav' ? 'fav' : 'pending' })
}

export const INBOX_DAYS = 3

export async function loadInbox() {
  const data = await request(`inbox?days=${INBOX_DAYS}`)
  setDesk({ inbox: data })
  return data
}

export function useInboxRefresh(ms) {
  React.useEffect(() => {
    let timer
    let stop = false
    const tick = async () => {
      if (stop || document.visibilityState === 'hidden') return
      try { await loadInbox() } catch { /* 轮询失败不打断页面 */ }
      if (!stop) timer = setTimeout(tick, ms)
    }
    const onVis = () => {
      clearTimeout(timer)
      if (document.visibilityState === 'visible') tick()
    }
    onVis()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis) }
  }, [ms])
}

export function searchFavorites(q, offset = 0, limit = 30) {
  const params = new URLSearchParams({ q, offset: String(offset), limit: String(limit) })
  return request(`inbox?${params}`)
}

// 知识原子页的收藏列表。不写入 inbox，灵感墙和首页仍用近 3 天的那一份。
export function loadFavoriteSpan(days, offset = 0, limit = 30) {
  const params = new URLSearchParams({ days: String(days), offset: String(offset), limit: String(limit) })
  return request(`inbox?${params}`)
}

export function loadInboxItem(id) {
  return request(`inbox/item?id=${encodeURIComponent(id)}`)
}


async function postInbox(path, body) {
  const data = await request(path, { ...(body || {}), days: INBOX_DAYS })
  if (data?.inbox?.favorites) setDesk({ inbox: data.inbox })
  else if (data?.favorites) {
    const inbox = { ...data }
    delete inbox.id
    delete inbox.title
    setDesk({ inbox })
  }
  loadTodo().catch(() => {})
  return data
}

export async function archiveFavorite(id) {
  try {
    const data = await postInbox('inbox/archive', { id })
    if (snapshot.atomOpen === id) setDesk({ atomOpen: null })
    toast(t('已归档'))
    return data
  } catch (err) {
    report(err)
    return null
  }
}

export async function archiveFavoriteBatch(ids) {
  try {
    return await postInbox('inbox/archive-batch', { ids })
  } catch (err) {
    report(err)
    return null
  }
}

export async function retryIngest(id) {
  try { return await postInbox('ingest/retry', { id }) } catch (err) { report(err); return null }
}

export function loadWechatStyles() {
  return request('wechat/styles')
}

export async function confirmAtom(id) {
  try {
    const data = await postInbox('atom/confirm', { id })
    toast(t('已确认为知识原子'))
    return data
  } catch (err) { report(err); return null }
}

export async function rejectAtom(id) {
  try {
    const data = await postInbox('atom/reject', { id })
    toast(t('已否决，移到回收站'))
    return data
  } catch (err) { report(err); return null }
}

export async function saveAtom(body) {
  try {
    const data = await postInbox('atom/save', body)
    toast(t('已保存'))
    return data
  } catch (err) {
    if (err.status === 409) return { conflict: true, message: err.message }
    report(err)
    return null
  }
}

export async function renameAtom(body) {
  try {
    const data = await postInbox('atom/rename', body)
    const title = data?.title
    const wanted = String(body.title ?? '').trim()
    if (title && wanted && title !== wanted) toast(t('标题已保存为「{title}」', { title }))
    else if (data?.id) toast(t('标题已保存'))
    return data?.id || null
  } catch (err) {
    report(err)
    return null
  }
}

export async function saveCardPos(id, pos) {
  setDesk(s => {
    if (!s.inbox) return {}
    const patch = list => list?.map(row => (row.id === id ? { ...row, pos } : row))
    return { inbox: { ...s.inbox, favorites: patch(s.inbox.favorites), pending: patch(s.inbox.pending) } }
  })
  try {
    await request('inbox/card-pos', { id, pos })
  } catch (err) {
    report(err)
    loadInbox().catch(() => {})
  }
}

function takeBoard(data) {
  if (!data?.lines) return data
  const { matched, unmatched, note, ...board } = data
  setDesk({ board })
  return data
}

export async function loadBoard() {
  const data = await request('board')
  setDesk({ board: data })
  return data
}
export async function loadTodo() {
  const data = await request('todo')
  setDesk({ todo: data })
  return data
}

export function openLine(lineKey) {
  setDesk({ view: 'flow', focusId: null, pieceOpen: null, piecePlatform: null, flowFocus: lineKey })
}


export function useBoardRefresh() {
  const view = useDesk(s => s.view)
  React.useEffect(() => {
    const home = view === 'home'
    if (!home && !['atoms', 'flow', 'content', 'schedule', 'insights'].includes(view)) return undefined
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      loadBoard().catch(err => report(err))
      if (home) loadTodo().catch(err => report(err))
    }
    tick()
    const timer = setInterval(tick, home ? 30000 : 10000)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [view])
}

async function piecePost(path, body) {
  const data = await request(path, body)
  takeBoard(data)
  loadTodo().catch(() => {})
  return data
}

export function openPiece(note, platform = null) {
  setDesk({ pieceOpen: note, piecePlatform: platform })
}

export async function createPiece(body, { view = 'flow' } = {}) {
  const data = await piecePost('piece/create', body)
  const wanted = String(body.title ?? '').trim()
  if (wanted && data.title && data.title !== wanted) toast(t('标题已保存为「{title}」', { title: data.title }))
  setDesk({ view, pieceOpen: data.note, piecePlatform: null })
  return data
}

export function loadPiece(note) {
  return request(`piece?note=${encodeURIComponent(note)}`)
}

export function savePieceBody(body, { quiet = false } = {}) {
  return piecePost('piece/save', body).then(data => {
    if (!quiet) toast(t('正文已保存'))
    return data
  })
}
export async function setPieceStatus(body) {
  const before = snapshot.board?.pieces?.find(row => row.note === body.note)
  const data = await piecePost('piece/status', body)
  const after = data?.pieces?.find(row => row.note === body.note)
  const moved = after?.folder && after.folder !== before?.folder
  const folder = leafFolder(after?.folder)
  if (body.status === '定稿') toast(moved ? t('已定稿，移到 {folder}', { folder }) : t('已定稿'))
  else toast(moved ? t('已取消定稿，移到 {folder}', { folder }) : t('已取消定稿'))
  return data
}
export async function publishPiece(body) {
  const before = snapshot.board?.pieces?.find(row => row.note === body.note)
  const data = await piecePost('piece/publish', body)
  const after = data?.pieces?.find(row => row.note === body.note)
  const moved = after?.folder && after.folder !== before?.folder
  toast(moved ? t('已确认发布，移到 {folder}', { folder: leafFolder(after.folder) }) : t('已确认发布'))
  return data
}
export async function unpublishPiece(body) {
  const before = snapshot.board?.pieces?.find(row => row.note === body.note)
  const data = await piecePost('piece/unpublish', body)
  const after = data?.pieces?.find(row => row.note === body.note)
  const moved = after?.folder && after.folder !== before?.folder
  toast(moved ? t('已撤销，移到 {folder}', { folder: leafFolder(after.folder) }) : t('已撤销'))
  return data
}
export function setPieceImpressions(body) { return piecePost('piece/impressions', body) }
export async function schedulePiece(body) {
  const data = await piecePost('piece/schedule', body)
  toast(body.at ? t('已排期') : t('已清除排期'))
  return data
}
export function setPiecePlatforms(body) { return piecePost('piece/platforms', body) }
export function mergePiece(body) { return piecePost('piece/merge', body) }
export function unmergePiece(body) { return piecePost('piece/unmerge', body) }
export function openPieceInObsidian(note) { return request('piece/open', { note }) }
export async function deletePiece(note) {
  const data = await piecePost('piece/delete', { note })
  setDesk({ pieceOpen: null, piecePlatform: null })
  toast(t('已移到回收站'))
  return data
}
export async function deleteLine(key) {
  const data = await piecePost('line/delete', { key })
  toast(t('已移到回收站'))
  return data
}
export function importXMetrics(csv) { return piecePost('metrics/import', { csv }) }

export async function loadXStatus() {
  const data = await request('x/status')
  setDesk({ xStatus: data })
  return data
}
export async function refreshX() {
  const data = await request('x/refresh', {})
  setDesk({ ...(data.board ? { board: data.board } : {}), ...(data.x ? { xStatus: data.x } : {}) })
  loadTodo().catch(() => {})
  return data
}
export async function setXRefresh(patch) {
  const data = await request('x/settings', patch)
  setDesk({ xStatus: data })
  loadTodo().catch(() => {})
  return data
}
export async function confirmXSuggestion(note) {
  const before = snapshot.board?.pieces?.find(row => row.note === note)
  const data = await request('x/suggestion', { note, action: 'confirm' })
  setDesk({ ...(data.board ? { board: data.board } : {}), ...(data.x ? { xStatus: data.x } : {}) })
  loadTodo().catch(() => {})
  const after = data.board?.pieces?.find(row => row.note === note)
  const moved = after?.folder && after.folder !== before?.folder
  toast(moved ? t('已确认发布，移到 {folder}', { folder: leafFolder(after.folder) }) : t('已确认发布'))
  return data
}
export async function dismissXSuggestion(note) {
  const data = await request('x/suggestion', { note, action: 'dismiss' })
  if (data.x) setDesk({ xStatus: data.x })
  loadTodo().catch(() => {})
  return data
}

export function loadPublishStatus(note) {
  return request(`publish/status?note=${encodeURIComponent(note)}`)
}
export async function preparePublishBundle(body) {
  const data = await request('publish/prepare', body)
  if (data.board) {
    takeBoard(data.board)
    loadTodo().catch(() => {})
  }
  return data
}
export function savePublishCopy(body) {
  return request('publish/save-copy', body)
}
export function generatePublishCopy(body) {
  return request('publish/generate-copy', body)
}
export function placePublishVideo(body) {
  return request('publish/place-video', body)
}
export function revealPublishBundle(note) {
  return request('publish/reveal', { note })
}
export async function backfillPublishLinks(note, record = null) {
  const data = await request('publish/backfill', record ? { note, record } : { note })
  if (data.board) {
    takeBoard(data.board)
    loadTodo().catch(() => {})
  }
  return data
}
export async function ensurePublishXHeading(note) {
  const data = await request('publish/x-heading', { note })
  if (data.board) takeBoard(data.board)
  return data
}
export function loadWechatsyncStatus(refresh = false, clientId = '') {
  const qs = new URLSearchParams()
  if (refresh) qs.set('refresh', '1')
  if (clientId) qs.set('clientId', clientId)
  const suffix = qs.toString()
  return request(`wechatsync/status${suffix ? `?${suffix}` : ''}`)
}
export function loadWechatsyncRecords(note) {
  return request(`wechatsync/records?note=${encodeURIComponent(note)}`)
}
export function loadWechatsyncJob(id) {
  return request(`wechatsync/job?id=${encodeURIComponent(id)}`)
}
export function startWechatsync(body) {
  return request('wechatsync/sync', body)
}
export async function generateWechatsyncToken() {
  const data = await request('wechatsync/token', {})
  if (data.settings) setDesk({ settings: data.settings })
  return data
}
export async function unlockWechatsyncExtension() {
  const data = await request('wechatsync/unlock', {})
  if (data.settings) setDesk({ settings: data.settings })
  return data
}


