// 首页：一句话记一个灵感。灵感可以散落在空间里，也可以按时间排成信息流。
import React from 'react'
import { resumeReview } from './atoms.jsx'
import { Card, openCapture } from './card.jsx'
import { captureFiles, captureUrl, confirmXSuggestion, dismissXSuggestion, dispatchOps, openExternal, openItem, openLine, openPiece, report, saveCardPos, setDesk, useDesk, useInboxRefresh, wallCard } from './desk.js'
import { lang, plural, t } from './i18n.js'
import { Icon, IconButton, Segmented } from './ui.jsx'
import { MiniStamps } from './stamps.jsx'
import { cardSize, scatterLayout } from './layout.js'
import { relatedIdeas, relatedLayout } from './related.js'
import { SPRING_SOFT, displayItem, hash, reducedMotion, isIdea, weekSpan } from './util.js'
import { useCamera } from './camera.js'
import { cssZoom, localDelta } from './zoom.js'

const tr = (zh, en) => (lang() === 'en' ? en : zh)

/** 首屏那句话：收藏、待确认、本周排期。数字没回来之前不显示 0。 */
function weekSlots(pieces, now = new Date()) {
  const [start, end] = weekSpan(now)
  let n = 0
  for (const piece of pieces || []) {
    for (const row of piece.schedules || []) {
      const day = String(row.at || '').slice(0, 10)
      if (day >= start && day <= end) n += 1
    }
  }
  return n
}

function KpiNum({ n }) {
  if (n == null) return <strong className="md-shimmer">—</strong>
  return <strong>{n}</strong>
}

