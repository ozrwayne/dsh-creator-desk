// 流程页：Bento 内容线工作流画布（知识原子原点 → 短推 → 长文 → 视频 → 多平台分发）。
import React from 'react'
import { useCamera } from './camera.js'
import { cssZoom, localDelta } from './zoom.js'
import { deleteLine, createPiece, openPiece, report, setDesk, useDesk } from './desk.js'
import { lang, t, useLang } from './i18n.js'
import { PlatformLogo } from './platforms.jsx'
import { Empty, Icon, IconButton } from './ui.jsx'

const tr = (zh, en) => (lang() === 'en' ? en : zh)

const NODE_W = 224
const NODE_H = 92
const STEP_H = 20
const GAP_X = 92
const COL = NODE_W + GAP_X
const BRANCH_W = 132
const BRANCH_H = 50
const BRANCH_GAP = 12
const BRANCH_DROP = 48
const NAME_H = 32

const FORM_STYLE = {
  知识原子: { icon: 'spark', tone: 'purple' },
  短推: { icon: 'bolt', tone: 'blue' },
  长文: { icon: 'pen', tone: 'indigo' },
  视频: { icon: 'film', tone: 'orange' },
  播客: { icon: 'globe', tone: 'green' },
}

function linePaths(board, key) {
  return (board?.pieces || []).filter(piece => piece.lineKey === key).flatMap(piece => [piece.path, piece.assets].filter(Boolean))
}

function confirmDeleteLine(board, key) {
  const paths = linePaths(board, key)
  setDesk({
    dialog: {
      title: t('删除内容线'),
      submitLabel: t('删除'),
      fields: [
        ...paths.map((path, index) => ({ name: `path${index}`, type: 'hidden', label: path })),
        { name: 'note', type: 'hidden', label: t('知识原子不会删除') },
      ],
      onSubmit: () => { deleteLine(key).catch(report) },
    },
  })
}
const ROW_GAP = 64
const MIN_S = 0.4
const MAX_S = 1.6
const SAFE = { top: 112, right: 28, bottom: 72, left: 28 }

const LEGEND = [
  ['done', '已完成'],
  ['active', '进行中'],
  ['todo', '未开始'],
]

function nodeHeight(node) {
  return node.steps?.length ? NODE_H + STEP_H : NODE_H
}

function layoutLines(lines) {
  const rows = []
  let y = 0
  for (const line of lines) {
    const nameY = y
    const nodeY = y + NAME_H
    const nodes = line.nodes.map((node, index) => {
      const h = nodeHeight(node)
      const placed = { ...node, index, x: index * COL, y: nodeY, w: NODE_W, h, key: `${line.id}:${index}` }
      const branches = node.branches ?? []
      const total = branches.length * BRANCH_W + Math.max(0, branches.length - 1) * BRANCH_GAP
      const start = placed.x + NODE_W / 2 - total / 2
      placed.branchPos = branches.map((branch, bi) => ({
        ...branch,
        x: start + bi * (BRANCH_W + BRANCH_GAP),
        y: nodeY + h + BRANCH_DROP,
        w: BRANCH_W,
        h: BRANCH_H,
        key: `${line.id}:${index}:${bi}`,
      }))
      return placed
    })
    let bottom = nodeY
    for (const node of nodes) {
      bottom = Math.max(bottom, node.y + node.h)
      for (const branch of node.branchPos) bottom = Math.max(bottom, branch.y + branch.h)
    }
    rows.push({ ...line, nameY, nodes, bottom })
    y = bottom + ROW_GAP
  }
  let minX = 0
  for (const row of rows) for (const node of row.nodes) for (const branch of node.branchPos) minX = Math.min(minX, branch.x)
  if (minX < 0) {
    for (const row of rows) {
      for (const node of row.nodes) {
        node.x -= minX
        for (const branch of node.branchPos) branch.x -= minX
      }
    }
  }
  let width = 0
  for (const row of rows) {
    for (const node of row.nodes) {
      width = Math.max(width, node.x + node.w)
      for (const branch of node.branchPos) width = Math.max(width, branch.x + branch.w)
    }
  }
  const height = rows.length ? rows[rows.length - 1].bottom : 0
  return { rows, width, height }
}

