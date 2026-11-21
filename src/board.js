const STAGES = ['0想法', '1测试', '2验证', '3升级', '4沉淀']

const STAGE_RANK = new Map(STAGES.map((stage, index) => [stage, index]))

export function stageRank(stage) {
  return STAGE_RANK.has(stage) ? STAGE_RANK.get(stage) : -1
}

export function formatNum(n) {
  const sign = n < 0 ? '-' : ''
  const digits = String(Math.trunc(Math.abs(Number(n))))
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function prefer(a, b) {
  const sa = stageRank(a.stage)
  const sb = stageRank(b.stage)
  if (sa !== sb) return sa > sb ? a : b
  if (a.date !== b.date) return a.date > b.date ? a : b
  if ((a.mtimeMs || 0) !== (b.mtimeMs || 0)) return (a.mtimeMs || 0) > (b.mtimeMs || 0) ? a : b
  return a.note > b.note ? a : b
}

export function foremost(pieces) {
  return pieces.reduce((best, piece) => prefer(piece, best))
}

function orderPieces(pieces) {
  if (!pieces.length) return []
  const top = foremost(pieces)
  const rest = pieces.filter(piece => piece !== top).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.note < b.note ? -1 : 1
  })
  return [top, ...rest]
}

export function nodeState(form, pieces) {
  if (!form.enabled) return 'disabled'
  if (!pieces.length) return 'empty'
  const top = foremost(pieces)
  if (stageRank(top.stage) >= stageRank('2验证')) return 'validated'
  if (top.status === '已发布') return 'testing'
  return 'writing'
}

function xImpressions(piece) {
  const row = piece.distributions?.find(item => item.platform === 'X')
  return row ? row.impressions : undefined
}

function displayImpressions(piece) {
  if (piece.form === '短推') {
    const value = xImpressions(piece)
    return value === undefined ? null : value
  }
  const nums = piece.distributions.map(item => item.impressions).filter(item => item != null)
  return nums.length ? Math.max(...nums) : null
}

export function isVerified(piece, threshold) {
  if (!piece || piece.form !== '短推') return false
  const value = xImpressions(piece)
  return value != null && value > threshold
}

export function pieceMark(piece, threshold) {
  if (!piece || piece.status !== '已发布') return ''
  if (isVerified(piece, threshold)) return '已验证 ✓'
  if (piece.stage === '3升级') return '已升级'
  return ''
}

export function nodeLabel(state, piece, threshold) {
  if (state === 'disabled' || state === 'empty' || !piece) return '未开始'
  if (piece.status === '进行中') return '写作中'
  if (piece.status === '定稿') return '已定稿'
  if (piece.status !== '已发布') return piece.status || '未开始'
  if (piece.stage === '3升级' && !isVerified(piece, threshold)) return '已升级'
  const impressions = displayImpressions(piece)
  if (impressions == null) return '已发布 · 待填曝光'
  const mark = isVerified(piece, threshold) ? ' ✓' : ''
  return `已发布 · 曝光 ${formatNum(impressions)}${mark}`
}

function lineDisplayName(key) {
  const cut = key.indexOf('/')
  return cut >= 0 ? key.slice(cut + 1) : key
}

export function nextStep(nodes, forms, threshold) {
  const short = nodes.find(node => node.form === '短推')
  if (!short?.pieces.length) return '写第一条短推'
  const last = [...nodes].reverse().find(node => node.pieces.length)
  const top = foremost(last.pieces)
  const title = top.title
  if (top.status === '进行中') return `写完《${title}》并定稿`
  if (top.status === '定稿') return `发布《${title}》，然后回来确认已发布`
  const published = top.status === '已发布'
  const x = top.distributions.find(item => item.platform === 'X')
  if (published && top.form === '短推' && x && x.impressions == null) return `填写《${title}》的 X 曝光数`
  if (published && top.form === '短推' && top.stage === '1测试' && x && x.impressions != null && x.impressions <= threshold) {
    return `曝光 ${formatNum(x.impressions)}，未过 ${threshold}。换个角度再写一条短推`
  }
  const index = forms.findIndex(form => form.id === top.form)
  const nextForm = forms[index + 1]
  const nextNode = nextForm && nodes.find(node => node.form === nextForm.id)
  if (stageRank(top.stage) >= stageRank('2验证') && nextForm?.enabled && nextNode && nextNode.pieces.length === 0) {
    const impressions = top.form === '短推' ? x?.impressions : null
    if (impressions != null) return `曝光 ${formatNum(impressions)}，已验证。开始写${nextForm.id}`
    return `已验证。开始写${nextForm.id}`
  }
  if (published) {
    const done = new Set(top.distributions.map(item => item.platform))
    const missing = top.platforms.filter(platform => !done.has(platform))
    if (missing.length) return `分发到：${missing.join('、')}`
  }
  return '本阶段完成'
}

