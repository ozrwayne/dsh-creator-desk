// 内容页：四形态 Bento 看板与分发矩阵（短推 / 长文 / 视频 / 播客）。
import React from 'react'
import { createPiece, openPiece, report, setDesk, useDesk } from './desk.js'
import { contentFlag } from '../src/todo.js'
import { PlatformLogo } from './platforms.jsx'
import { Empty, Icon, Segmented } from './ui.jsx'
import { lang, t, useLang } from './i18n.js'

const tr = (zh, en) => (lang() === 'en' ? en : zh)

const FORMS = ['短推', '长文', '视频', '播客']
const FORM_META = {
  短推: { dot: 'status-draft', icon: 'bolt', tone: 'blue' },
  长文: { dot: 'status-ready', icon: 'pen', tone: 'purple' },
  视频: { dot: 'status-outline', icon: 'film', tone: 'amber' },
  播客: { dot: 'status-published', icon: 'globe', tone: 'green' },
}

function impressionsOf(piece) {
  const nums = (piece.distributions || []).map(row => row.impressions).filter(item => item != null)
  return nums.length ? Math.max(...nums) : null
}

function nextSchedule(piece) {
  const rows = [...(piece.schedules || [])].sort((a, b) => (a.at < b.at ? -1 : 1))
  return rows[0]?.at || ''
}

function statusDot(status) {
  if (status === '已发布') return 'status-published'
  if (status === '定稿') return 'status-ready'
  return 'status-draft'
}

function Card({ piece }) {
  const impressions = impressionsOf(piece)
  const nextAt = nextSchedule(piece)
  return (
    <button type="button" className="md-board-card md-bento-piece-card" onClick={() => openPiece(piece.note)}>
      <div className="md-piece-card-top">
        <span className={`md-status ${statusDot(piece.status)}`}>
          <span className={`md-dot ${statusDot(piece.status)}`} />
          <span>{t(piece.status)}</span>
        </span>
        {piece.mark ? <em className={`md-content-tag ${piece.verified ? 'is-done' : 'is-open'}`}>{t(piece.mark)}</em> : null}
        {piece.date ? <time className="md-piece-card-date">{piece.date}</time> : null}
      </div>

      <strong>{piece.title}</strong>

      {piece.problems?.length ? (
        <span className="md-content-problems">
          <Icon name="flame" size={12} />
          <span>{piece.problems.map(item => t(item)).join(' · ')}</span>
        </span>
      ) : null}

      {(piece.platforms || []).length ? (
        <div className="md-piece-plat-row">
          {(piece.platforms || []).map(platform => {
            const published = piece.distributions?.some(row => row.platform === platform)
            const scheduled = piece.schedules?.some(row => row.platform === platform)
            const kind = published ? 'is-done' : scheduled ? 'is-sched' : 'is-open'
            return (
              <span key={platform} className={`md-content-plat-chip ${kind}`}>
                <PlatformLogo platform={platform} size={13} />
                <span>{t(platform)}</span>
              </span>
            )
          })}
        </div>
      ) : null}

      {(impressions != null || nextAt) ? (
        <div className="md-piece-card-foot">
          {impressions != null ? (
            <span className="md-content-num">
              <Icon name="chart" size={12} />
              <b>{impressions.toLocaleString()}</b>
            </span>
          ) : <span />}
          {nextAt ? <span className="md-piece-next-at"><Icon name="clock" size={11} /> {nextAt}</span> : null}
        </div>
      ) : null}
    </button>
  )
}