function Hero() {
  const items = useDesk(s => s.state.items)
  const inbox = useDesk(s => s.inbox)
  const board = useDesk(s => s.board)
  const roots = items.filter(isIdea)
  const favN = inbox?.counts ? inbox.counts.favorites : null
  const pendingN = inbox?.counts ? inbox.counts.pending : null
  const weekN = board ? weekSlots(board.pieces) : null
  const cover = (inbox?.favorites || []).find(row => row.image)
  const coverSrc = cover ? `media-desk/inbox/image?name=${encodeURIComponent(cover.image)}` : null
  const related = useDesk(s => s.related)
  const [text, setText] = React.useState('')
  const submit = async (event) => {
    event.preventDefault()
    const value = text.trim()
    if (!value) return
    setText('')
    if (/^https?:\/\//i.test(value)) return captureUrl(value)
    // 记下的同时，把提到同一件事的旧灵感拉到眼前
    const ids = relatedIdeas(roots, value)
    setDesk({ related: ids.length ? { query: value, ids, newId: null } : null })
    await dispatchOps([{ op: 'add_item', kind: 'note', title: value.split(/[。！？\n]|[.!?](?=\s|$)/)[0].slice(0, 60), body: value.length > 60 ? value : '' }], { label: t('记下灵感') })
  }
  const now = new Date()
  return (
    <section className="md-hero md-bento-hero" onPointerDown={e => e.stopPropagation()}>
      <div className="md-hero-topbar">
        <span className="md-hero-date-pill">
          <Icon name="calendar" size={13} />
          <span>{now.getFullYear()} · {t('{m} 月 {d} 日', { m: now.getMonth() + 1, d: now.getDate(), mon: now.toLocaleString('en-US', { month: 'short' }) })} · {t(WEEKDAYS[now.getDay()])}</span>
        </span>
        {roots.length ? (
          <span className="md-hero-notes-pill">{t('另有 {n} 条随手记的灵感', { n: roots.length, s: plural(roots.length, '', 's') })}</span>
        ) : null}
      </div>

      <div className="md-hero-kpi-grid">
        <button type="button" className="md-hero-kpi-card is-blue" onClick={() => setDesk({ view: 'atoms', atomTab: 'fav', atomOpen: null, focusId: null })}>
          <div className="md-hero-kpi-top">
            <span className="md-hero-kpi-icon">
              {coverSrc ? <img src={coverSrc} alt="" draggable={false} /> : <Icon name="bookmark" size={16} />}
            </span>
            <Icon name="upRight" size={14} />
          </div>
          <KpiNum n={favN} />
          <span className="md-hero-kpi-label">{tr('篇收藏待处理', 'Saved items')}</span>
        </button>

        <button type="button" className="md-hero-kpi-card is-purple" disabled={!pendingN} onClick={resumeReview}>
          <div className="md-hero-kpi-top">
            <span className="md-hero-kpi-icon"><Icon name="spark" size={16} /></span>
            <Icon name="upRight" size={14} />
          </div>
          <KpiNum n={pendingN} />
          <span className="md-hero-kpi-label">{pendingN ? tr('条待确认 · 继续审核', 'pending · Resume review') : tr('条笔记待确认', 'Pending insights')}</span>
        </button>

        <button type="button" className="md-hero-kpi-card is-green" onClick={() => setDesk({ view: 'schedule', focusId: null })}>
          <div className="md-hero-kpi-top">
            <span className="md-hero-kpi-icon"><Icon name="clock" size={16} /></span>
            <Icon name="upRight" size={14} />
          </div>
          <KpiNum n={weekN} />
          <span className="md-hero-kpi-label">{tr('条本周排期内容', 'Scheduled this week')}</span>
        </button>
      </div>

      <form className="md-hero-input md-hero-omnibox" onSubmit={submit}>
        <span className="md-omnibox-spark"><Icon name="spark" size={15} /></span>
        <input value={text} onChange={e => setText(e.target.value)} placeholder={t('输入灵感，或粘贴链接')} aria-label={t('记下灵感')} />
        <button type="button" className="md-omnibox-media" title={tr('添加图片或视频', 'Add media')} onClick={() => openCapture('file')}>
          <Icon name="image" size={15} />
        </button>
        <button type="submit" className="md-send" aria-label={t('记下')} disabled={!text.trim()}><Icon name="send" size={15} /></button>
      </form>

      {related ? (
        <p className="md-hero-related">
          <span>{t('找到 {n} 条相关灵感，已移到旁边', { n: related.ids.length, s: plural(related.ids.length, '', 's') })}</span>
          <button type="button" className="md-inline-link" onClick={() => setDesk({ related: null })}>{t('放回去')}</button>
        </p>
      ) : null}
      {roots.length === 0 ? <p className="md-hero-hint">{t('可以输入一句话、粘贴链接，或拖入图片和视频。也可以让右上角的助手记录。')}</p> : null}

      <div className="md-hero-subrow">
        <MiniStamps />
      </div>
      <TodoList />
    </section>
  )
}

const TODO_LABEL = {
  overdue: '排期已过',
  impressions: '待填曝光',
  link: '缺少帖子链接',
  platforms: '未分发完',
  upgrade: '下一形态未开始',
  pending: '待确认',
  suggest: '疑似已发布',
  xrefresh: '曝光刷新',
}

const TODO_TONE = {
  overdue: 'danger',
  bench: 'amber',
  favorites: 'amber',
  pending: 'purple',
  upgrade: 'blue',
  impressions: 'cyan',
  platforms: 'blue',
  suggest: 'green',
  xrefresh: 'cyan',
}

function todoText(group, item) {
  if (group === 'bench') return `@${item.handle || '—'} · ${tr('同步待重试', 'Sync retry needed')}`
  if (group === 'pending') return `${t('{n} 条待确认', { n: item.count })} · ${tr('继续审核', 'Resume review')}`
  if (group === 'favorites') return `《${item.title || t('无标题')}》${item.error ? ` · ${item.error}` : ''}`
  if (group === 'upgrade') return t('《{title}》可写{form}', { title: item.title, form: t(item.nextForm) })
  if (group === 'platforms') return t('《{title}》缺{platforms}', { title: item.title, platforms: (item.missing || []).map(name => t(name)).join('、') })
  if (group === 'overdue') return t('《{title}》{platform} {at}', { title: item.title, platform: t(item.platform), at: item.at })
  if (group === 'impressions') return t('《{title}》的 X 曝光还没填', { title: item.title })
  if (group === 'suggest') return t('《{title}》已在 X 发出，曝光 {n}', { title: item.title, n: Number(item.views || 0).toLocaleString() })
  if (group === 'xrefresh') return tr('曝光数据待刷新', 'Refresh impressions')
  return ''
}

function openTodo(item) {
  if (item.kind === 'bench') {
    setDesk({ view: 'bench', benchHandle: item.handle || 'all' })
    return
  }
  if (item.kind === 'line') {
    openLine(item.lineKey)
    return
  }
  if (item.kind === 'pending') {
    resumeReview()
    return
  }
  if (item.kind === 'xrefresh') {
    setDesk({ view: 'insights' })
    return
  }
  openPiece(item.note, item.platform || null)
}

function TodoList() {
  const todo = useDesk(s => s.todo)
  const [open, setOpen] = React.useState(true)
  const [more, setMore] = React.useState(false)
  const groups = todo?.groups || []
  const flat = groups.flatMap(group => group.items.map(item => ({ group: group.id, item })))
  const shown = more ? flat : flat.slice(0, 5)
  const rest = flat.length - shown.length
  if (todo && !flat.length) return null
  return (
    <section className="md-todo md-bento-todo">
      <button type="button" className="md-todo-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="md-todo-head-left">
          <span className="md-todo-dot" />
          <strong>{t('待办')}</strong>
          <span className="md-todo-count-pill">{todo ? flat.length : '—'}</span>
        </span>
        <Icon name="chevD" size={14} />
      </button>
      {open && todo ? (
        <div className="md-todo-body">
          {shown.map(({ group, item }) => {
            const label = group === 'bench' ? t('对标读取失败') : t(TODO_LABEL[group] || group)
            const tone = TODO_TONE[group] || 'blue'
            return group === 'suggest' ? (
              <div key={item.id} className="md-todo-row is-suggest">
                <button type="button" className="md-todo-row-btn" onClick={() => openTodo(item)}>
                  <em className={`md-todo-tag is-${tone}`}>{label}</em>
                  <span className="md-todo-row-txt">{todoText(group, item)}</span>
                </button>
                <span className="md-todo-acts">
                  <button type="button" className="md-act-btn is-primary" onClick={() => confirmXSuggestion(item.note).catch(report)}>{t('确认')}</button>
                  <button type="button" className="md-act-btn" onClick={() => dismissXSuggestion(item.note).catch(report)}>{t('不是这条')}</button>
                </span>
              </div>
            ) : (
              <button type="button" key={item.id} className="md-todo-row-btn" onClick={() => openTodo(item)}>
                <em className={`md-todo-tag is-${tone}`}>{label}</em>
                <span className="md-todo-row-txt">{todoText(group, item)}</span>
                <Icon name="chevR" size={13} />
              </button>
            )
          })}
          {rest > 0 ? <button type="button" className="md-todo-more" onClick={() => setMore(true)}>{t('还有 {n} 条', { n: rest })}</button> : null}
        </div>
      ) : null}
    </section>
  )
}


function Node({ item, pos, index, entered, onOpen, tone }) {
  const ref = React.useRef(null)
  React.useLayoutEffect(() => {
    if (entered.current.has(item.id)) return
    entered.current.add(item.id)
    const el = ref.current?.firstElementChild
    if (!el || reducedMotion()) return
    const k = 0.25
    el.animate([
      { transform: `translate(${-pos.x * k}px, ${-pos.y * k}px) scale(.8) rotate(${(hash(item.id) % 20) - 10}deg)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration: SPRING_SOFT.duration + 200, easing: SPRING_SOFT.easing, delay: Math.min(index * 32, 620), fill: 'backwards' })
  }, [entered, index, item.id, pos.x, pos.y])
  const size = cardSize(item)
  return (
    <div ref={ref} className={`md-node${tone ? ` is-${tone}` : ''}`} data-node={item.id} style={{ left: pos.x, top: pos.y, width: size.w, '--r': `${pos.r ?? 0}deg`, '--d': pos.d ?? 0 }}>
      <div className="md-pop"><Card item={item} onOpen={onOpen} /></div>
    </div>
  )
}

function originOf(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
}

function externalsOf(inbox) {
  return [...(inbox?.favorites ?? []), ...(inbox?.pending ?? [])].map(wallCard)
}

function shownItems(roots, externals, kind) {
  if (kind === 'fav') return externals.filter(item => item.external === 'fav')
  if (kind === 'pending') return externals.filter(item => item.external === 'pending')
  const ideas = roots.filter(item => kind === 'all' || displayItem(item).kind === kind)
  return kind === 'all' ? [...ideas, ...externals] : ideas
}

function Scatter() {
  const items = useDesk(s => s.state.items)
  const stageRef = React.useRef(null)
  const worldRef = React.useRef(null)
  const { cam, flyTo, halt } = useCamera(stageRef, worldRef)
  const dragPos = React.useRef({})
  const [, force] = React.useReducer(v => v + 1, 0)
  const entered = React.useRef(new Set())
  const suppressClick = React.useRef(false)

  const kind = useDesk(s => s.kindFilter)
  const related = useDesk(s => s.related)
  const inbox = useDesk(s => s.inbox)
  const roots = React.useMemo(() => items.filter(isIdea), [items])
  const externals = React.useMemo(() => externalsOf(inbox), [inbox])
  const poolRef = React.useRef([])
  poolRef.current = [...roots, ...externals]
  const shown = React.useMemo(() => shownItems(roots, externals, kind), [roots, externals, kind])
  const layoutKey = poolRef.current.map(i => `${i.id}:${i.pos ? `${i.pos.x},${i.pos.y}` : ''}:${i.production?.cover?.src ?? ''}`).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = React.useMemo(() => scatterLayout([...roots, ...externals]), [layoutKey])

  const relatedSpots = React.useMemo(() => {
    if (!related) return {}
    const byId = new Map(roots.map(i => [i.id, i]))
    return relatedLayout(related.ids.filter(id => byId.has(id)).map(id => ({ id, ...cardSize(byId.get(id)) })))
  }, [related, roots])

  const posOf = React.useCallback((item) => {
    if (dragPos.current[item.id]) return dragPos.current[item.id]
    if (related) {
      // 相关的围在中间那句话四周，刚记下的那条放在正上方，不被底部工具条挡住
      if (item.id === related.newId) return { x: 0, y: -200 - cardSize(item).h / 2, r: 0, d: 0 }
      const spot = relatedSpots[item.id]
      if (spot) return { ...spot, r: 0, d: 0 }
    }
    if (item.pos) return { d: 0, ...item.pos }
    return layout[item.id] ?? { x: 0, y: 0, r: 0, d: 0 }
  }, [layout, related, relatedSpots])

  // 拉出相关卡片后，镜头缩放到能把它们和中间那句话一起装下
  React.useEffect(() => {
    if (!related) return
    const byId = new Map(roots.map(i => [i.id, i]))
    let half = { x: 300, y: 240 }
    for (const [id, p] of Object.entries(relatedSpots)) {
      const size = cardSize(byId.get(id))
      half = { x: Math.max(half.x, Math.abs(p.x) + size.w / 2), y: Math.max(half.y, Math.abs(p.y) + size.h / 2) }
    }
    const fresh = related.newId && byId.get(related.newId)
    if (fresh) half.y = Math.max(half.y, 200 + cardSize(fresh).h)
    const home = frameHome()
    const { w, h } = stageBox()
    flyTo({ ...home, s: Math.min(home.s, (w - 80) / (half.x * 2), (h - 150) / (half.y * 2)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relatedSpots, related?.newId])

  const toneOf = (item) => {
    if (!related) return null
    if (item.id === related.newId || related.ids.includes(item.id)) return 'related'
    return 'dim'
  }

  const stageBox = React.useCallback(() => {
    const el = stageRef.current
    return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 1000, h: 700 }
  }, [])

  const frameHome = React.useCallback(() => {
    const { w, h } = stageBox()
    return { x: w / 2, y: h / 2 + 8, s: w < 760 ? 0.66 : w < 1040 ? 0.8 : w < 1400 ? 0.92 : 1 }
  }, [stageBox])

  React.useLayoutEffect(() => {
    flyTo(frameHome(), { instant: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 新记下的灵感可能落在屏幕外：相机带过去，让人看到它去了哪里
  const known = React.useRef(null)
  React.useEffect(() => {
    const previous = known.current
    known.current = new Set(roots.map(i => i.id))
    if (!previous) return
    const added = roots.find(i => !previous.has(i.id))
    if (!added) return
    if (related && !related.newId) {
      setDesk({ related: { ...related, newId: added.id } })
      return
    }
    const p = posOf(added)
    const size = cardSize(added)
    const { w, h } = stageBox()
    const c = cam.current
    const margin = 90
    const left = c.tx + c.ts * (p.x - size.w / 2)
    const right = c.tx + c.ts * (p.x + size.w / 2)
    const top = c.ty + c.ts * (p.y - size.h / 2)
    const bottom = c.ty + c.ts * (p.y + size.h / 2)
    const dx = left < margin ? margin - left : right > w - margin ? w - margin - right : 0
    const dy = top < margin ? margin - top : bottom > h - margin ? h - margin - bottom : 0
    if (dx || dy) flyTo({ x: c.tx + dx, y: c.ty + dy, s: c.ts })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots])

  React.useEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    let last = el.clientWidth
    const observer = new ResizeObserver(() => {
      const delta = el.clientWidth - last
      last = el.clientWidth
      if (!delta) return
      const c = cam.current
      flyTo({ x: c.tx + delta / 2, y: c.ty, s: c.ts }, { stiffness: 140, damping: 24 })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [cam, flyTo])

  const openCard = React.useCallback((item, event) => {
    if (suppressClick.current) return
    if (item.external) { openExternal(item); return }
    openItem(item.id, originOf(event))
  }, [])

  const onPointerDown = (event) => {
    if (event.button !== 0 || event.target.closest('input,textarea,button:not(.md-card),.md-toolrow,.md-ministamps')) return
    const cardEl = event.target.closest('[data-node]')
    const startX = event.clientX
    const startY = event.clientY
    const c = cam.current
    let moved = false
    suppressClick.current = false
    halt()
    if (cardEl) {
      const id = cardEl.dataset.node
      const item = poolRef.current.find(i => i.id === id)
      if (!item) return
      const origin = posOf(item)
      const onMove = (e) => {
        const delta = localDelta(e.clientX - startX, e.clientY - startY, stageRef.current)
        const dx = delta.x / c.s
        const dy = delta.y / c.s
        if (!moved && Math.hypot(dx, dy) < 4) return
        if (!moved) {
          moved = true
          cardEl.classList.add('is-dragging')
          suppressClick.current = true
        }
        const next = { x: origin.x + dx, y: origin.y + dy, r: origin.r, d: 0 }
        dragPos.current[id] = next
        cardEl.style.left = `${next.x}px`
        cardEl.style.top = `${next.y}px`
      }
      const onUp = async () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        cardEl.classList.remove('is-dragging')
        if (!moved) return
        const next = dragPos.current[id]
        setTimeout(() => { suppressClick.current = false }, 0)
        const pos = { x: Math.round(next.x), y: Math.round(next.y), r: next.r }
        if (item.external) await saveCardPos(id, pos)
        else await dispatchOps([{ op: 'update_item', id, pos }], { undoable: false, silent: true })
        delete dragPos.current[id]
        force()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      return
    }
    const baseX = c.x
    const baseY = c.y
    let lastX = startX
    let lastY = startY
    let lastT = performance.now()
    let vx = 0
    let vy = 0
    stageRef.current.classList.add('is-panning')
    const onMove = (e) => {
      const delta = localDelta(e.clientX - startX, e.clientY - startY, stageRef.current)
      if (Math.hypot(delta.x, delta.y) > 4) moved = true
      const now = performance.now()
      const dt = Math.max(now - lastT, 1)
      const step = localDelta(e.clientX - lastX, e.clientY - lastY, stageRef.current)
      vx = step.x / dt
      vy = step.y / dt
      lastX = e.clientX
      lastY = e.clientY
      lastT = now
      flyTo({ x: baseX + delta.x, y: baseY + delta.y, s: c.s }, { instant: true })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      stageRef.current?.classList.remove('is-panning')
      if (moved) flyTo({ x: c.x + vx * 180, y: c.y + vy * 180, s: c.s }, { stiffness: 42, damping: 13 })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const zoomAt = React.useCallback((factor, cx, cy, instant = true) => {
    const c = cam.current
    const s = Math.max(0.3, Math.min(2.2, c.ts * factor))
    const k = s / c.ts
    flyTo({ x: cx - (cx - c.tx) * k, y: cy - (cy - c.ty) * k, s }, { instant, stiffness: 160, damping: 24 })
  }, [cam, flyTo])

  React.useEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    const onWheel = (event) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const z = cssZoom(el)
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * 0.01), (event.clientX - rect.left) / z, (event.clientY - rect.top) / z)
      } else {
        const c = cam.current
        flyTo({ x: c.tx - event.deltaX / z, y: c.ty - event.deltaY / z, s: c.ts }, { instant: true })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [cam, flyTo, zoomAt])

  // 键盘 Tab 到屏幕外的卡片时，相机跟过去
  const onFocusIn = (event) => {
    const node = event.target.closest?.('[data-node]')
    if (!node || !event.target.matches(':focus-visible')) return
    const stageRect = stageRef.current.getBoundingClientRect()
    const rect = node.getBoundingClientRect()
    const c = cam.current
    const margin = 72
    const z = cssZoom(stageRef.current)
    const left = (rect.left - stageRect.left) / z
    const right = (rect.right - stageRect.left) / z
    const top = (rect.top - stageRect.top) / z
    const bottom = (rect.bottom - stageRect.top) / z
    const { w, h } = stageBox()
    let dx = 0
    let dy = 0
    if (left < margin) dx = margin - left
    else if (right > w - margin) dx = w - margin - right
    if (top < margin) dy = margin - top
    else if (bottom > h - margin) dy = h - margin - bottom
    if (dx || dy) flyTo({ x: c.tx + dx, y: c.ty + dy, s: c.ts })
  }

  const center = () => {
    const { w, h } = stageBox()
    return [w / 2, h / 2]
  }

  return (
    <div
      className="md-stage"
      ref={stageRef}
      onPointerDown={onPointerDown}
      onFocus={onFocusIn}
      onKeyDown={(event) => { if (event.key === 'Escape' && related) setDesk({ related: null }) }}
      onDragOver={e => e.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const files = [...(event.dataTransfer?.files ?? [])]
        if (files.length) captureFiles(files)
      }}
    >
      <div className="md-world" ref={worldRef}>
        <div className="md-hero-anchor"><Hero /></div>
        {shown.map((item, index) => <Node key={item.id} item={item} pos={posOf(item)} index={index} entered={entered} onOpen={openCard} tone={toneOf(item)} />)}
      </div>
      <div className="md-toolrow md-toolrow-right" onPointerDown={e => e.stopPropagation()}>
        <IconButton icon="zoomOut" label={t('缩小')} onClick={() => zoomAt(0.8, ...center(), false)} />
        <IconButton icon="target" label={t('回到中心')} onClick={() => flyTo(frameHome())} />
        <IconButton icon="zoomIn" label={t('放大')} onClick={() => zoomAt(1.25, ...center(), false)} />
      </div>
    </div>
  )
}

/** 信息流：原来的瀑布流卡片，按时间从新到旧排。 */
function Feed() {
  const items = useDesk(s => s.state.items)
  const inbox = useDesk(s => s.inbox)
  const kind = useDesk(s => s.kindFilter)
  const related = useDesk(s => s.related)
  const rank = id => (related ? related.ids.indexOf(id) : -1)
  const sorted = React.useMemo(() => {
    const roots = items.filter(isIdea)
    return shownItems(roots, externalsOf(inbox), kind)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .sort((a, b) => {
        const ra = rank(a.id)
        const rb = rank(b.id)
        return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, inbox, kind, related])
  return (
    <div className="md-wall-scroll">
      <div className="md-feed-hero"><Hero /></div>
      <div className="md-wall">
        {sorted.map((item, index) => (
          <div key={item.id} className={`md-wall-cell${rank(item.id) >= 0 ? ' is-related' : ''}`} style={{ animationDelay: `${Math.min(index * 22, 400)}ms` }}>
            <Card item={item} onOpen={(row, event) => (row.external ? openExternal(row) : openItem(row.id, originOf(event)))} />
          </div>
        ))}
      </div>
    </div>
  )
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const KIND_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'web', label: '网页' },
  { value: 'quote', label: '金句' },
  { value: 'note', label: '笔记' },
  { value: 'fav', label: '收藏', enKey: '收藏（素材）' },
  { value: 'pending', label: '待确认' },
]

export function HomeView() {
  const mode = useDesk(s => s.mode)
  const kind = useDesk(s => s.kindFilter)
  useInboxRefresh(30000)
  return (
    <div className="md-home">
      {mode === 'feed' ? <Feed /> : <Scatter />}
      <div className="md-dockbar" role="toolbar" aria-label={t('灵感视图')}>
        <Segmented
          label={t('展示方式')}
          value={mode}
          onChange={value => setDesk({ mode: value })}
          options={[{ value: 'scatter', icon: 'scatter', title: t('散落') }, { value: 'feed', icon: 'wall', title: t('信息流') }]}
        />
        <span className="md-dockbar-sep" />
        <div className="md-chips">
          {KIND_OPTIONS.map(option => (
            <button type="button" key={option.value} className={kind === option.value ? 'is-on' : ''} onClick={() => setDesk({ kindFilter: option.value })}>{option.enKey && lang() === 'en' ? t(option.enKey) : t(option.label)}</button>
          ))}
        </div>
        <span className="md-dockbar-sep" />
        <button type="button" className="md-round is-primary" aria-label={t('记下灵感')} title={t('记下灵感')} onClick={() => openCapture('text')}><Icon name="plus" size={18} /></button>
      </div>
    </div>
  )
}
