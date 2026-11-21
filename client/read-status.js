import { lang } from './i18n.js'

const tr = (zh, en) => lang() === 'en' ? en : zh
const time = at => new Date(at).toLocaleString(lang() === 'en' ? 'en-AU' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const stale = (at, hours, now) => hours > 0 && now - Date.parse(at) >= hours * 3600000

function readLabel(at, hours, result, warn, now) {
  const parts = [Number.isFinite(Date.parse(at)) ? tr(`上次成功 ${time(at)}`, `Last success ${time(at)}`) : tr('暂无成功读取记录', 'No successful read recorded')]
  const overdue = stale(at, hours, now)
  if (overdue) parts.push(tr('数据可能已旧', 'Possibly stale'))
  if (result) parts.push(result)
  return { label: parts.join(' · '), warn: warn || overdue || !at }
}

export function exposureLabel(status, now = Date.now()) {
  if (!status) return { label: tr('读取状态待载入', 'Loading read status'), warn: false }
  const result = status.lastError ? tr('最近读取失败', 'Last read failed') : status.lastNote === '无需刷新' ? tr('无需刷新', 'Nothing to refresh') : status.lastNote ? tr('部分结果未取到', 'Incomplete read') : status.lastSuccessAt && status.lastSuccessAt === status.lastRunAt ? tr(`更新 ${status.updated.length} 篇`, `${status.updated.length} updated`) : ''
  return readLabel(status.lastSuccessAt, status.enabled ? status.everyHours : 0, result, Boolean(status.lastError || (status.lastNote && status.lastNote !== '无需刷新')), now)
}

export function benchmarkLabel(accounts, now = Date.now()) {
  const tracked = accounts.filter(a => !a.library)
  if (!tracked.length) return { label: accounts.length ? tr('资料库样本 · 无采集记录', 'Library samples · No collection record') : tr('无可用读取记录', 'No read records'), warn: false }
  if (tracked.length === 1) {
    const a = tracked[0]
    const result = a.error ? tr('最近读取失败', 'Last read failed') : a.missed || a.failed?.length ? tr('部分帖子未取到', 'Incomplete read') : Number.isInteger(a.added) ? tr(`新增 ${a.added} 条`, `${a.added} new`) : ''
    return readLabel(a.lastSuccessAt, a.enabled === false ? 0 : a.periodHours, result, Boolean(a.error || a.missed || a.failed?.length), now)
  }
  let latest = null, overdue = 0, unknown = 0, failed = 0
  for (const a of tracked) {
    if (a.error || a.missed || a.failed?.length) failed++
    if (!Number.isFinite(Date.parse(a.lastSuccessAt))) { unknown++; continue }
    if (!latest || Date.parse(a.lastSuccessAt) > Date.parse(latest)) latest = a.lastSuccessAt
    if (a.enabled !== false && stale(a.lastSuccessAt, a.periodHours, now)) overdue++
  }
  const parts = [latest ? tr(`最近成功 ${time(latest)}`, `Latest success ${time(latest)}`) : tr('暂无成功读取记录', 'No successful read recorded')]
  if (overdue) parts.push(tr(`${overdue} 个账号数据可能已旧`, `${overdue} possibly stale`))
  if (unknown) parts.push(tr(`${unknown} 个无成功记录`, `${unknown} unconfirmed`))
  if (failed) parts.push(tr(`${failed} 个读取异常`, `${failed} incomplete or failed`))
  return { label: parts.join(' · '), warn: Boolean(overdue || unknown || failed) }
}
