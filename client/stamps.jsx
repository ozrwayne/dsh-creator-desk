// 邮票灵感日历：每天一张邮票，逼自己多记一点。
import React from 'react'
import { openCapture } from './card.jsx'
import { openItem, setDesk, useDesk } from './desk.js'
import { plural, t } from './i18n.js'
import { Icon } from './ui.jsx'
import { dayKey, hash, posterOf, isIdea, streakOf } from './util.js'

export function useDayMap() {
  const items = useDesk(s => s.state.items)
  return React.useMemo(() => {
    const map = new Map()
    for (const item of items) {
      if (!isIdea(item)) continue
      const key = dayKey(item.createdAt)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(item)
    }
    return map
  }, [items])
}

function coverOf(list) {
  // 优先用当天带图的内容做邮票
  return list.find(item => posterOf(item)) ?? list[0]
}

export function Stamp({ list, today, onOpen, label }) {
  if (!list?.length) {
    return (
      <button type="button" className={`md-stamp is-blank ${today ? 'is-today' : ''}`} aria-label={today ? t('今天还没有记录，点击记录一条') : t('{label} 没有记录', { label })} onClick={today ? () => openCapture('text') : undefined} disabled={!today}>
        {today ? <Icon name="plus" size={16} /> : null}
      </button>
    )
  }
  const cover = coverOf(list)
  const poster = posterOf(cover)
  return (
    <button type="button" className={`md-stamp ${poster ? '' : `is-type tone-${hash(cover.id) % 6}`}`} aria-label={t('{label}：{title}，共 {n} 条', { label, title: cover.title, n: list.length })} title={cover.title} onClick={onOpen}>
      {poster ? <img src={poster} alt="" loading="lazy" draggable={false} /> : <span>{cover.title.slice(0, 1)}</span>}
      {list.length > 1 ? <i>{list.length}</i> : null}
    </button>
  )
}

/** 某天有记录：那天有收藏，或工作台随手记了灵感。收藏天数还没回来时返回 null。 */
export function recordedDays(inbox, items) {
  if (!Array.isArray(inbox?.days)) return null
  const days = new Set()
  for (const row of inbox.days) {
    if (row?.favorites > 0 && row.date) days.add(row.date)
  }
  for (const item of items || []) {
    if (isIdea(item) && item.createdAt) days.add(dayKey(item.createdAt))
  }
  return days
}

export function favoriteCount(inbox, key) {
  return inbox?.days?.find(row => row.date === key)?.favorites || 0
}

function CountStamp({ n, today, label }) {
  if (!n) {
    return (
      <button type="button" className={`md-stamp is-blank ${today ? 'is-today' : ''}`} aria-label={today ? t('今天还没有记录，点击记录一条') : t('{label} 没有记录', { label })} onClick={today ? () => openCapture('text') : undefined} disabled={!today}>
        {today ? <Icon name="plus" size={16} /> : null}
      </button>
    )
  }
  return (
    <button type="button" className={`md-stamp is-type is-count ${today ? 'is-today' : ''}`} aria-label={t('{label}：{n} 篇收藏', { label, n, s: plural(n, '', 's') })} onClick={() => setDesk({ view: 'schedule' })}>
      <span>{n}</span>
    </button>
  )
}


/** 首屏文字下方：最近十天，有收藏的显示篇数。 */
export function MiniStamps() {
  const items = useDesk(s => s.state.items)
  const inbox = useDesk(s => s.inbox)
  const ready = Array.isArray(inbox?.days)
  const days = ready ? recordedDays(inbox, items) : null
  const streak = days ? streakOf(days) : 0
  const now = new Date()
  const cells = []
  for (let i = 9; i >= 0; i -= 1) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    cells.push(d)
  }
  return (
    <div className="md-ministamps">
      <div className="md-ministamps-row">
        {ready ? cells.map((d) => {
          const key = dayKey(d)
          return <CountStamp key={key} n={favoriteCount(inbox, key)} today={key === dayKey(now)} label={t('{m}月{d}日', { m: d.getMonth() + 1, d: d.getDate(), mon: d.toLocaleString('en-US', { month: 'short' }) })} />
        }) : cells.map((d) => <span key={dayKey(d)} className="md-stamp is-blank is-wait" />)}
      </div>
      {streak > 0 ? <span className="md-ministamps-streak">{t('连续 {n} 天有记录', { n: streak, s: plural(streak, '', 's') })}</span> : null}
      <button type="button" className="md-ministamps-more" onClick={() => setDesk({ view: 'schedule' })} title={t('打开灵感日历')} aria-label={streak > 0 ? t('打开灵感日历，已连续记录 {n} 天', { n: streak }) : t('打开灵感日历')}><Icon name="upRight" size={14} /></button>
    </div>
  )
}
