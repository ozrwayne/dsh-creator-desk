// 稿件面板：外观对齐知识原子阅读面板。
import React from 'react'
import { DraftChat } from './draft-chat.jsx'
import { deletePiece, loadInbox, loadInboxItem, loadPiece, loadWechatStyles, mergePiece, publishPiece, report, savePieceBody, setDesk, setPieceImpressions, setPiecePlatforms, setPieceStatus, toast, unmergePiece, unpublishPiece, schedulePiece, useDesk } from './desk.js'
import { lang, t } from './i18n.js'
import { Dialog, IconButton } from './ui.jsx'
import { renderMarkdown } from './util.js'
import { request } from './desk.js'
import { beijingPreviewClient, LongArticleSyncSection, VideoBundleSection } from './publish.jsx'

const tr = (zh, en) => lang() === 'en' ? en : zh
const OWN_FIELDS = [['views', '播放 / 阅读', 'Views'], ['likes', '点赞', 'Likes'], ['comments', '评论', 'Comments'], ['saves', '收藏', 'Saves'], ['shares', '分享', 'Shares'], ['stars', 'Star', 'Stars'], ['forks', 'Fork', 'Forks']]

export function OwnMetricValues({ metrics }) {
  return <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
    {OWN_FIELDS.filter(([key]) => metrics[key] != null).map(([key, zh, en]) => <span key={key}>{tr(zh, en)} {Number(metrics[key]).toLocaleString()}</span>)}
  </span>
}

export function OwnPieceMetrics({ note, platform }) {
  const [rows, setRows] = React.useState([])
  const revision = useDesk(s => s.ownMetricsRevision)
  React.useEffect(() => {
    let active = true
    setRows([])
    request(`own/metrics?note=${encodeURIComponent(note)}`).then(data => { if (active) setRows(data.metrics || []) }).catch(err => { if (active) report(err) })
    return () => { active = false }
  }, [note, revision])
  const shown = platform ? rows.filter(row => row.platform === platform) : rows
  return shown.length ? <div className="md-piece-xmeta">
    {shown.map(row => <div key={`${row.accountId}:${row.postId}`}>
      <small>{row.platform} · {tr('读取于', 'Read at')} {snapshotStamp(row.at)}</small>
      <OwnMetricValues metrics={row} />
    </div>)}
  </div> : null
}

const PLATFORMS = ['X', '公众号', '知乎', '今日头条', 'LinkedIn', 'Substack', '小红书', '抖音', '视频号', 'B站', 'YouTube', 'Instagram', '小宇宙']

function ymd(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function snapshotStamp(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
}

function charCount(text) {
  return [...String(text ?? '').replace(/\s/g, '')].length
}

function isCjk(ch) {
  const c = ch.codePointAt(0)
  return (c >= 0x3400 && c <= 0x4dbf)
    || (c >= 0x4e00 && c <= 0x9fff)
    || (c >= 0x3040 && c <= 0x30ff)
    || (c >= 0x31f0 && c <= 0x31ff)
    || (c >= 0xac00 && c <= 0xd7af)
    || (c >= 0x1100 && c <= 0x11ff)
    || (c >= 0xff66 && c <= 0xff9d)
    || (c >= 0xf900 && c <= 0xfaff)
}

function weigh(text) {
  let n = 0
  for (const ch of text) n += isCjk(ch) ? 2 : 1
  return n
}

function xCount(text) {
  const src = String(text ?? '')
  let n = 0
  let last = 0
  for (const match of src.matchAll(/https?:\/\/\S+/gi)) {
    n += weigh(src.slice(last, match.index))
    n += 23
    last = match.index + match[0].length
  }
  return n + weigh(src.slice(last))
}

async function copyBody(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      toast(t('已复制正文'))
      return
    }
  } catch { /* 内网页面常常没有 clipboard */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    if (ok) {
      toast(t('已复制正文'))
      return
    }
  } catch { /* 再失败就让人自己复制 */ }
  toast(t('复制失败，请手动复制'), { error: true })
}

// 后端的问题提示是拼好的中文；带标题的那条按前缀识别，在前端用模板重拼好支持英文
function translateProblem(item) {
  const match = /^并入的原子《(.+)》事实核查未通过$/.exec(String(item || ''))
  if (match) return t('并入的原子《{title}》事实核查未通过', { title: match[1] })
  return t(item)
}