function curve(x1, y1, x2, y2, horizontal) {
  if (horizontal) {
    const dx = Math.max(36, Math.abs(x2 - x1) * 0.46)
    const dir = x2 >= x1 ? 1 : -1
    return `M ${x1} ${y1} C ${x1 + dx * dir} ${y1}, ${x2 - dx * dir} ${y2}, ${x2} ${y2}`
  }
  const dy = Math.max(28, Math.abs(y2 - y1) * 0.55)
  const dir = y2 >= y1 ? 1 : -1
  return `M ${x1} ${y1} C ${x1} ${y1 + dy * dir}, ${x2} ${y2 - dy * dir}, ${x2} ${y2}`
}

function edgeClass(from, to) {
  const live = from !== 'todo' && to !== 'todo'
  return `md-flow-edge${live ? ' is-go' : ' is-wait'}${to === 'active' ? ' is-flow' : ''}`
}

function edgesOf(rows) {
  const edges = []
  for (const row of rows) {
    for (let i = 0; i < row.nodes.length - 1; i += 1) {
      const a = row.nodes[i]
      const b = row.nodes[i + 1]
      edges.push({
        key: `${a.key}>${b.key}`,
        d: curve(a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2, true),
        marker: a.state !== 'todo' && b.state !== 'todo' ? 'go' : 'wait',
        className: edgeClass(a.state, b.state),
      })
    }
    for (const node of row.nodes) {
      for (const branch of node.branchPos) {
        edges.push({
          key: `${node.key}>${branch.key}`,
          d: curve(node.x + node.w / 2, node.y + node.h, branch.x + branch.w / 2, branch.y, false),
          marker: node.state !== 'todo' && branch.state !== 'todo' ? 'go' : 'wait',
          className: edgeClass(node.state, branch.state),
        })
      }
    }
  }
  return edges
}

function findSelected(rows, id) {
  if (!id) return null
  for (const row of rows) {
    for (const node of row.nodes) {
      if (node.key === id) return { kind: 'node', node, line: row }
      const branch = node.branchPos.find(item => item.key === id)
      if (branch) return { kind: 'branch', node, branch, line: row }
    }
  }
  return null
}

function labelOf(node) {
  if (node.origin) return node.originId ? node.title : t('无原点')
  if (node.followsMain) return t('随主线')
  if (node.mergedOnly) return t('并入《{title}》', { title: node.mergedTitle || '' })
  return node.state === 'todo' || !node.title ? t('未开始') : t(node.title)
}

function kickerOf(node) {
  return node.platform ? `${t(node.form)} · ${t(node.platform)}` : t(node.form)
}

function Dot({ state }) {
  return <span className={`md-dot md-flow-dot is-${state}`} />
}

function Steps({ steps }) {
  return (
    <span className="md-flow-steps">
      {steps.map(step => (
        <i key={step.label} className={`is-${step.state}`} data-label={t(step.label)} title={t(step.label)} />
      ))}
    </span>
  )
}

