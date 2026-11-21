// 监控的纯计算：累计观测不能相加，缺数不能变成零，定龄不能借未来数据。
import { createHash } from 'node:crypto'
import { localDay } from './todo.js'

export const DAY = 86400000
export const METRICS = ['views', 'impressions', 'likes', 'comments', 'saves', 'shares', 'quotes', 'stars', 'forks']
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const postKeyOf = (accountId, postId) => JSON.stringify([accountId, String(postId)])
export const blankValues = () => Object.fromEntries(METRICS.map(key => [key, null]))
export const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
export const errorOf = (status, message, code = 'invalid_input') => Object.assign(new Error(message), { status, code })

const ABSENT_QUALITIES = new Set(['missing', 'withheld', 'unsupported', 'invalid'])
const CONTENT_KINDS = new Set(['text', 'article', 'video', 'image', 'repo', 'original', 'quote'])
const ALGORITHM = 'age-baseline-v1'
const unknownPublication = () => ({ publishedAt: null, publishedDay: null, publishedPrecision: 'unknown' })
const exactCount = (value, quality) => quality === 'exact' && Number.isSafeInteger(value) && value >= 0
const compareKey = (a, b) => a < b ? -1 : a > b ? 1 : 0

function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const at = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === day
}

function shiftDay(day, offset) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

// Date.parse alone accepts date-only values, rollover dates and ambiguous local times.
function instant(raw) {
  if (raw instanceof Date) return +raw
  if (typeof raw === 'number') return Number.isFinite(raw) && Number.isFinite(+new Date(raw)) ? raw : NaN
  if (typeof raw !== 'string') return NaN
  const match = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})$/.exec(raw.trim())
  if (!match || !validDay(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return NaN
  return Date.parse(raw)
}

function requiredInstant(raw) {
  const at = instant(raw)
  if (!Number.isFinite(at)) throw errorOf(400, '观测时间须为带时区的完整时间', 'invalid_observation_time')
  return at
}

function signedCount(raw) {
  if (typeof raw === 'string' && /^[+-]?\d+$/.test(raw.trim())) raw = Number(raw)
  return Number.isSafeInteger(raw) ? raw : null
}

function sameSource(a, b) {
  return a.accountId === b.accountId && a.platform === b.platform && a.contentKind === b.contentKind
    && a.collectorId === b.collectorId && a.measurementSet === b.measurementSet && a.channel === b.channel
}

function newer(row, at, old) {
  return !old || at > old.at || (at === old.at && compareKey(row.sampleKey, old.row.sampleKey) < 0)
}

export function countValue(raw) {
  if (raw == null || raw === '' || (typeof raw === 'string' && !raw.trim())) return { value: null, quality: 'missing' }
  if (typeof raw !== 'string' && typeof raw !== 'number') return { value: null, quality: 'invalid' }
  const text = String(raw).trim()
  if (text.includes(',') && !/^\d{1,3}(,\d{3})*(\.\d+)?\s*(万|亿|[kKmMwW])?$/.test(text)) return { value: null, quality: 'invalid' }
  const match = /^(\d+(?:\.\d+)?)\s*(万|亿|[kKmMwW])?$/.exec(text.replaceAll(',', ''))
  if (!match) return { value: null, quality: 'invalid' }
  const unit = match[2]?.toLowerCase(), scale = { 万: 4, 亿: 8, k: 3, m: 6, w: 4 }[unit] || 0
  const [whole, fraction = ''] = match[1].split('.')
  if (/[1-9]/.test(fraction.slice(scale))) return { value: null, quality: 'invalid' }
  const value = Number(whole + fraction.padEnd(scale, '0').slice(0, scale))
  if (!Number.isSafeInteger(value) || value < 0) return { value: null, quality: 'invalid' }
  return { value, quality: unit ? 'rounded' : 'exact' }
}

export function publishedTime(raw) {
  if (typeof raw === 'string') raw = raw.trim()
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return validDay(raw) ? { publishedAt: null, publishedDay: raw, publishedPrecision: 'day' } : unknownPublication()
  }
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' && /^(?:\d{10}|\d{13})$/.test(raw) ? Number(raw) : NaN
  const at = Number.isFinite(numeric) ? instant(numeric * (numeric < 1e11 ? 1000 : 1)) : instant(raw)
  if (!Number.isFinite(at) || at < 0) return unknownPublication()
  const date = new Date(at)
  return { publishedAt: date.toISOString(), publishedDay: localDay(date), publishedPrecision: 'second' }
}

