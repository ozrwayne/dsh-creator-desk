import { foremost, isVerified } from './board.js'

const FALLBACK_FORMS = [
  { id: '短推', enabled: true },
  { id: '长文', enabled: true },
  { id: '视频', enabled: true },
  { id: '播客', enabled: false },
]

const STATUS_LINK = /\/status\/\d+/

export function localStamp(now) {
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export function localDay(now) {
  return localStamp(now).slice(0, 10)
}

function dayNumber(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '')
  if (!match) return null
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000)
}

export function daysBetween(fromDay, toDay) {
  const from = dayNumber(fromDay)
  const to = dayNumber(toDay)
  if (from == null || to == null) return null
  return to - from
}

export function xRow(piece) {
  return (piece?.distributions || []).find(row => row.platform === 'X') || null
}

export function overdueSlots(piece, now) {
  const stamp = now instanceof Date ? localStamp(now) : String(now || '')
  const published = new Set((piece.distributions || []).map(row => row.platform))
  return (piece.schedules || []).filter(row => row.at && row.at < stamp && !published.has(row.platform))
}

export function needsImpressions(piece) {
  if (piece?.status !== '已发布') return false
  if (piece.form === '短推') {
    const row = xRow(piece)
    return !row || row.impressions == null
  }
  return !(piece.distributions || []).some(row => row.impressions != null)
}

export function staleImpressions(piece, now) {
  if (piece?.status !== '已发布' || piece.form !== '短推') return false
  const row = xRow(piece)
  if (!row || row.impressions != null) return false
  const days = daysBetween(String(row.date || '').slice(0, 10), now instanceof Date ? localDay(now) : String(now).slice(0, 10))
  return days != null && days > 2
}

export function missingStatusLink(piece) {
  if (piece?.status !== '已发布' || piece.form !== '短推') return false
  const row = xRow(piece)
  return !row || !STATUS_LINK.test(row.url || '')
}

export function missingPlatforms(piece) {
  if (piece?.status !== '已发布') return []
  const done = new Set([
    ...(piece.distributions || []).map(row => row.platform),
    ...(piece.schedules || []).map(row => row.platform),
  ])
  return (piece.platforms || []).filter(platform => !done.has(platform))
}

export function contentFlag(piece, flag, now) {
  if (flag === 'impressions') return needsImpressions(piece)
  if (flag === 'incomplete') return missingPlatforms(piece).length > 0
  if (flag === 'overdue') return overdueSlots(piece, now).length > 0
  return true
}


function lineTitle(board, key) {
  const line = (board.lines || []).find(item => item.key === key)
  return line?.originTitle || line?.name || key
}

