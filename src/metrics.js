function fail(status, message) {
  return Object.assign(new Error(message), { status })
}

export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += ch
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function cell(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim()
}

export function readMetrics(csv) {
  const rows = parseCsv(csv)
  const header = (rows[0] || []).map(item => cell(item).toLowerCase())
  const idIdx = header.findIndex(name => name === 'post id' || name === 'tweet id')
  const impIdx = header.findIndex(name => name === 'impressions')
  const missing = []
  if (idIdx < 0) missing.push('Post id')
  if (impIdx < 0) missing.push('Impressions')
  if (missing.length) throw fail(400, `缺少列：${missing.join('、')}`)
  const data = []
  for (const row of rows.slice(1)) {
    if (row.every(item => cell(item) === '')) continue
    const postId = cell(row[idIdx])
    const raw = cell(row[impIdx]).replace(/,/g, '')
    const impressions = /^\d+$/.test(raw) ? Number(raw) : null
    data.push({ postId, impressions })
  }
  return data
}

function statusId(url) {
  const match = /\/status\/(\d+)/.exec(url || '')
  return match ? match[1] : null
}

export function planImport(csv, pieces) {
  const rows = readMetrics(csv)
  const byId = new Map()
  for (const piece of pieces) {
    for (const dist of piece.distributions) {
      if (dist.platform !== 'X') continue
      const id = statusId(dist.url)
      if (!id) continue
      if (!byId.has(id)) byId.set(id, [])
      byId.get(id).push(piece)
    }
  }
  const hits = []
  let unmatched = 0
  for (const row of rows) {
    const found = row.postId && row.impressions != null ? byId.get(row.postId) : null
    if (!found?.length) {
      unmatched++
      continue
    }
    for (const piece of found) {
      hits.push({ note: piece.note, title: piece.title, form: piece.form, impressions: row.impressions })
    }
  }
  return { hits, unmatched }
}