export function ContentView() {
  useLang()
  const pieces = useDesk(s => s.board?.pieces || [])
  const [mode, setMode] = React.useState('board')
  const [status, setStatus] = React.useState('all')
  const [flag, setFlag] = React.useState('all')
  const [sort, setSort] = React.useState(null)
  const [account, setAccount] = React.useState('all')
  const [q, setQ] = React.useState('')
  const accounts = [...new Set(pieces.flatMap(piece => piece.accounts || []))]
  const newVideo = () => {
    const sources = pieces.filter(piece => piece.form === '长文')
    if (!sources.length) {
      setDesk({ dialog: {
        title: tr('新建视频稿', 'New video draft'),
        fields: [{ type: 'hidden', name: 'hint', label: tr('视频稿沿用一篇长文的选题。请先在流程中创建长文。', 'A video draft follows an article. Create an article in Flow first.') }],
        submitLabel: tr('打开流程', 'Open Flow'), onSubmit: () => setDesk({ view: 'flow' }),
      } })
      return
    }
    setDesk({ dialog: {
      title: tr('新建视频稿', 'New video draft'), submitLabel: t('新建'),
      initial: { parentNote: sources[0].note },
      fields: [
        { name: 'parentNote', type: 'select', label: tr('来源长文', 'Source article'), required: true, options: sources.map(p => ({ value: p.note, label: p.title })) },
        { name: 'title', label: tr('视频标题', 'Video title'), required: true },
      ],
      onSubmit: ({ parentNote, title }) => { createPiece({ form: '视频', parentNote, title: title.trim() }, { view: 'content' }).catch(report) },
    } })
  }
  const query = q.trim().toLowerCase()
  const shown = pieces.filter(piece => {
    if (status !== 'all' && piece.status !== status) return false
    if (!contentFlag(piece, flag, new Date())) return false
    if (account !== 'all' && !(piece.accounts || []).includes(account)) return false
    if (query && !`${piece.title} ${piece.note}`.toLowerCase().includes(query)) return false
    return true
  })
  const sorted = sort ? [...shown].sort((a, b) => {
    const av = sort.key === 'impressions' ? impressionsOf(a) : (a.date || '')
    const bv = sort.key === 'impressions' ? impressionsOf(b) : (b.date || '')
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (av === bv) return 0
    return (av < bv ? -1 : 1) * sort.dir
  }) : shown
  const toggleSort = (key) => setSort(prev => (prev?.key === key ? { key, dir: prev.dir * -1 } : { key, dir: key === 'date' ? -1 : -1 }))

  const publishedCount = pieces.filter(p => p.status === '已发布').length
  const activeCount = pieces.filter(p => p.status === '进行中' || p.status === '定稿').length

  return (
    <div className="md-board-page md-content-bento-page">
      <div className="md-content-shell">
        <header className="md-bento-card md-content-headcard">
          <div className="md-content-kpi-strip">
            <div className="md-content-kpi-pills">
              <span className="md-content-stat-pill">
                <small>{tr('受管稿件', 'Managed')}</small>
                <b>{pieces.length}</b>
              </span>
              <span className="md-content-stat-pill is-green">
                <small>{t('已发布')}</small>
                <b>{publishedCount}</b>
              </span>
              <span className="md-content-stat-pill is-blue">
                <small>{tr('在产/定稿', 'In pipeline')}</small>
                <b>{activeCount}</b>
              </span>
            </div>
            <Segmented label={t('显示方式')} value={mode} onChange={setMode} options={[{ value: 'board', icon: 'grid', label: t('看板') }, { value: 'table', icon: 'list', label: t('表格') }]} />
          </div>

          <div className="md-content-tools">
            <label className="md-search">
              <Icon name="search" size={14} />
              <input value={q} onChange={event => setQ(event.target.value)} placeholder={t('搜索稿件')} aria-label={t('搜索稿件')} />
            </label>
            <Segmented label={t('状态')} value={status} onChange={setStatus} options={[{ value: 'all', label: t('全部') }, { value: '进行中', label: t('进行中') }, { value: '定稿', label: t('定稿') }, { value: '已发布', label: t('已发布') }]} />
            <Segmented label={t('稿件筛选')} value={flag} onChange={setFlag} options={[{ value: 'all', label: t('全部') }, { value: 'impressions', label: t('待填曝光') }, { value: 'incomplete', label: t('未分发完') }, { value: 'overdue', label: t('排期已过') }]} />
            <select className="md-clean-select" aria-label={t('账号')} value={account} onChange={event => setAccount(event.target.value)}>
              <option value="all">{t('全部')}</option>
              {accounts.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
        </header>

        {!shown.length ? <div className="md-bento-card"><Empty title={t('没有受管稿件')} /></div> : mode === 'board' ? (
          <div className="md-board md-bento-kanban">
            {FORMS.map(form => {
              const rows = shown.filter(piece => piece.form === form)
              const meta = FORM_META[form]
              return (
                <section key={form} className="md-board-col md-kanban-lane" aria-label={t(form)}>
                  <header className="md-kanban-head">
                    <span className={`md-kanban-icon is-${meta.tone}`}><Icon name={meta.icon} size={14} /></span>
                    <h3>{t(form)}</h3>
                    {form === '视频' ? <button type="button" className="md-btn is-small" onClick={newVideo}>{tr('新建视频稿', 'New video draft')}</button> : null}
                    <span className="md-kanban-count">{rows.length}</span>
                  </header>
                  <div className="md-board-list">
                    {form === '播客' ? <p className="md-content-empty">{t('后续开放')}</p> : rows.length ? rows.map(piece => <Card key={piece.note} piece={piece} />) : <p className="md-content-empty">{t('暂无')}</p>}
                  </div>
                </section>
              )
            })}
          </div>
        ) : (
          <div className="md-bento-card md-rows md-content-rows">
            <div className="md-row is-head">
              <span>{t('标题')}</span>
              <span>{t('形态')}</span>
              <span>{t('状态')}</span>
              <span>{t('平台')}</span>
              <span>{t('下一次排期')}</span>
              <button type="button" onClick={() => toggleSort('impressions')}>{t('曝光')}{sort?.key === 'impressions' ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</button>
              <button type="button" onClick={() => toggleSort('date')}>{t('日期')}{sort?.key === 'date' ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</button>
            </div>
            {sorted.map(piece => {
              const impressions = impressionsOf(piece)
              return (
                <button type="button" key={piece.note} className="md-row" onClick={() => openPiece(piece.note)}>
                  <span className="md-row-title"><b>{piece.title}</b></span>
                  <span>{t(piece.form)}</span>
                  <span><em className={`md-status ${statusDot(piece.status)}`}>{t(piece.status)}</em></span>
                  <span className="md-row-plats">
                    {(piece.platforms || []).map(name => (
                      <span key={name} className="md-row-plat-item" title={t(name)}>
                        <PlatformLogo platform={name} size={15} />
                      </span>
                    ))}
                  </span>
                  <span className="md-content-num">{nextSchedule(piece) || '—'}</span>
                  <span className="md-content-num"><b>{impressions == null ? '—' : impressions.toLocaleString()}</b></span>
                  <span className="md-content-num">{piece.date || '—'}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