export function buildTodo({ board, inbox, now = new Date(), x, bench } = {}) {
  const pieces = board?.pieces || []
  const threshold = Number.isFinite(board?.threshold) ? board.threshold : 3000
  const forms = board?.forms?.length ? board.forms : FALLBACK_FORMS
  const groups = []

  const overdue = []
  for (const piece of pieces) {
    for (const row of overdueSlots(piece, now)) {
      overdue.push({
        id: `overdue:${piece.note}:${row.platform}`,
        kind: 'piece',
        note: piece.note,
        platform: row.platform,
        title: piece.title,
        at: row.at,
      })
    }
  }
  overdue.sort((a, b) => (a.at < b.at ? -1 : 1))
  if (overdue.length) groups.push({ id: 'overdue', items: overdue })

  const suggestions = []
  for (const item of x?.suggestions || []) {
    const piece = pieces.find(row => row.note === item.note)
    if (!piece) continue
    suggestions.push({
      id: `suggest:${item.note}`,
      kind: 'suggest',
      note: item.note,
      title: piece.title,
      views: item.views,
      tweetId: item.tweetId,
      url: item.url,
      date: item.date,
    })
  }
  if (suggestions.length) groups.push({ id: 'suggest', items: suggestions })

  if (x?.lastError) {
    groups.push({
      id: 'xrefresh',
      items: [{ id: 'xrefresh', kind: 'xrefresh', reason: x.lastError }],
    })
  }

  const benchErrors = (bench?.accounts || []).filter(account => account.error || account.lastError)
  if (benchErrors.length) groups.push({
    id: 'bench',
    items: benchErrors.map(account => ({
      id: `bench:${account.handle}`, kind: 'bench', handle: account.handle,
      reason: account.error || account.lastError,
    })),
  })

  const impressions = pieces.filter(piece => staleImpressions(piece, now) && (!x || x.enabled === false || missingStatusLink(piece))).map(piece => ({
    id: `impressions:${piece.note}`,
    kind: 'piece',
    note: piece.note,
    platform: 'X',
    title: piece.title,
    date: xRow(piece)?.date || '',
  }))
  if (impressions.length) groups.push({ id: 'impressions', items: impressions })

  const links = pieces.filter(missingStatusLink).map(piece => ({
    id: `link:${piece.note}`,
    kind: 'piece',
    note: piece.note,
    platform: 'X',
    title: piece.title,
  }))
  if (links.length) groups.push({ id: 'link', items: links })

  const platforms = []
  for (const piece of pieces) {
    const missing = missingPlatforms(piece)
    if (!missing.length) continue
    platforms.push({
      id: `platforms:${piece.note}`,
      kind: 'piece',
      note: piece.note,
      platform: missing[0],
      title: piece.title,
      missing,
    })
  }
  if (platforms.length) groups.push({ id: 'platforms', items: platforms })

  const nextForm = forms.slice(forms.findIndex(form => form.id === '短推') + 1).find(form => form.enabled !== false)
  const byLine = new Map()
  for (const piece of pieces) {
    const key = piece.lineKey || ''
    if (!byLine.has(key)) byLine.set(key, [])
    byLine.get(key).push(piece)
  }
  const upgrade = []
  if (nextForm) {
    for (const [key, owned] of byLine) {
      const shorts = owned.filter(piece => piece.form === '短推')
      if (!shorts.length || !isVerified(foremost(shorts), threshold)) continue
      if (owned.some(piece => piece.form === nextForm.id)) continue
      // 这条线的原子已并入别的长文：流程页显示「已并入《…》」，不再提示写长文
      if ((board.lines || []).find(line => line.key === key)?.nodes.some(node => node.mergedOnly)) continue
      upgrade.push({
        id: `upgrade:${key}`,
        kind: 'line',
        lineKey: key,
        title: lineTitle(board, key),
        nextForm: nextForm.id,
      })
    }
  }
  if (upgrade.length) groups.push({ id: 'upgrade', items: upgrade })

  const pending = inbox?.counts?.pending ?? inbox?.pending?.length ?? 0
  if (pending > 0) {
    groups.push({
      id: 'pending',
      items: [{ id: 'pending', kind: 'pending', count: pending }],
    })
  }

  return { groups }
}

function sumImpressions(pieces) {
  let total = 0
  let any = false
  for (const piece of pieces) {
    for (const row of piece.distributions || []) {
      if (row.impressions == null) continue
      total += row.impressions
      any = true
    }
  }
  return any ? total : 0
}

export function pieceInsights(board) {
  const pieces = board?.pieces || []
  const threshold = Number.isFinite(board?.threshold) ? board.threshold : 3000
  const published = pieces.filter(piece => piece.status === '已发布')
  const shorts = published.filter(piece => piece.form === '短推')
  const verifiedShorts = shorts.filter(piece => isVerified(piece, threshold)).length
  const byLine = new Map()
  for (const piece of pieces) {
    const key = piece.lineKey || ''
    if (!byLine.has(key)) byLine.set(key, [])
    byLine.get(key).push(piece)
  }
  const lines = [...byLine.entries()].map(([key, owned]) => {
    const shortRows = owned.filter(piece => piece.form === '短推')
    const impressions = shortRows.map(piece => xRow(piece)?.impressions).filter(value => value != null)
    const platforms = new Set()
    for (const piece of owned) {
      for (const row of piece.distributions || []) platforms.add(row.platform)
    }
    return {
      key,
      title: lineTitle(board, key),
      impressions: impressions.length ? Math.max(...impressions) : null,
      verified: shortRows.some(piece => isVerified(piece, threshold)),
      longPublished: owned.some(piece => piece.form === '长文' && piece.status === '已发布'),
      platforms: platforms.size,
    }
  }).sort((a, b) => (b.impressions ?? -1) - (a.impressions ?? -1) || (a.title < b.title ? -1 : 1))
  return {
    published: published.length,
    impressions: sumImpressions(pieces),
    verifiedShorts,
    publishedShorts: shorts.length,
    lines,
  }
}