export function observation(account, row, { runKey, observedAt, scheduledAt = observedAt, collectorId, channel, measurementSet, coverage, legacy = false }, old) {
  const at = requiredInstant(observedAt)
  observedAt = new Date(at).toISOString()
  scheduledAt = new Date(requiredInstant(scheduledAt)).toISOString()
  const postId = String(row.id)
  const postKey = postKeyOf(account.accountId, postId)
  let time = row.publishedPrecision === 'unknown' ? unknownPublication()
    : publishedTime(row.publishedAt ?? row.publishedDay)
  if (time.publishedPrecision === 'unknown' && row.publishedPrecision !== 'unknown') time = publishedTime(row.publishedDay)
  if (row.publishedPrecision === 'day') {
    const day = validDay(row.publishedDay) ? row.publishedDay : time.publishedDay
    time = day ? { publishedAt: null, publishedDay: day, publishedPrecision: 'day' } : unknownPublication()
  }
  // A less precise response cannot erase an already established publication instant.
  const retainPublication = old && (time.publishedPrecision === 'unknown' || (old.publishedPrecision === 'second' && time.publishedPrecision === 'day'))
  const publication = retainPublication
    ? { publishedAt: old.publishedAt, publishedDay: old.publishedDay, publishedPrecision: old.publishedPrecision } : time
  const changed = old && ['publishedAt', 'publishedDay', 'publishedPrecision'].some(key => (old[key] ?? null) !== (publication[key] ?? null))
  const publicationRevision = (old?.publicationRevision || 1) + (changed ? 1 : 0)
  const contentKind = row.contentKind && row.contentKind !== 'unknown' ? row.contentKind
    : old?.contentKind || row.contentKind || (account.platform === 'GitHub' ? 'repo' : 'unknown')
  const values = {}, quality = {}, sourceFields = {}
  for (const key of METRICS) {
    const parsed = countValue(row[key]), declared = row.quality?.[key]
    // A collector may downgrade precision, never promote a rounded/invalid raw value.
    quality[key] = ABSENT_QUALITIES.has(declared) ? declared
      : parsed.value == null ? parsed.quality : declared === 'rounded' || parsed.quality === 'rounded' ? 'rounded' : parsed.quality
    values[key] = ABSENT_QUALITIES.has(quality[key]) ? null : parsed.value
    sourceFields[key] = row.sourceFields?.[key] || (row[key] != null ? key : null)
  }
  const first = instant(old?.firstSeenAt), last = instant(old?.lastSeenAt)
  const post = {
    schemaVersion: 1, postKey, accountId: account.accountId, platform: account.platform, postId,
    url: /^https?:\/\//i.test(row.url || '') ? row.url : old?.url || null, title: String(row.title || row.text || old?.title || '').split('\n')[0].slice(0, 500),
    contentKind, ...publication, publishedSource: retainPublication ? old.publishedSource || null : row.publishedSource || (legacy ? 'legacy' : old?.publishedSource || null),
    publicationRevision, firstSeenAt: new Date(Number.isFinite(first) ? Math.min(first, at) : at).toISOString(),
    lastSeenAt: new Date(Number.isFinite(last) ? Math.max(last, at) : at).toISOString(),
    status: 'active', pieceNote: row.note || old?.pieceNote || null, linkMatch: row.note ? 'confirmed' : old?.linkMatch || 'none',
    discoveryCollectorId: old?.discoveryCollectorId || collectorId, sourceRunKey: runKey,
  }
  const seriesKey = hash([account.accountId, account.platform, contentKind, collectorId, measurementSet])
  const sample = {
    schemaVersion: 1, sampleKey: hash([runKey, postKey, collectorId]), runKey, accountId: account.accountId,
    postKey, platform: account.platform, collectorId, channel, seriesKey, measurementSet,
    scheduledAt, observedAt, day: localDay(new Date(at)), timeZone: zone(), values, quality, sourceFields,
    identityCheck: row.identityCheck || 'request_bound', coverage,
    publishedAt: post.publishedAt, publicationRevision, contentKind, legacy,
  }
  return { post, sample }
}