function Detail({ picked }) {
  if (!picked) return null
  const { node, branch } = picked
  const state = branch?.state ?? node.state
  const title = branch ? t(branch.label) : labelOf(node)
  const status = branch ? branch.status : node.status
  return (
    <aside className="md-flow-detail md-bento-card" aria-label={t('节点详情')} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <p className="md-flow-kicker">{branch ? `${t(node.form)} · ${t('分发')}` : kickerOf(node)}</p>
      <div className="md-flow-detail-head">
        {branch?.platform ? <PlatformLogo platform={branch.platform} size={20} /> : null}
        <h2>{title}</h2>
      </div>
      {branch && node.title ? <p className="md-flow-parent">{labelOf(node)}</p> : null}
      <p className="md-flow-status"><Dot state={state} /><span>{t(status)}</span></p>
      {!branch && node.platform ? <p className="md-flow-meta"><span>{t('平台')}</span><span><PlatformLogo platform={node.platform} size={14} /> {t(node.platform)}</span></p> : null}
      {!branch && node.branchPos.length ? (
        <ul>
          <li className="md-flow-kicker">{t('分发')}</li>
          {node.branchPos.map(item => (
            <li key={item.key}>
              <PlatformLogo platform={item.platform || item.label} size={14} />
              <span>{t(item.label)}</span>
              <span style={{ marginLeft: 'auto' }}><Dot state={item.state} /> {t(item.status)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {!branch && node.steps?.length ? (
        <ol>
          <li className="md-flow-kicker">{t('步骤')}</li>
          {node.steps.map(step => (
            <li key={step.label} className={`is-${step.state}`}><Dot state={step.state} />{t(step.label)}</li>
          ))}
        </ol>
      ) : null}
    </aside>
  )
}

function flowState(state) {
  if (state === 'disabled') return 'disabled'
  if (state === 'empty') return 'todo'
  if (state === 'validated') return 'done'
  if (state === 'testing' || state === 'writing') return 'active'
  return 'todo'
}

function branchState(state) {
  if (state === 'published') return 'done'
  if (state === 'scheduled') return 'active'
  return 'todo'
}
function originNode(line) {
  return {
    form: '知识原子',
    state: line.originId ? 'done' : 'todo',
    enabled: false,
    title: line.originTitle || line.originNote || '',
    status: line.originId ? '已确认' : '无原点',
    note: null,
    origin: true,
    originId: line.originId || null,
    lineKey: line.key,
    branches: [],
  }
}

function toFlow(board) {
  return (board?.lines || []).map(line => ({
    id: line.key,
    name: line.name,
    next: line.next,
    originNote: line.originNote,
    nodes: [originNode(line), ...line.nodes.map(node => {
      const top = node.pieces[0]
      const mergedPiece = (node.pieces || []).find(item => item.mergedIn)
      return {
        form: node.form,
        state: flowState(node.state),
        enabled: node.followsMain ? false : node.enabled,
        title: top?.title || node.label,
        status: node.label,
        note: node.followsMain ? null : (top?.note || null),
        mergedOnly: Boolean(node.mergedOnly),
        followsMain: Boolean(node.followsMain),
        mergedTitle: mergedPiece?.title || null,
        hasMerged: Boolean(mergedPiece),
        lineKey: line.key,
        parentNote: top?.note || line.nodes.slice(0, line.nodes.findIndex(item => item.form === node.form)).reverse().find(item => item.pieces.length)?.pieces[0]?.note || null,
        branches: (node.platforms || []).map(row => ({
          label: row.platform,
          platform: row.platform,
          state: branchState(row.state),
          status: row.state === 'published' ? '已发' : row.state === 'scheduled' ? '待发' : '未排',
          note: top?.note || null,
        })),
      }
    })],
  }))
}

export function FlowView() {
  useLang()
  const source = useDesk(s => s.board)
  const board = React.useMemo(() => layoutLines(toFlow(source)), [source])
  const edges = React.useMemo(() => edgesOf(board.rows), [board])
  const stageRef = React.useRef(null)
  const worldRef = React.useRef(null)
  const { cam, flyTo, halt } = useCamera(stageRef, worldRef)
  const suppress = React.useRef(false)
  const touched = React.useRef(false)
  const [selected, setSelected] = React.useState(null)
  const flowFocus = useDesk(s => s.flowFocus)
  const picked = findSelected(board.rows, selected)

  const stageBox = React.useCallback(() => {
    const el = stageRef.current
    return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 }
  }, [])

  const fit = React.useCallback((instant = false) => {
    const { w, h } = stageBox()
    if (w < 40 || h < 40) return
    const availW = Math.max(80, w - SAFE.left - SAFE.right)
    const availH = Math.max(80, h - SAFE.top - SAFE.bottom)
    const s = Math.max(MIN_S, Math.min(MAX_S, Math.min(availW / board.width, availH / board.height)))
    flyTo({
      x: SAFE.left + (availW - board.width * s) / 2,
      y: SAFE.top + (availH - board.height * s) / 2,
      s,
    }, { instant })
  }, [board.height, board.width, flyTo, stageBox])

  React.useLayoutEffect(() => {
    fit(true)
  }, [fit])
  React.useLayoutEffect(() => {
    if (!flowFocus || !source) return
    const row = board.rows.find(item => item.id === flowFocus)
    if (!row) {
      setDesk({ flowFocus: null })
      return
    }
    const { w, h } = stageBox()
    if (w < 40 || h < 40) return
    const s = Math.max(MIN_S, Math.min(1, cam.current.ts || 1))
    const wx = row.nodes[0]?.x ?? 0
    const wy = row.nameY
    flyTo({
      x: SAFE.left - wx * s,
      y: Math.max(24, h / 2 - (wy + 48) * s),
      s,
    })
    touched.current = true
    setDesk({ flowFocus: null })
  }, [flowFocus, source, board, flyTo, stageBox, cam])

  React.useEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    const observer = new ResizeObserver(() => {
      if (!touched.current) fit(true)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [fit])

  const zoomAt = React.useCallback((factor, cx, cy, instant = true) => {
    touched.current = true
    const c = cam.current
    const s = Math.max(MIN_S, Math.min(MAX_S, c.ts * factor))
    const k = s / (c.ts || 1)
    flyTo({ x: cx - (cx - c.tx) * k, y: cy - (cy - c.ty) * k, s }, { instant, stiffness: 160, damping: 24 })
  }, [cam, flyTo])

  React.useEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    const onWheel = (event) => {
      event.preventDefault()
      if (event.target.closest('.md-flow-detail')) return
      touched.current = true
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

  const onPointerDown = (event) => {
    if (event.button !== 0 || event.target.closest('button, a, input, textarea, .md-flow-detail, .md-toolrow')) return
    const startX = event.clientX
    const startY = event.clientY
    const c = cam.current
    const baseX = c.x
    const baseY = c.y
    let lastX = startX
    let lastY = startY
    let lastT = performance.now()
    let vx = 0
    let vy = 0
    let moved = false
    halt()
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
      if (!moved) return
      touched.current = true
      suppress.current = true
      setTimeout(() => { suppress.current = false }, 0)
      flyTo({ x: c.x + vx * 180, y: c.y + vy * 180, s: c.s }, { stiffness: 42, damping: 13 })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onFocus = (event) => {
    const node = event.target.closest?.('[data-flow-node]')
    if (!node || !stageRef.current || !event.target.matches(':focus-visible')) return
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

  const askCreate = (node) => {
    const parent = node.parentNote
    const unvalidated = parent && source?.lines?.some(line => line.key === node.lineKey && line.nodes.some(item => item.pieces[0]?.note === parent && item.state !== 'validated' && item.form !== node.form))
    setDesk({
      dialog: {
        title: unvalidated ? t('上一级未验证') : t('新建稿件'),
        submitLabel: t('新建'),
        fields: [
          ...(unvalidated ? [{ name: 'note', type: 'hidden', label: t('上一级还没验证。仍要新建？') }] : []),
          { name: 'title', label: t('标题'), required: true },
        ],
        onSubmit: (values) => {
          const title = String(values.title || '').trim()
          if (!title) return
          const body = parent
            ? { form: node.form, title, parentNote: parent }
            : { form: node.form, title, lineName: title }
          createPiece(body).catch(report)
        },
      },
    })
  }

  const onNode = (node) => {
    if (node.origin) {
      if (!node.originId) return
      setDesk({ view: 'atoms', atomTab: 'atoms', atomOpen: node.originId, pieceOpen: null, piecePlatform: null })
      return
    }
    if (node.note) {
      openPiece(node.note)
      return
    }
    if (node.state === 'disabled' || !node.enabled) return
    askCreate(node)
  }

  if (!source?.lines?.length) {
    return (
      <div className="md-page">
        <Empty title={t('还没有内容线')} />
        <button type="button" className="md-btn is-primary" onClick={() => setDesk({ view: 'atoms', atomTab: 'atoms' })}>{t('到知识原子页开一条内容线')}</button>
      </div>
    )
  }

  return (
    <div
      className="md-stage md-flow"
      ref={stageRef}
      onPointerDown={onPointerDown}
      onClick={(event) => {
        if (suppress.current || event.target.closest('button, .md-flow-detail, .md-toolrow')) return
        setSelected(null)
      }}
      onFocus={onFocus}
      onKeyDown={(event) => { if (event.key === 'Escape') setSelected(null) }}
    >
      <div className="md-world" ref={worldRef}>
        <svg className="md-flow-edges" aria-hidden="true">
          <defs>
            <marker id="md-flow-arrow-go" viewBox="0 0 10 10" markerWidth="7" markerHeight="7" refX="8" refY="5" orient="auto">
              <path className="md-flow-arrow is-go" d="M0 1.2 L8 5 L0 8.8 Z" />
            </marker>
            <marker id="md-flow-arrow-wait" viewBox="0 0 10 10" markerWidth="7" markerHeight="7" refX="8" refY="5" orient="auto">
              <path className="md-flow-arrow is-wait" d="M0 1.2 L8 5 L0 8.8 Z" />
            </marker>
          </defs>
          {edges.map(edge => (
            <path key={edge.key} className={edge.className} d={edge.d} markerEnd={`url(#md-flow-arrow-${edge.marker})`} />
          ))}
        </svg>
        {board.rows.map(row => (
          <div key={row.id} className="md-flow-row">
            <div className="md-flow-line" data-line={row.id} style={{ left: row.nodes[0].x, top: row.nameY }}>
              <span className="md-flow-line-pill">
                <Icon name="branch" size={12} />
                <b>{t(row.name)}</b>
              </span>
              <IconButton icon="trash" label={t('删除内容线')} onClick={(event) => { event.stopPropagation(); confirmDeleteLine(source, row.id) }} />
            </div>
            {row.nodes.map(node => {
              const fStyle = FORM_STYLE[node.form] || { icon: 'spark', tone: 'blue' }
              return (
                <button
                  type="button"
                  key={node.key}
                  data-flow-node=""
                  disabled={Boolean(node.origin && !node.originId)}
                  className={`md-flow-node tone-${fStyle.tone} is-${node.state}${node.steps?.length ? ' has-steps' : ''}${node.note && !node.origin && node.enabled ? ' has-add' : ''}${selected === node.key ? ' is-on' : ''}${node.mergedOnly ? ' is-merged-only' : ''}${node.followsMain ? ' is-follows-main' : ''}`}
                  style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
                  aria-pressed={selected === node.key}
                  aria-label={t('{kind}：{title}', { kind: t(node.form), title: labelOf(node) })}
                  onClick={(event) => { event.stopPropagation(); setSelected(node.key); onNode(node) }}
                >
                  <span className="md-flow-port is-in" />
                  <span className="md-flow-port is-out" />
                  <span className="md-flow-node-top">
                    <span className={`md-flow-form-tag is-${fStyle.tone}`}>
                      <Icon name={fStyle.icon} size={11} />
                      <span>{kickerOf(node)}</span>
                    </span>
                    {node.hasMerged && !node.mergedOnly ? <span className="md-flow-merged-badge">{t('并入')}</span> : null}
                  </span>
                  <span className="md-flow-title">{labelOf(node)}</span>
                  <span className="md-flow-status"><Dot state={node.state} /><span>{t(node.status)}</span></span>
                  {node.steps?.length ? <Steps steps={node.steps} /> : null}
                </button>
              )
            })}
            {row.nodes.filter(node => node.note && !node.origin && node.enabled).map(node => (
              <button
                type="button"
                key={`${node.key}-add`}
                className="md-flow-add"
                style={{ left: node.x + node.w - 28, top: node.y + 8 }}
                aria-label={t('再写一篇')}
                onClick={(event) => { event.stopPropagation(); askCreate(node) }}
              >+</button>
            ))}
            {row.nodes.flatMap(node => node.branchPos.map(branch => (
              <button
                type="button"
                key={branch.key}
                data-flow-node=""
                className={`md-flow-branch is-${branch.state}${selected === branch.key ? ' is-on' : ''}`}
                style={{ left: branch.x, top: branch.y, width: branch.w, height: branch.h }}
                aria-pressed={selected === branch.key}
                aria-label={t('{kind}：{title}', { kind: t(branch.label), title: t(branch.status) })}
                onClick={(event) => { event.stopPropagation(); setSelected(branch.key); if (branch.note) openPiece(branch.note, branch.platform) }}
              >
                <span className="md-flow-branch-top">
                  <PlatformLogo platform={branch.platform || branch.label} size={14} />
                  <span className="md-flow-title">{t(branch.label)}</span>
                </span>
                <span className="md-flow-status"><Dot state={branch.state} /><span>{t(branch.status)}</span></span>
              </button>
            )))}
          </div>
        ))}
      </div>
      <div className="md-flow-legend">
        <strong className="md-flow-hud-stat">{board.rows.length} {tr('条内容线', 'lines')}</strong>
        <span className="md-flow-hud-sep" />
        {LEGEND.map(([state, label]) => (
          <span key={state}><i className={`is-${state}`} />{t(label)}</span>
        ))}
      </div>
      <Detail picked={picked} />
      <div className="md-toolrow md-toolrow-right" onPointerDown={event => event.stopPropagation()}>
        <IconButton icon="zoomOut" label={t('缩小')} onClick={() => zoomAt(0.8, ...center(), false)} />
        <IconButton icon="target" label={t('适应画面')} onClick={() => { touched.current = true; fit(false) }} />
        <IconButton icon="zoomIn" label={t('放大')} onClick={() => zoomAt(1.25, ...center(), false)} />
      </div>
    </div>
  )
}