function noteName(id) {
  return String(id || '').split('/').pop().replace(/\.md$/, '')
}

function atomIdOf(piece, board, inbox) {
  const line = (board?.lines || []).find(row => row.originNote && row.originNote === piece.source)
  if (line?.originId) return line.originId
  const rows = [...(inbox?.atoms || []), ...(inbox?.pending || [])]
  return rows.find(row => noteName(row.id) === piece.source)?.id || null
}

const OBSIDIAN_VAULT = '知识库'

function openObsidianHere(path) {
  if (!path) return
  window.location.href = `obsidian://open?vault=${encodeURIComponent(OBSIDIAN_VAULT)}&file=${encodeURIComponent(path)}`
}

function originAtomOf(piece, board) {
  const line = (board?.lines || []).find(row => row.key === piece.lineKey)
  return line?.originId ? { id: line.originId, note: line.originNote, title: line.originTitle || line.originNote || '' } : null
}

function mergedAtomsOf(piece, inbox) {
  return (piece.merged || []).map(note => {
    const row = (inbox?.atoms || []).find(item => noteName(item.id) === note)
    return row ? { id: row.id, note, title: row.title || note } : { id: null, note, title: note }
  })
}


function AtomRef({ entry, onRemove }) {
  const [open, setOpen] = React.useState(false)
  const [body, setBody] = React.useState(null)
  React.useEffect(() => {
    if (!open || !entry.id || body != null) return undefined
    let stop = false
    loadInboxItem(entry.id).then(item => { if (!stop) setBody(item.body || '') }).catch(() => { if (!stop) setBody('') })
    return () => { stop = true }
  }, [open, entry.id, body])
  return (
    <details className="md-piece-ref-atom" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{entry.title}</span>
        {onRemove ? <button type="button" className="md-btn is-small" onClick={event => { event.preventDefault(); event.stopPropagation(); onRemove(entry.note) }}>{t('移除')}</button> : null}
      </summary>
      {open ? (entry.id
        ? <div className="md-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(body || '') }} />
        : <p className="md-piece-ref-empty">{t('并入的知识原子不存在')}</p>) : null}
    </details>
  )
}