export function dailySeries(samples, { from, to, now = new Date() } = {}) {
  const asOf = requiredInstant(now), timeZone = zone()
  if ((from && !validDay(from)) || (to && !validDay(to))) throw errorOf(400, '日期格式须为 YYYY-MM-DD')
  const contextFrom = from ? shiftDay(from, -1) : null
  const selected = new Map()
  for (const s of samples) {
    if (!validDay(s.day) || (contextFrom && s.day < contextFrom) || (to && s.day > to)) continue
    const at = instant(s.observedAt)
    if (!Number.isFinite(at) || at > asOf || localDay(new Date(at)) !== s.day || (s.timeZone && s.timeZone !== timeZone)) continue
    if (s.identityCheck && !['response', 'request_bound'].includes(s.identityCheck)) continue
    const key = JSON.stringify([s.day, s.postKey, s.seriesKey])
    if (newer(s, at, selected.get(key))) selected.set(key, { row: s, at })
  }
  return [...selected.entries()].filter(([, { row }]) => !from || row.day >= from)
    .sort(([a], [b]) => compareKey(a, b)).map(([dailyKey, { row: s }]) => {
      const [y, m, d] = s.day.split('-').map(Number), previousDay = shiftDay(s.day, -1)
      const prior = selected.get(JSON.stringify([previousDay, s.postKey, s.seriesKey]))?.row
      const previous = prior && sameSource(prior, s) && prior.timeZone === s.timeZone ? prior : null
      const cutoff = new Date(y, m - 1, d + 1)
      return {
        schemaVersion: 1, dailyKey, day: s.day, timeZone: s.timeZone, cutoffAt: cutoff.toISOString(),
        accountId: s.accountId, postKey: s.postKey, seriesKey: s.seriesKey, measurementSet: s.measurementSet,
        closed: +cutoff <= asOf, selectedSampleKey: s.sampleKey, observedAt: s.observedAt,
        values: s.values, quality: s.quality, previousDay: previous ? previousDay : null,
        deltaValues: Object.fromEntries(METRICS.map(key => [key, previous && exactCount(previous.values?.[key], previous.quality?.[key]) && exactCount(s.values?.[key], s.quality?.[key]) ? s.values[key] - previous.values[key] : null])),
        coverage: 'partial', updatedAt: s.observedAt,
      }
    })
}

export function followerObservation(account, total, { runKey, observedAt, collectorId, source = 'live', method = 'observed', day, gain = null, loss = null, net = null, baseDays = [], timeZone = zone() } = {}) {
  const parsed = countValue(total), at = instant(observedAt)
  if (parsed.value == null || !Number.isFinite(at) || timeZone !== zone() || !['live', 'backfill'].includes(source)) return null
  observedAt = new Date(at).toISOString()
  const today = localDay(new Date(at))
  day ??= today
  if (!validDay(day) || day > today || (source === 'live' && day !== today)) return null
  const metricKind = account.platform === 'YouTube' ? 'subscribers' : 'followers'
  const dailyNet = signedCount(net), added = countValue(gain), removed = countValue(loss)
  return {
    schemaVersion: 1, dailyKey: JSON.stringify([account.accountId, metricKind, day]),
    followerKey: hash([runKey, account.accountId, metricKind, day, source]), accountId: account.accountId,
    platform: account.platform, metricKind, day, timeZone, observedAt,
    effectiveAt: source === 'live' ? observedAt : null, precision: source === 'live' ? 'second' : 'day',
    total: parsed.value, gain: added.quality === 'exact' ? added.value : null, loss: removed.quality === 'exact' ? removed.value : null,
    net: dailyNet, source, method, quality: parsed.quality,
    collectorId, runKey, baseDays: [...baseDays], spanDays: dailyNet == null ? null : 1,
  }
}

export function followerDaily(observations) {
  const selected = new Map(), timeZone = zone()
  for (const row of observations) {
    if (!row || !validDay(row.day) || !Number.isSafeInteger(row.total) || row.total < 0 || !['live', 'backfill'].includes(row.source)) continue
    if (row.timeZone && row.timeZone !== timeZone) continue
    const at = instant(row.observedAt)
    if (!Number.isFinite(at) || row.day > localDay(new Date(at)) || (row.source === 'live' && row.day !== localDay(new Date(at)))) continue
    const old = selected.get(row.dailyKey)
    if (!old || (row.source === 'live' && old.row.source !== 'live')
      || (row.source === old.row.source && (at > old.at || (at === old.at && compareKey(row.followerKey, old.row.followerKey) < 0)))) selected.set(row.dailyKey, { row, at })
  }
  return [...selected.values()].map(({ row }) => row).sort((a, b) => compareKey(a.day, b.day) || compareKey(a.dailyKey, b.dailyKey)).map(row => {
    const previous = selected.get(JSON.stringify([row.accountId, row.metricKind, shiftDay(row.day, -1)]))?.row
    const comparable = previous && previous.platform === row.platform && previous.collectorId === row.collectorId
      && previous.source === row.source && previous.precision === row.precision && previous.timeZone === row.timeZone
    return { ...row, change: comparable && exactCount(previous.total, previous.quality) && exactCount(row.total, row.quality) ? row.total - previous.total : null }
  })
}

