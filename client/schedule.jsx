// 排期：多平台品牌色 Bento 日历矩阵与待排期拖拽托盘。
import React from 'react'
import { openItem, openPiece, schedulePiece, report, useDesk } from './desk.js'
import { lang, t, useLang } from './i18n.js'
import { PlatformLogo, platformColor } from './platforms.jsx'
import { Stamp, useDayMap, recordedDays } from './stamps.jsx'
import { Dialog, Icon, IconButton } from './ui.jsx'
import { dayKey, fmtDate, streakOf, unit } from './util.js'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const TYPE = 'text/media-desk-slot'

function slotId(note, platform) {
  return `${note}\n${platform}`
}

function readSlot(event) {
  const raw = event.dataTransfer.getData(TYPE)
  const [note, platform] = raw.split('\n')
  return note && platform ? { note, platform } : null
}

function startDrag(event, note, platform) {
  event.dataTransfer.setData(TYPE, slotId(note, platform))
  event.dataTransfer.effectAllowed = 'move'
}

function barsOf(pieces) {
  const bars = []
  for (const piece of pieces) {
    for (const row of piece.distributions || []) {
      if (!row.date) continue
      bars.push({ note: piece.note, title: piece.title, platform: row.platform, day: row.date, kind: 'published', at: row.date })
    }
    for (const row of piece.schedules || []) {
      bars.push({ note: piece.note, title: piece.title, platform: row.platform, day: row.at.slice(0, 10), kind: 'scheduled', at: row.at })
    }
  }
  return bars
}

function waitingOf(pieces) {
  const rows = []
  for (const piece of pieces) {
    if (piece.status !== '定稿' && piece.status !== '已发布') continue
    const done = new Set([...(piece.distributions || []).map(row => row.platform), ...(piece.schedules || []).map(row => row.platform)])
    for (const platform of piece.platforms || []) {
      if (!done.has(platform)) rows.push({ note: piece.note, title: piece.title, platform })
    }
  }
  return rows
}

function Chip({ bar, late }) {
  const time = bar.at.length > 10 ? bar.at.slice(11) : ''
  const color = platformColor(bar.platform)
  return (
    <button
      type="button"
      className={`md-cal-chip ${bar.kind === 'published' ? 'status-published' : 'status-ready'}${late ? ' is-late' : ''}`}
      style={{ '--plat-c': color }}
      draggable={bar.kind === 'scheduled'}
      title={`${time} ${bar.platform} ${bar.title}`.trim()}
      onDragStart={event => bar.kind === 'scheduled' && startDrag(event, bar.note, bar.platform)}
      onClick={() => openPiece(bar.note, bar.platform)}
    >
      <PlatformLogo platform={bar.platform} size={14} />
      <span className="md-cal-chip-copy">
        {time ? <time>{time}</time> : null}
        <b>{bar.title}</b>
      </span>
    </button>
  )
}

function isLate(bar, pieces, stamp) {
  if (bar.kind !== 'scheduled' || !(bar.at < stamp)) return false
  const piece = pieces.find(item => item.note === bar.note)
  return !piece?.distributions?.some(row => row.platform === bar.platform)
}