function Reference({ piece, onUnmerge, onAdopt }) {
  const board = useDesk(s => s.board)
  const inbox = useDesk(s => s.inbox)
  const [opened, setOpened] = React.useState(false)
  const [data, setData] = React.useState(null)
  const isLong = piece.form === '长文'
  React.useEffect(() => { if (opened && isLong) loadInbox().catch(report) }, [opened, isLong, piece.note])
  React.useEffect(() => {
    if (!opened || isLong) return undefined
    let stop = false
    const load = async () => {
      try {
        if (piece.form === '短推') {
          const id = atomIdOf(piece, board, inbox)
          if (!id) {
            if (!stop) setData({ kind: 'empty' })
            return
          }
          const item = await loadInboxItem(id)
          if (!stop) setData({ kind: 'atom', body: item.body || '' })
          return
        }
        const note = piece.source
        if (!note || note === '工作台') {
          if (!stop) setData({ kind: 'empty' })
          return
        }
        const parent = await loadPiece(note)
        if (!stop) setData({ kind: 'parent', body: parent.body || '', distributions: parent.distributions || [] })
      } catch {
        if (!stop) setData({ kind: 'empty' })
      }
    }
    load()
    return () => { stop = true }
  }, [opened, isLong, piece.note, piece.form, piece.source, piece.lineKey, board, inbox])
  if (isLong) {
    const origin = originAtomOf(piece, board)
    const merged = mergedAtomsOf(piece, inbox)
    const exclude = new Set([origin?.note, ...merged.map(entry => entry.note)].filter(Boolean))
    return (
      <details className="md-piece-ref" onToggle={event => setOpened(event.currentTarget.open)}>
        <summary>{t('参考')}</summary>
        {opened ? (
          <div className="md-piece-ref-atoms">
            {origin ? <AtomRef entry={origin} /> : null}
            {merged.map(entry => <AtomRef key={entry.note} entry={entry} onRemove={onUnmerge} />)}
            {!origin && !merged.length ? <p className="md-piece-ref-empty">{t('没有可显示的参考')}</p> : null}
            <label>{t('添加参考原子')} <select className="md-clean-select" value="" onChange={event => { if (event.target.value) onAdopt(event.target.value) }}>
              <option value="">{t('选择已确认的知识原子')}</option>
              {(inbox?.atoms || []).filter(row => !exclude.has(noteName(row.id))).map(row => <option key={row.id} value={noteName(row.id)}>{row.title}</option>)}
            </select></label>
          </div>
        ) : null}
      </details>
    )
  }
  return (
    <details className="md-piece-ref" onToggle={event => setOpened(event.currentTarget.open)}>
      <summary>{t('参考')}</summary>
      {opened && data?.kind === 'atom' ? <div className="md-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.body) }} /> : null}
      {opened && data?.kind === 'parent' ? (
        <>
          <div className="md-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.body) }} />
          <ul className="md-piece-ref-list">
            {(data.distributions || []).map(row => (
              <li key={row.platform}>
                <span>{t(row.platform)}</span>
                {row.url ? <a href={row.url} target="_blank" rel="noreferrer">{row.url}</a> : <span>{t('暂无')}</span>}
                <span>{row.impressions == null ? t('待填曝光') : row.impressions.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {opened && data?.kind === 'empty' ? <p className="md-piece-ref-empty">{t('没有可显示的参考')}</p> : null}
    </details>
  )
}

const WX_KEY = 'dsh-media-desk-wechat-style'

function savedWxStyle() {
  try { return localStorage.getItem(WX_KEY) || 'minimal' } catch { return 'minimal' }
}

function rememberWxStyle(id) {
  try { localStorage.setItem(WX_KEY, id) } catch { /* 隐私模式只记在这次打开里 */ }
}

function plainFromHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

async function copyLayout(src) {
  let html = ''
  try {
    const res = await fetch(src, { headers: { 'x-media-desk-lang': lang() } })
    html = await res.text()
    if (!res.ok) throw new Error('fetch')
  } catch {
    toast(t('请在新标签页里全选后复制'), { error: true })
    return
  }
  const inner = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] || html
  const plain = plainFromHtml(inner)
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new window.ClipboardItem({
        'text/html': new Blob([inner], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })])
      toast(t('已复制排版'))
      return
    }
  } catch { /* 内网页面常常没有 clipboard */ }
  try {
    const box = document.createElement('div')
    box.contentEditable = 'true'
    box.innerHTML = inner
    box.setAttribute('style', 'position:fixed;left:-9999px')
    document.body.appendChild(box)
    const range = document.createRange()
    range.selectNodeContents(box)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const ok = document.execCommand('copy')
    selection.removeAllRanges()
    box.remove()
    if (ok) {
      toast(t('已复制排版'))
      return
    }
  } catch { /* 再失败就让人到新标签页复制 */ }
  toast(t('请在新标签页里全选后复制'), { error: true })
}

function WechatDialog({ note, onClose }) {
  const [styles, setStyles] = React.useState([])
  const [styleId, setStyleId] = React.useState(savedWxStyle)
  React.useEffect(() => {
    let stop = false
    loadWechatStyles().then(data => {
      if (stop) return
      const list = data.styles || []
      setStyles(list)
      setStyleId(current => (list.some(item => item.id === current) ? current : 'minimal'))
    }).catch(report)
    return () => { stop = true }
  }, [])
  const pick = (id) => {
    if (!id) return
    setStyleId(id)
    rememberWxStyle(id)
  }
  const recommended = styles.filter(item => item.recommended)
  const more = styles.filter(item => !item.recommended)
  const src = `media-desk/wechat/html?note=${encodeURIComponent(note)}&style=${encodeURIComponent(styleId || 'minimal')}`
  return (
    <Dialog title={t('公众号排版')} onClose={onClose} width={780}>
      <div className="md-wx">
        <div className="md-wx-styles">
          {recommended.map(item => (
            <button key={item.id} type="button" className={`md-pill is-small ${styleId === item.id ? 'is-primary' : ''}`} onClick={() => pick(item.id)}>{item.name}</button>
          ))}
          {more.length ? (
            <select aria-label={t('更多风格')} value={more.some(item => item.id === styleId) ? styleId : ''} onChange={event => pick(event.target.value)}>
              <option value="">{t('更多风格')}</option>
              {more.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          ) : null}
        </div>
        <iframe className="md-wx-frame" sandbox="" title={t('公众号预览')} src={src} />
        <p className="md-wx-note">{t('复制后粘贴到公众号后台编辑器。标题单独填，图片在后台补。')}</p>
        <div className="md-form-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="md-btn" onClick={() => window.open(src, '_blank', 'noopener')}>{t('在新标签页打开')}</button>
          <button type="button" className="md-btn is-primary" onClick={() => copyLayout(src)}>{t('复制排版')}</button>
        </div>
      </div>
    </Dialog>
  )
}

export function PiecePanel() {
  const note = useDesk(s => s.pieceOpen)
  const focus = useDesk(s => s.piecePlatform)
  const view = useDesk(s => s.view)
  const [piece, setPiece] = React.useState(null)
  const [body, setBody] = React.useState('')
  const [accounts, setAccounts] = React.useState('')
  const [platforms, setPlatforms] = React.useState([])
  const [drafts, setDrafts] = React.useState({})
  const [ask, setAsk] = React.useState(false)
  const [conflict, setConflict] = React.useState(false)
  const [drop, setDrop] = React.useState(false)
  const [wechat, setWechat] = React.useState(false)
  const [wechatAsk, setWechatAsk] = React.useState(false)
  const editor = React.useRef(null)
  const [selected, setSelected] = React.useState(false)
  React.useEffect(() => { setSelected(false) }, [note, body])
  const dirty = Boolean(piece) && body !== (piece.body || '')
  const dirtyRef = React.useRef(dirty)
  const noteRef = React.useRef(note)
  const saveRef = React.useRef(null)
  dirtyRef.current = dirty
  noteRef.current = note
  const watched = useDesk(s => {
    const row = s.board?.pieces?.find(item => item.note === note)
    return row ? `${row.mtimeMs}\n${row.folder || ''}` : ''
  })
  const seenWatch = React.useRef('')
  React.useEffect(() => {
    if (!note || !watched || watched === seenWatch.current || dirtyRef.current || conflict) return undefined
    seenWatch.current = watched
    const splitAt = watched.indexOf('\n')
    const mtime = Number(watched.slice(0, splitAt))
    const folder = watched.slice(splitAt + 1)
    if (piece && piece.mtimeMs === mtime && piece.folder === folder) return undefined
    let stop = false
    loadPiece(note).then(data => {
      if (stop || dirtyRef.current) return
      setPiece(data)
      setBody(data.body || '')
      setAccounts((data.accounts || []).join(', '))
      setPlatforms(data.platforms || [])
    }).catch(err => { if (!stop) report(err) })
    return () => { stop = true }
  }, [watched, note, conflict])
  React.useEffect(() => {
    if (!note) { setPiece(null); setAsk(false); setDrop(false); return undefined }
    setDrop(false)
    let stop = false
    loadPiece(note).then(data => {
      if (stop) return
      setPiece(data)
      setBody(data.body || '')
      setAccounts((data.accounts || []).join(', '))
      setPlatforms(data.platforms || [])
    }).catch(err => { report(err); setDesk({ pieceOpen: null }) })
    return () => { stop = true }
  }, [note])
  React.useEffect(() => {
    if (!note || !focus) return undefined
    const row = document.querySelector(`[data-piece-platform="${CSS.escape(focus)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
    return undefined
  }, [note, focus, piece])

  const closeNow = () => {
    setAsk(false)
    setDesk({ pieceOpen: null, piecePlatform: null })
  }
  const requestClose = () => {
    if (dirtyRef.current) setAsk(true)
    else closeNow()
  }

  const viewSeen = React.useRef(view)
  React.useEffect(() => {
    if (viewSeen.current === view) return undefined
    viewSeen.current = view
    if (!noteRef.current) return undefined
    if (dirtyRef.current) setAsk(true)
    else setDesk({ pieceOpen: null, piecePlatform: null })
    return undefined
  }, [view])
  React.useEffect(() => {
    if (!note) return undefined
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (document.querySelector('.md-dialog')) return
        saveRef.current?.()
        return
      }
      if (event.key !== 'Escape' || ask || conflict || document.querySelector('.md-dialog')) return
      requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ask, conflict, note])

  if (!note) return null
  const reload = async ({ keepBody = false } = {}) => {
    const data = await loadPiece(note)
    setPiece(data)
    if (!keepBody) setBody(data.body || '')
    setAccounts((data.accounts || []).join(', '))
    setPlatforms(data.platforms || [])
    return data
  }
  const run = async (fn, { saveFirst = false } = {}) => {
    try {
      if (saveFirst && dirtyRef.current) await savePieceBody({ note, body, mtimeMs: piece.mtimeMs }, { quiet: true })
      await fn()
      return await reload({ keepBody: dirtyRef.current && !saveFirst })
    } catch (err) {
      if (err.status === 409) { setConflict(true); return null }
      report(err)
      return null
    }
  }
  const saveBody = () => run(() => savePieceBody({ note, body, mtimeMs: piece.mtimeMs }))
  saveRef.current = saveBody
  const doUnmerge = (atom) => run(() => unmergePiece({ note, atom }))
  const doAdopt = atom => run(() => mergePiece({ note, atoms: [atom] }))
  const distOf = platform => piece?.distributions?.find(row => row.platform === platform)
  const schedOf = platform => piece?.schedules?.find(row => row.platform === platform)
  const patchDraft = (platform, patch, base) => setDrafts(map => ({ ...map, [platform]: { ...base, ...patch } }))
  const flushPendingEdits = async () => {
    let latestMtime = piece.mtimeMs
    if (dirtyRef.current) {
      const savedBody = await savePieceBody({ note, body, mtimeMs: latestMtime }, { quiet: true })
      latestMtime = savedBody?.pieces?.find(p => p.note === note)?.mtimeMs ?? latestMtime
    }
    const nextAcc = accounts.split(',').map(item => item.trim()).filter(Boolean)
    const sameAcc = JSON.stringify(nextAcc) === JSON.stringify(piece.accounts || [])
    const samePlat = JSON.stringify(platforms) === JSON.stringify(piece.platforms || [])
    if (!sameAcc || !samePlat) {
      await setPiecePlatforms({ note, accounts: nextAcc, platforms })
    }
    if (dirtyRef.current || !sameAcc || !samePlat) {
      await reload({ keepBody: true })
    }
  }
  const applyUpdatedPiece = (nextPiece) => {
    setPiece(nextPiece)
    setBody(nextPiece.body || '')
    setAccounts((nextPiece.accounts || []).join(', '))
    setPlatforms(nextPiece.platforms || [])
  }
  const registerLink = platform => {
    setPlatforms(list => list.includes(platform) ? list : [...list, platform])
    requestAnimationFrame(() => {
      const section = document.querySelector(`[data-piece-platform="${CSS.escape(platform)}"]`)
      section?.scrollIntoView({ block: 'nearest' })
      section?.querySelector('[data-public-url]')?.focus()
    })
  }
  return (
    <aside className="md-atom-read md-piece" role="dialog" aria-label={piece?.title || t('稿件')}>
      <header className="md-atom-read-head">
        <h2>{piece?.title || t('正在加载')}</h2>
        <IconButton icon="close" label={t('关闭')} onClick={requestClose} />
      </header>
      {piece?.note === note ? (
        <div className="md-piece-scroll">
          <div className="md-piece-meta">
            <span>{t('形态')} {t(piece.form)}</span>
            <span>{t('阶段')} {t(piece.stage)}</span>
            <span>{t('状态')} {t(piece.status)}</span>
          </div>
          {piece.problems?.length ? <p className="md-piece-problems">{piece.problems.map(item => translateProblem(item)).join(' · ')}</p> : null}
          {piece.form === '视频' ? (
            <VideoBundleSection
              piece={piece}
              onRegisterLink={registerLink}
              onSaveFirst={flushPendingEdits}
              onPieceUpdated={applyUpdatedPiece}
            />
          ) : null}
          <div className="md-draft-layout">
          <div className="md-draft-editor">
          <label className="md-field md-piece-body">
            <span className="md-piece-body-label">
              <span>{t('正文')}</span>
              <button type="button" className="md-btn is-small" onClick={() => copyBody(body)}>{t('复制正文')}</button>
            </span>
            <textarea ref={editor} value={body} onSelect={e => setSelected(e.target.selectionStart !== e.target.selectionEnd)} onChange={event => setBody(event.target.value)} aria-label={t('正文')} />
          </label>
          <p className={`md-piece-count${piece.form === '短推' && xCount(body) > 280 ? ' is-over' : ''}`}>
            <span>{t('{n} 字', { n: charCount(body) })}</span>
            {piece.form === '短推' ? <span> · {t('X 计数 {n}', { n: xCount(body) })}</span> : null}
            {piece.form === '短推' && xCount(body) > 280 ? <span> · {t('超过 280，需要 X Premium 长帖')}</span> : null}
          </p>
          </div>
          <DraftChat key={note} title={piece.title} editor={editor} body={body} selection={selected} onChange={setBody} />
          </div>
          {piece.form === '短推' || piece.form === '长文' || piece.form === '视频' ? <Reference piece={piece} onUnmerge={doUnmerge} onAdopt={doAdopt} /> : null}
          <label className="md-field">
            <span>{t('账号')}</span>
            <input value={accounts} onChange={event => setAccounts(event.target.value)} aria-label={t('账号')} />
          </label>
          <div className="md-piece-platforms" role="group" aria-label={t('平台')}>
            {PLATFORMS.map(name => {
              const on = platforms.includes(name)
              return (
                <button
                  key={name}
                  type="button"
                  className={`md-pill is-small ${on ? 'is-primary' : ''}`}
                  aria-pressed={on}
                  onClick={() => setPlatforms(list => on ? list.filter(item => item !== name) : [...list, name])}
                >{t(name)}</button>
              )
            })}
          </div>
          <div className="md-piece-actions">
            <button type="button" className="md-btn" onClick={() => run(() => setPiecePlatforms({ note, accounts: accounts.split(',').map(item => item.trim()).filter(Boolean), platforms }))}>{t('保存账号和平台')}</button>
          </div>
          {piece.form === '长文' ? (
            <LongArticleSyncSection
              piece={piece}
              platforms={platforms}
              dirty={dirty}
              onSaveFirst={flushPendingEdits}
              onPieceUpdated={applyUpdatedPiece}
              onRegisterLink={registerLink}
            />
          ) : null}
          {platforms.map(platform => {
            const dist = distOf(platform)
            const sched = schedOf(platform)
            const draft = drafts[platform] || { url: '', date: ymd(), at: sched?.at || `${ymd()} 20:00`, impressions: dist?.impressions ?? '' }
            const bj = beijingPreviewClient(draft.at)
            return (
              <section key={platform} data-piece-platform={platform} className="md-piece-card">
                <h3>{t(platform)}</h3>
                {dist ? (
                  <>
                    <p className="md-piece-pub">
                      <span>{dist.date}</span>
                      {dist.url ? <a href={dist.url} target="_blank" rel="noreferrer">{dist.url}</a> : null}
                    </p>
                    <OwnPieceMetrics note={note} platform={platform} />
                    <label className="md-field">
                      <span>{t('曝光')}</span>
                      <input value={draft.impressions} inputMode="numeric" onChange={event => patchDraft(platform, { impressions: event.target.value }, draft)} />
                      {piece.form === '短推' && platform === 'X' ? <small>{t('大于 3000 即验证')}</small> : null}
                      {platform === 'X' && piece.xSnapshot ? (
                        <small className="md-piece-xmeta">
                          <span>{t('自动更新于 {at}', { at: snapshotStamp(piece.xSnapshot.at) })}</span>
                          <span>{t('点赞 {likes} · 回复 {replies} · 转发 {reposts} · 收藏 {saves}', { likes: piece.xSnapshot.favorites ?? '—', replies: piece.xSnapshot.replies ?? '—', reposts: piece.xSnapshot.retweets ?? '—', saves: piece.xSnapshot.bookmarks ?? '—' })}</span>
                        </small>
                      ) : null}
                    </label>
                    <div className="md-piece-actions">
                      <button type="button" className="md-btn" onClick={() => {
                        const raw = String(draft.impressions ?? '').trim()
                        if (raw === '') {
                          if (dist.impressions == null) return
                          run(() => setPieceImpressions({ note, platform, impressions: null }))
                          return
                        }
                        if (!/^\d+$/.test(raw)) { report(new Error(t('曝光数必须是非负整数'))); return }
                        const next = Number(raw)
                        if (next === dist.impressions) return
                        run(() => setPieceImpressions({ note, platform, impressions: next }))
                      }}>{t('保存曝光')}</button>
                      <button type="button" className="md-btn" onClick={() => run(() => unpublishPiece({ note, platform }))}>{t('撤销')}</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="md-piece-row">
                      <label className="md-field">
                        <span>{t('排期')}{bj ? ` · ${t('北京时间 {bj}', { bj })}` : ''}</span>
                        <input value={draft.at} onChange={event => patchDraft(platform, { at: event.target.value }, draft)} />
                      </label>
                      <button type="button" className="md-btn" onClick={() => run(() => schedulePiece({ note, platform, at: draft.at }))}>{t('排期')}</button>
                      {sched ? <button type="button" className="md-btn" onClick={() => run(() => schedulePiece({ note, platform, at: null }))}>{t('清除排期')}</button> : null}
                    </div>
                    <div className="md-piece-row">
                      <label className="md-field">
                        <span>{t('链接')}</span>
                        <input data-public-url="" value={draft.url} onChange={event => patchDraft(platform, { url: event.target.value }, draft)} />
                      </label>
                      <label className="md-field md-piece-date">
                        <span>{t('日期')}</span>
                        <input value={draft.date} onChange={event => patchDraft(platform, { date: event.target.value }, draft)} />
                      </label>
                      <button type="button" className="md-btn is-primary" onClick={() => run(() => publishPiece({ note, platform, url: draft.url, date: draft.date }), { saveFirst: true })}>{t('确认已发布')}</button>
                    </div>
                  </>
                )}
              </section>
            )
          })}
        </div>
      ) : <div className="md-piece-scroll" />}
      {piece ? (
        <footer className="md-atom-read-foot">
          <button type="button" className="md-btn is-primary" onClick={saveBody}>{t('保存正文')}</button>
          {piece.status === '进行中' ? <button type="button" className="md-btn" onClick={() => run(() => setPieceStatus({ note, status: '定稿' }), { saveFirst: true })}>{t('标记定稿')}</button> : null}
          {piece.status === '定稿' ? <button type="button" className="md-btn" onClick={() => run(() => setPieceStatus({ note, status: '进行中' }))}>{t('取消定稿')}</button> : null}
          <button type="button" className="md-btn" onClick={() => openObsidianHere(piece.path)}>{t('在 Obsidian 打开')}</button>
          {piece.form === '长文' && platforms.includes('公众号') ? <button type="button" className="md-btn" onClick={() => (dirtyRef.current ? setWechatAsk(true) : setWechat(true))}>{t('公众号排版')}</button> : null}
          <span className="md-grow" />
          <button type="button" className="md-btn is-danger" onClick={() => setDrop(true)}>{t('删除')}</button>
        </footer>
      ) : null}
      {ask ? (
        <Dialog title={t('未保存的正文')} onClose={() => setAsk(false)}>
          <p className="md-atom-note">{t('关闭后，这次改动会丢掉。')}</p>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setAsk(false)}>{t('取消')}</button>
            <button type="button" className="md-btn is-primary" onClick={closeNow}>{t('关闭')}</button>
          </div>
        </Dialog>
      ) : null}
      {conflict ? (
        <Dialog title={t('文件已在别处修改')} onClose={() => setConflict(false)}>
          <p className="md-atom-note">{t('载入最新版本会丢掉输入框里的改动。')}</p>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setConflict(false)}>{t('继续编辑')}</button>
            <button type="button" className="md-btn is-primary" onClick={() => { setConflict(false); reload().catch(report) }}>{t('载入最新版本')}</button>
          </div>
        </Dialog>
      ) : null}
      {drop ? (
        <Dialog title={t('删除')} onClose={() => setDrop(false)}>
          <ul className="md-atom-note">
            {[piece?.path, piece?.assets].filter(Boolean).map(path => <li key={path}>{path}</li>)}
          </ul>
          <p className="md-atom-note">{t('文件会移到知识库的回收站（.trash）')}</p>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setDrop(false)}>{t('取消')}</button>
            <button type="button" className="md-btn is-danger" onClick={() => { setDrop(false); deletePiece(note).catch(report) }}>{t('删除')}</button>
          </div>
        </Dialog>
      ) : null}
      {wechatAsk ? (
        <Dialog title={t('未保存的正文')} onClose={() => setWechatAsk(false)}>
          <p className="md-atom-note">{t('先保存正文，再做公众号排版。排版读的是已保存的文件。')}</p>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setWechatAsk(false)}>{t('取消')}</button>
            <button type="button" className="md-btn is-primary" onClick={() => { setWechatAsk(false); run(async () => { setWechat(true) }, { saveFirst: true }) }}>{t('保存并排版')}</button>
          </div>
        </Dialog>
      ) : null}
      {wechat ? <WechatDialog note={note} onClose={() => setWechat(false)} /> : null}
    </aside>
  )
}