export function reconstructFollowers(account, { total, todayNet, history }, meta) {
  const parsed = countValue(total), net = signedCount(todayNet), at = instant(meta?.observedAt)
  if (parsed.quality !== 'exact' || net == null || !Number.isFinite(at) || !Array.isArray(history)) return []
  const timeZone = meta.timeZone || zone()
  if (timeZone !== zone()) return []
  const today = localDay(new Date(at)), baseDays = [today], out = []
  const rows = [...history].sort((a, b) => compareKey(b?.day, a?.day))
  let expected = shiftDay(today, -1), running = parsed.value - net
  if (!Number.isSafeInteger(running) || running < 0) return []
  for (const row of rows) {
    const dailyNet = signedCount(row?.net)
    if (row?.day !== expected || dailyNet == null || (row.timeZone && row.timeZone !== timeZone)
      || (Object.hasOwn(row, 'spanDays') && row.spanDays !== 1) || (row.quality && row.quality !== 'exact')) return []
    const previous = running - dailyNet
    if (!Number.isSafeInteger(previous) || previous < 0) return []
    const observation = followerObservation(account, running, { ...meta, timeZone, source: 'backfill', method: 'reconstructed', day: row.day, gain: row.gain ?? null, loss: row.loss ?? null, net: dailyNet, baseDays })
    if (!observation) return []
    out.push(observation)
    baseDays.push(row.day)
    running = previous
    expected = shiftDay(expected, -1)
  }
  return out
}

export function ageSample(post, samples, ageDays, seriesKey, asOf = Date.now(), maxLagSeconds = 21600) {
  if (![1, 3, 7].includes(ageDays)) throw errorOf(400, '只支持发布后第 1、3、7 天')
  if (!Number.isFinite(maxLagSeconds) || maxLagSeconds < 0) throw errorOf(400, '最大滞后秒数无效')
  const now = requiredInstant(asOf), publishedAt = instant(post?.publishedAt)
  if (!Number.isFinite(publishedAt) || post.publishedPrecision !== 'second') return { status: 'publication_time_unknown', targetAt: null, selected: null }
  const target = publishedAt + ageDays * DAY
  if (!Number.isFinite(+new Date(target))) return { status: 'publication_time_unknown', targetAt: null, selected: null }
  const targetAt = new Date(target).toISOString()
  if (now < target) return { status: 'not_due', targetAt, selected: null }
  let latest
  for (const s of samples) {
    if (!eligibleSample(post, s) || s.seriesKey !== seriesKey) continue
    const at = instant(s.observedAt)
    if (!Number.isFinite(at) || at < publishedAt || at > target) continue
    if (newer(s, at, latest)) latest = { row: s, at }
  }
  if (!latest) return { status: 'missing', targetAt, selected: null }
  const lagSeconds = (target - latest.at) / 1000
  return { status: lagSeconds > maxLagSeconds ? 'stale_at_age' : 'ready', targetAt, selected: { ...latest.row, lagSeconds, maxLagSeconds } }
}

function eligibleSample(post, sample) {
  return sample.postKey === post.postKey && !sample.legacy && sample.publicationRevision === post.publicationRevision
    && sample.accountId === post.accountId && sample.platform === post.platform && sample.contentKind === post.contentKind
    && ['response', 'request_bound'].includes(sample.identityCheck)
    && instant(sample.publishedAt) === instant(post.publishedAt)
}