function Calendar({ pieces }) {
  useLang()
  const [cursor, setCursor] = React.useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [over, setOver] = React.useState(null)
  const [dayOpen, setDayOpen] = React.useState(null)
  const days = useDayMap()
  const y = cursor.getFullYear()
  const m = cursor.getMonth()
  const first = new Date(y, m, 1).getDay()
  const cells = []
  for (let i = 0; i < 42; i += 1) cells.push(new Date(y, m, i - first + 1))
  const rows = cells[28].getMonth() !== m ? cells.slice(0, 28) : cells[35].getMonth() === m ? cells : cells.slice(0, 35)
  const bars = React.useMemo(() => barsOf(pieces), [pieces])
  const byDay = React.useMemo(() => {
    const map = new Map()
    for (const bar of bars) {
      if (!map.has(bar.day)) map.set(bar.day, [])
      map.get(bar.day).push(bar)
    }
    return map
  }, [bars])
  const today = dayKey(new Date())
  const stamp = `${today} ${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`
  const prefix = `${y}-${String(m + 1).padStart(2, '0')}`
  const inbox = useDesk(s => s.inbox)
  const items = useDesk(s => s.state?.items || [])
  const recorded = recordedDays(inbox, items)
  const monthSaves = recorded ? (inbox.days || []).filter(row => row.date.startsWith(prefix)).reduce((sum, row) => sum + (row.favorites || 0), 0) : null
  const monthPosts = bars.filter(bar => bar.kind === 'published' && bar.day.startsWith(prefix)).length
  const streak = recorded ? streakOf(recorded) : null
  const drop = async (date, event) => {
    event.preventDefault()
    setOver(null)
    const slot = readSlot(event)
    if (!slot) return
    const existing = pieces.find(piece => piece.note === slot.note)?.schedules?.find(row => row.platform === slot.platform)
    const at = `${dayKey(date)} ${existing?.at?.slice(11) || '20:00'}`
    try { await schedulePiece({ note: slot.note, platform: slot.platform, at }) } catch (err) { report(err) }
  }
  return (
    <section className="md-bento-card md-tile md-cal-tile">
      <header className="md-cal-head">
        <div className="md-cal-brand-date">
          <div className="md-cal-num">{String(m + 1).padStart(2, '0')}</div>
          <div className="md-cal-month"><span>{y}</span><em>{lang() === 'en' ? MONTHS[m] : `${m + 1} 月`}</em></div>
        </div>
        <dl className="md-cal-stats">
          <div className="md-cal-stat-pill"><dt>{t('连续记录')}</dt><dd>{streak == null ? '—' : streak}<small>{unit(streak || 0, '天')}</small></dd></div>
          <div className="md-cal-stat-pill"><dt>{t('本月收藏')}</dt><dd>{monthSaves == null ? '—' : monthSaves}<small>{t('条')}</small></dd></div>
          <div className="md-cal-stat-pill is-green"><dt>{t('本月发布')}</dt><dd>{monthPosts}<small>{t('条')}</small></dd></div>
        </dl>
        <span className="md-grow" />
        <div className="md-cal-nav-btns">
          <IconButton icon="chevL" label={t('上个月')} onClick={() => setCursor(new Date(y, m - 1, 1))} />
          <button type="button" className="md-pill is-small" onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>{t('今天')}</button>
          <IconButton icon="chevR" label={t('下个月')} onClick={() => setCursor(new Date(y, m + 1, 1))} />
        </div>
      </header>
      <div className="md-cal-weeks">{WEEK.map(w => <span key={w}>{t(w)}</span>)}</div>
      <div className="md-cal-grid" role="grid" style={{ '--rows': rows.length / 7 }}>
        {rows.map(date => {
          const key = dayKey(date)
          const posts = byDay.get(key) ?? []
          const ideas = days.get(key)
          const isToday = key === today
          return (
            <div key={key} role="gridcell" className={`md-cal-cell ${date.getMonth() !== m ? 'is-outside' : ''} ${isToday ? 'is-today' : ''} ${over === key ? 'is-over' : ''}`} onDragOver={event => { event.preventDefault(); setOver(key) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOver(o => (o === key ? null : o)) }} onDrop={event => drop(date, event)}>
              <div className="md-cal-cell-top">
                <span className="md-cal-date">{date.getDate()}</span>
                {ideas?.length || isToday ? <div className="md-cal-stamp"><Stamp list={ideas} today={isToday} label={t('{date}的灵感', { date: fmtDate(date) })} onOpen={() => openItem(ideas[0].id)} /></div> : null}
              </div>
              <div className="md-cal-posts">
                {posts.slice(0, 3).map(bar => <Chip key={`${bar.note}:${bar.platform}:${bar.kind}`} bar={bar} late={isLate(bar, pieces, stamp)} />)}
                {posts.length > 3 ? <button type="button" className="md-cal-more" onClick={() => setDayOpen(key)}>{t('还有 {n} 条', { n: posts.length - 3 })}</button> : null}
              </div>
            </div>
          )
        })}
      </div>
      {dayOpen ? (
        <Dialog title={t('{date}的排期', { date: dayOpen })} onClose={() => setDayOpen(null)}>
          <div className="md-day-list">
            {(byDay.get(dayOpen) || []).map(bar => {
              const time = bar.at.length > 10 ? bar.at.slice(11) : bar.day
              return (
                <button type="button" key={`${bar.note}:${bar.platform}:${bar.kind}`} className={isLate(bar, pieces, stamp) ? 'is-late' : ''} onClick={() => { setDayOpen(null); openPiece(bar.note, bar.platform) }}>
                  <time>{time}</time>
                  <span className="md-day-plat"><PlatformLogo platform={bar.platform} size={15} /> {t(bar.platform)}</span>
                  <b>{bar.title}</b>
                </button>
              )
            })}
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}

function Rail({ pieces }) {
  const waiting = waitingOf(pieces)
  const upcoming = barsOf(pieces).filter(bar => bar.kind === 'scheduled' && bar.at >= `${dayKey(new Date())} 00:00`).sort((a, b) => (a.at < b.at ? -1 : 1))
  const next = upcoming[0]
  return (
    <aside className="md-rail-col">
      {next ? (
        <button type="button" className="md-next md-bento-next" onClick={() => openPiece(next.note, next.platform)}>
          <span className="md-next-top">
            <span className="md-next-kicker"><Icon name="clock" size={12} /> {t('下一条')}</span>
            <span>{next.at.slice(0, 10)}</span>
          </span>
          <b>{next.at.slice(11)}</b>
          <p>{next.title}</p>
          <span className="md-next-foot">
            <PlatformLogo platform={next.platform} size={16} />
            <span>{t(next.platform)}</span>
          </span>
        </button>
      ) : null}
      <section className="md-bento-card md-tile md-tray" aria-label={t('待排期')}>
        <header className="md-tile-head">
          <h2>{t('待排期')}</h2>
          <span className="md-tile-meta">{waiting.length ? `${waiting.length}` : t('拖到日历上')}</span>
        </header>
        <div className="md-tray-scroll">
          {!waiting.length ? (
            <div className="md-tray-empty-box">
              <Icon name="calendar" size={22} />
              <p>{t('定稿后还有没排期的平台，会出现在这里。')}</p>
            </div>
          ) : (
            <div className="md-tray-list">
              {waiting.map(row => (
                <button type="button" key={`${row.note}:${row.platform}`} draggable className="md-tray-item md-bento-tray-item" onDragStart={event => startDrag(event, row.note, row.platform)} onClick={() => openPiece(row.note, row.platform)}>
                  <PlatformLogo platform={row.platform} size={18} />
                  <span className="md-tray-item-body">
                    <small>{t(row.platform)}</small>
                    <strong>{row.title}</strong>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </aside>
  )
}

export function ScheduleView() {
  useLang()
  const pieces = useDesk(s => s.board?.pieces || [])
  return (
    <div className="md-board-page">
      <div className="md-schedule">
        <Calendar pieces={pieces} />
        <Rail pieces={pieces} />
      </div>
    </div>
  )
}