function originOf(pieces, originNotes) {
  const shorts = pieces.filter(piece => piece.form === '短推' && originNotes.has(piece.source))
  if (!shorts.length) return null
  return foremost(shorts).source
}

function platformRows(piece) {
  if (!piece) return []
  return piece.platforms.map(platform => {
    const distribution = piece.distributions.find(item => item.platform === platform) || null
    const schedule = piece.schedules.find(item => item.platform === platform) || null
    let state = 'open'
    if (distribution) state = 'published'
    else if (schedule) state = 'scheduled'
    return { platform, state, distribution, schedule }
  })
}

// 第二遍：长文并入的原子如果有自己的内容线，那条线的长文一格也放这篇长文，标 mergedIn。
// 那一格没有自己的长文时，整格随这篇长文走（mergedOnly），后面的空节点显示「随主线」，不可点。
function attachMerged(lines, pieces) {
  const merging = pieces.filter(piece => piece.form === '长文' && piece.merged?.length)
  if (!merging.length) return
  for (const line of lines) {
    if (!line.originNote) continue
    const into = merging.filter(piece => piece.lineKey !== line.key && piece.merged.includes(line.originNote))
    const index = line.nodes.findIndex(node => node.form === '长文')
    if (!into.length || index < 0) continue
    const node = line.nodes[index]
    const added = orderPieces(into).map(piece => ({ ...piece, mergedIn: true }))
    if (node.pieces.length) {
      node.pieces = [...node.pieces, ...added]
      continue
    }
    const title = added[0].title
    node.pieces = added
    node.mergedOnly = true
    node.state = nodeState(node, added)
    node.label = `并入《${title}》`
    node.platforms = []
    for (const later of line.nodes.slice(index + 1)) {
      if (later.pieces.length) continue
      later.followsMain = true
      later.label = '随主线'
    }
    line.next = `已并入《${title}》`
  }
}

export function buildBoard({ pieces, origins, threshold, forms, platforms }) {
  const originNotes = new Set(origins.map(origin => origin.note))
  const groups = new Map()
  for (const piece of pieces) {
    const key = piece.lineKey || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(piece)
  }
  const lines = [...groups.entries()].map(([key, group]) => {
    const nodes = forms.map(form => {
      const owned = group.filter(piece => piece.form === form.id)
      const ordered = orderPieces(owned)
      const state = nodeState(form, ordered)
      const top = ordered[0] || null
      return {
        form: form.id,
        enabled: form.enabled,
        state,
        label: nodeLabel(state, top, threshold),
        pieces: ordered,
        platforms: platformRows(top),
        mergedOnly: false,
        followsMain: false,
      }
    })
    const originNote = originOf(group, originNotes)
    const origin = originNote ? origins.find(item => item.note === originNote) : null
    return {
      key,
      name: lineDisplayName(key),
      originNote,
      originTitle: origin?.title || '',
      originId: origin?.path ? `atom:${origin.path}` : null,
      updatedAt: Math.max(...group.map(piece => piece.mtimeMs || 0)),
      nodes,
      next: nextStep(nodes, forms, threshold),
    }
  }).sort((a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  attachMerged(lines, pieces)

  return {
    threshold,
    forms: forms.map(form => ({ id: form.id, enabled: form.enabled })),
    platforms,
    lines,
    pieces: pieces.map(piece => ({
      ...piece,
      verified: isVerified(piece, threshold),
      mark: pieceMark(piece, threshold),
    })),
  }
}