export function cohort(post, posts, samples, { ageDays = 3, seriesKey, asOf = Date.now() } = {}) {
  const now = requiredInstant(asOf), p = instant(post.publishedAt), target = p + ageDays * DAY
  // One pass indexes history; each post's age selection then scans only its own observations.
  const byPost = new Map()
  for (const sample of samples) {
    const rows = byPost.get(sample.postKey)
    if (rows) rows.push(sample)
    else byPost.set(sample.postKey, [sample])
  }
  let latest, beforeTarget
  for (const sample of byPost.get(post.postKey) || []) {
    if ((seriesKey && sample.seriesKey !== seriesKey) || !eligibleSample(post, sample)) continue
    const at = instant(sample.observedAt)
    if (!Number.isFinite(at) || at > now || at < p) continue
    if (newer(sample, at, latest)) latest = { row: sample, at }
    if (at <= target && newer(sample, at, beforeTarget)) beforeTarget = { row: sample, at }
  }
  const source = (beforeTarget || latest)?.row, selectedSeries = seriesKey || source?.seriesKey || ''
  const current = ageSample(post, byPost.get(post.postKey) || [], ageDays, selectedSeries, now)
  const windowStart = Number.isFinite(p) ? new Date(p - 30 * DAY).toISOString() : null
  const members = [], excludedCounts = { missingOrStale: 0, nonExact: 0 }, unique = new Map()
  const eligibleKind = CONTENT_KINDS.has(post.contentKind)
  for (const other of posts) {
    if (other.postKey === post.postKey) continue
    const old = unique.get(other.postKey)
    if (!old || other.publicationRevision > old.publicationRevision
      || (other.publicationRevision === old.publicationRevision && compareKey(other.lastSeenAt || '', old.lastSeenAt || '') > 0)) unique.set(other.postKey, other)
  }
  const candidates = [...unique.values()].filter(other => eligibleKind && other.accountId === post.accountId && other.platform === post.platform
    && other.contentKind === post.contentKind && other.publishedPrecision === 'second'
    && instant(other.publishedAt) >= p - 30 * DAY && instant(other.publishedAt) < p)
    .sort((a, b) => instant(a.publishedAt) - instant(b.publishedAt) || compareKey(a.postKey, b.postKey))
  for (const other of candidates) {
    const compatible = (byPost.get(other.postKey) || []).filter(sample => source && sameSource(source, sample))
    const point = ageSample(other, compatible, ageDays, selectedSeries, now)
    if (point.status !== 'ready') { excludedCounts.missingOrStale++; continue }
    if (!exactCount(point.selected.values?.views, point.selected.quality?.views)) { excludedCounts.nonExact++; continue }
    members.push({ postKey: other.postKey, postId: other.postId, publishedAt: other.publishedAt, publicationRevision: other.publicationRevision,
      sampleKey: point.selected.sampleKey, observedAt: point.selected.observedAt, views: point.selected.values.views })
  }
  const values = members.map(row => row.views).sort((a, b) => a - b), n = values.length
  const lo = values[Math.floor((n - 1) / 2)], hi = values[Math.floor(n / 2)]
  const median = n ? lo + (hi - lo) / 2 : null
  const exact = current.status === 'ready' && exactCount(current.selected.values?.views, current.selected.quality?.views)
  const v = exact ? current.selected.values.views : null
  const multiple = eligibleKind && v != null && n >= 8 && median > 0 ? v / median : null
  const saveRate = v > 0 && exactCount(current.selected.values?.saves, current.selected.quality?.saves) ? current.selected.values.saves / v : null
  // A complete page and enough examples are separate requirements for unqualified comparisons.
  const complete = source?.coverage?.complete === true && candidates.length === members.length
  const multipleReason = !eligibleKind ? 'content_kind_ineligible' : !exact ? current.status === 'ready' ? 'non_exact_current' : current.status
    : n < 8 ? 'insufficient_baseline' : median === 0 ? 'zero_baseline' : null
  const generatedAt = new Date(now).toISOString()
  return {
    schemaVersion: 1, algorithmVersion: ALGORITHM, cohortKey: hash([post.postKey, ageDays, selectedSeries, post.publicationRevision, ALGORITHM]),
    inputRevision: hash([ALGORITHM, post.accountId, post.platform, post.contentKind, post.publishedAt, post.publicationRevision,
      ageDays, selectedSeries, current.status, current.selected?.sampleKey, members, excludedCounts, complete]),
    accountId: post.accountId, platform: post.platform, postKey: post.postKey, postId: post.postId, contentKind: post.contentKind,
    publishedAt: post.publishedAt, ageDays, seriesKey: selectedSeries, collectorId: source?.collectorId || null,
    measurementSet: source?.measurementSet || null, ...current, asOf: generatedAt,
    baseline: { windowStart, windowEndExclusive: post.publishedAt, samples: n, minimumSamples: 8, sufficient: n >= 8, median, members, excludedCounts, coverage: complete ? 'complete' : 'observed_only' },
    relative: { multiple, saveRate, comparisonEligible: complete && multiple != null, multipleReason },
    attribution: 'concurrent_only', generatedAt,
  }
}
