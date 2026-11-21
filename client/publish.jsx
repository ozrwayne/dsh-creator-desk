// 视频素材、长文草稿与发布设置。
import React from 'react'
import {
  backfillPublishLinks,
  ensurePublishXHeading,
  generatePublishCopy,
  generateWechatsyncToken,
  loadPublishStatus,
  loadWechatStyles,
  loadWechatsyncJob,
  loadWechatsyncRecords,
  loadWechatsyncStatus,
  placePublishVideo,
  preparePublishBundle,
  setDesk,
  savePublishCopy,
  startWechatsync,
  toast,
  unlockWechatsyncExtension,
} from './desk.js'
import { t } from './i18n.js'
import { PlatformLogo } from './platforms.jsx'

const WX_STYLE_KEY = 'dsh-media-desk-wechat-style'

const VIDEO_PLATFORM_META = [
  { id: 'bilibili', desk: 'B站', url: 'https://member.bilibili.com/platform/upload/video/frame', titleKey: 'title', titleMax: 80, bodyKey: 'desc', bodyMax: 2000, listKey: 'tags', listLabel: '标签（逗号分隔，最多 10 个）' },
  { id: 'xhs', desk: '小红书', url: 'https://creator.xiaohongshu.com/publish/publish?source=official&target=video', titleKey: 'title', titleMax: 20, bodyKey: 'body', bodyMax: 1000, listKey: 'topics', listLabel: '话题（逗号分隔）' },
  { id: 'douyin', desk: '抖音', url: 'https://creator.douyin.com/creator-micro/content/upload', titleKey: 'title', titleMax: 30, bodyKey: 'body', bodyMax: 1000, listKey: 'topics', listLabel: '话题（逗号分隔，最多 5 个）' },
  { id: 'channels', desk: '视频号', url: 'https://channels.weixin.qq.com/platform/post/create', titleKey: 'shortTitle', titleMin: 6, titleMax: 16, bodyKey: 'body', bodyMax: 1000, listKey: 'topics', listLabel: '话题（逗号分隔）' },
  { id: 'youtube', desk: 'YouTube', url: 'https://www.youtube.com/upload', titleKey: 'title', titleMax: 100, bodyKey: 'desc', bodyMax: 5000, listKey: 'tags', listLabel: '标签（逗号分隔）' },
  { id: 'x', desk: 'X', url: 'https://x.com/compose/post', titleKey: null, bodyKey: 'text', bodyMax: 25000, listKey: null },
  { id: 'instagram', desk: 'Instagram', url: 'https://www.instagram.com/', titleKey: null, bodyKey: 'caption', bodyMax: 2200, listKey: null },
]

const CORE_WECHATSYNC = [
  { id: 'weixin', desk: '公众号', label: '公众号' },
  { id: 'zhihu', desk: '知乎', label: '知乎' },
  { id: 'toutiao', desk: '今日头条', label: '今日头条' },
  { id: 'xiaohongshu', desk: '小红书', label: '小红书' },
  { id: 'bilibili', desk: 'B站', label: 'B站专栏' },
  { id: 'x', desk: 'X', label: 'X' },
]

const SCHEDULE_PLAIN_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/

function pad2(n) {
  return String(n).padStart(2, '0')
}

function codeLen(s) {
  return [...String(s || '')].length
}

/**
 * 将输入框本地时间或带偏移的 ISO 时间换算成北京时间（UTC+8）预览。
 * @param {string} atOrIso
 * @param {{always?: boolean}} [options]
 */
export function beijingPreviewClient(atOrIso, { always = false } = {}) {
  const text = String(atOrIso || '').trim()
  if (!text) return ''
  let ms = NaN
  let localDay = ''
  const plain = SCHEDULE_PLAIN_RE.exec(text)
  if (plain) {
    const [, y, m, d, hh, mm, ss = '00'] = plain
    const dt = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
    if (Number.isNaN(dt.getTime())) return ''
    if (!always && dt.getTimezoneOffset() === -480) return ''
    ms = dt.getTime()
    localDay = `${y}-${m}-${d}`
  } else {
    ms = Date.parse(text)
    if (Number.isNaN(ms)) return ''
    const dm = /^(\d{4}-\d{2}-\d{2})/.exec(text)
    if (dm) localDay = dm[1]
  }
  const bj = new Date(ms + 8 * 3600_000)
  const bjDay = `${bj.getUTCFullYear()}-${pad2(bj.getUTCMonth() + 1)}-${pad2(bj.getUTCDate())}`
  const hm = `${pad2(bj.getUTCHours())}:${pad2(bj.getUTCMinutes())}`
  return localDay && bjDay !== localDay ? `${pad2(bj.getUTCMonth() + 1)}-${pad2(bj.getUTCDate())} ${hm}` : hm
}

function isoToLocalInput(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return String(iso)
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export async function copyTextSafe(text, okMsg) {
  const val = String(text ?? '')
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(val)
      toast(okMsg)
      return true
    }
  } catch { /* Tailscale HTTP 回退 execCommand */ }
  try {
    const area = document.createElement('textarea')
    area.value = val
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    if (ok) {
      toast(okMsg)
      return true
    }
  } catch { /* ignore */ }
  toast(t('复制失败，请手动复制'), { error: true })
  return false
}

function stampShort(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function splitListInput(raw) {
  return String(raw || '')
    .split(/[,，、\n]+/)
    .map(s => s.trim().replace(/^#/, ''))
    .filter(Boolean)
}

export function VideoBundleSection({ piece, onRegisterLink, onSaveFirst, onPieceUpdated }) {
  const [status, setStatus] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const [activePlat, setActivePlat] = React.useState('bilibili')
  const destinationId = React.useId()
  const [videoSource, setVideoSource] = React.useState('')
  const [editMap, setEditMap] = React.useState({})
  const [scheduleInput, setScheduleInput] = React.useState('')
  const [editorOpen, setEditorOpen] = React.useState(false)
  const recordInputRef = React.useRef(null)

  const applyBundleState = React.useCallback((data) => {
    setStatus(data)
    if (data?.bundle?.platforms) {
      const next = {}
      for (const meta of VIDEO_PLATFORM_META) {
        const src = data.bundle.platforms[meta.id] || {}
        next[meta.id] = {
          enabled: !src.skip,
          title: src.title || '',
          shortTitle: src.shortTitle || '',
          desc: src.desc || '',
          body: src.body || '',
          text: src.text || '',
          caption: src.caption || '',
          listText: (src.tags || src.topics || []).join(', '),
        }
      }
      setEditMap(next)
      setScheduleInput(isoToLocalInput(data.bundle.schedule || ''))
    }
  }, [])

  React.useEffect(() => {
    let stop = false
    loadPublishStatus(piece.note).then(data => {
      if (!stop) applyBundleState(data)
    }).catch(() => { if (!stop) toast(t('暂时无法读取素材，请重新打开视频稿。'), { error: true }) })
    return () => { stop = true }
  }, [piece.note, piece.mtimeMs, applyBundleState])

  const handlePrepare = async () => {
    setBusy('prepare')
    try {
      await onSaveFirst?.()
      const data = await preparePublishBundle({ note: piece.note })
      applyBundleState(data)
      if (data.piece) onPieceUpdated?.(data.piece)
      toast(t('视频素材已准备'))
    } catch {
      toast(t('未能准备素材，请检查稿件和素材目录。'), { error: true })
    } finally {
      setBusy('')
    }
  }

  const handleGenerateCopy = async () => {
    setBusy('ai')
    try {
      await onSaveFirst?.()
      const data = await generatePublishCopy({ note: piece.note })
      applyBundleState(data)
      setEditorOpen(true)
      toast(t('已生成 7 平台适配文案'))
    } catch {
      toast(t('未能生成文案，请检查 DSH 模型或手动填写。'), { error: true })
    } finally {
      setBusy('')
    }
  }

  const handlePlaceVideo = async () => {
    const trimmed = videoSource.trim()
    if (!trimmed) {
      toast(t('请先输入本地成片路径'), { error: true })
      return
    }
    setBusy('video')
    try {
      const data = await placePublishVideo({ note: piece.note, sourcePath: trimmed })
      applyBundleState(data)
      setVideoSource('')
      toast(t('已添加成片'))
    } catch {
      toast(t('无法添加视频，请检查文件位置。也可以直接在平台上传。'), { error: true })
    } finally {
      setBusy('')
    }
  }

  const handleSaveCopy = async () => {
    setBusy('save')
    try {
      const platformsPayload = {}
      for (const meta of VIDEO_PLATFORM_META) {
        const cur = editMap[meta.id]
        if (!cur) continue
        const patch = {
          skip: cur.enabled ? null : t('在工作台手动跳过'),
        }
        if (meta.titleKey) patch[meta.titleKey] = cur[meta.titleKey] ?? ''
        if (meta.bodyKey) patch[meta.bodyKey] = cur[meta.bodyKey] ?? ''
        if (meta.listKey === 'tags') patch.tags = splitListInput(cur.listText)
        if (meta.listKey === 'topics') patch.topics = splitListInput(cur.listText)
        platformsPayload[meta.id] = patch
      }
      const data = await savePublishCopy({
        note: piece.note,
        platforms: platformsPayload,
        schedule: scheduleInput.trim(),
      })
      applyBundleState(data)
      toast(t('平台文案已保存'))
    } catch {
      toast(t('未能保存文案，请检查排期后重试。'), { error: true })
    } finally {
      setBusy('')
    }
  }

  const handleBackfill = async (uploadedRecord = null) => {
    setBusy('backfill')
    try {
      const data = await backfillPublishLinks(piece.note, uploadedRecord)
      if (data.piece) onPieceUpdated?.(data.piece)
      const fresh = await loadPublishStatus(piece.note)
      applyBundleState(fresh)
      toast(t('已登记 {a} 个平台，另有 {p} 个定时或审核中', { a: data.applied?.length || 0, p: data.pending?.length || 0 }))
    } catch {
      toast(t('未能导入，请检查是否已有这篇视频的发布记录。'), { error: true })
    } finally {
      setBusy('')
    }
  }

  const handleUploadRecordFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      await handleBackfill(parsed)
    } catch {
      toast(t('无法读取这份记录，请选择从发布工具导出的记录文件。'), { error: true })
    }
  }

  const prepared = Boolean(status?.prepared)
  const errs = status?.validation?.errors || []
  const warns = status?.validation?.warnings || []
  const activeMeta = VIDEO_PLATFORM_META.find(m => m.id === activePlat) || VIDEO_PLATFORM_META[0]
  const activeEdit = editMap[activeMeta.id] || { enabled: true, title: '', shortTitle: '', desc: '', body: '', text: '', caption: '', listText: '' }
  const patchActive = patch => setEditMap(m => ({ ...m, [activeMeta.id]: { ...activeEdit, ...patch } }))
  const bjSched = beijingPreviewClient(scheduleInput, { always: true })

  let badgeClass = 'is-muted'
  let badgeText = t('尚未准备')
  if (prepared) {
    if (!status.videoReady) { badgeClass = 'is-warn'; badgeText = t('等待添加成片') }
    else if (errs.length) { badgeClass = 'is-err'; badgeText = t('{n} 项待修正', { n: errs.length }) }
    else { badgeClass = 'is-ok'; badgeText = t('素材已就绪') }
  }

  const describeIssue = item => {
    if (item === status?.faststart?.reason) return t('请先在平台预览视频，确认能正常播放。')
    if (/^(缺少 video|找不到视频)/.test(item)) return t('请添加成片，或在平台直接选择本机视频。')
    if (/^找不到封面|没有在 covers 里定义/.test(item)) return t('请补上缺少的封面。')
    if (/单独指定的视频/.test(item)) return t('请重新选择这个平台的视频文件。')
    if (/^(不认识的 version|publish\.json)/.test(item)) return t('请重新准备素材。')
    const fields = { shortTitle: t('短标题'), title: t('标题'), body: t('正文'), desc: t('简介'), text: t('正文'), caption: t('配文') }
    return item.replace(/：(shortTitle|title|body|desc|text|caption) /, (_, key) => '：' + fields[key] + ' ')
  }

  return (
    <section className="md-pub-box">
      <div className="md-pub-head">
        <div className="md-pub-title">
          <h3>{t('视频发布')}</h3>
          <span className={`md-pub-pill ${badgeClass}`}>{badgeText}</span>
        </div>
      </div>
      <div className="md-pub-body">
        <div className="md-field md-video-destinations">
          <label htmlFor={destinationId}>{t('发布到')}</label>
          <div className="md-pub-inline-row">
            <select id={destinationId} value={activePlat} onChange={event => setActivePlat(event.target.value)}>
              {VIDEO_PLATFORM_META.map(meta => <option key={meta.id} value={meta.id}>{t(meta.desk)}</option>)}
            </select>
            <a className="md-btn is-primary" href={activeMeta.url} target="_blank" rel="noopener noreferrer">{t('打开平台发布页')} ↗</a>
            <button type="button" className="md-btn" onClick={() => onRegisterLink(activeMeta.desk)}>{t('登记公开链接')}</button>
          </div>
        </div>
        <p className="md-pub-hint">{activePlat === 'instagram' ? t('在 Instagram 点「创建」，选择本机视频。') : t('在平台网页选择本机视频，填写标题并预览。')} {t('在平台点发布后，回到本页登记作品的公开链接。')}</p>
        {status?.videoReady ? (
          <video className="md-video-preview" controls playsInline preload="metadata" aria-label={t('视频成片')}
            src={`media-desk/publish/video?note=${encodeURIComponent(piece.note)}&inline=1`} />
        ) : null}
      </div>
      <details className="md-pub-details">
        <summary>{t('多平台素材与文案')}</summary>
        <div className="md-pub-btns">
          <button type="button" className="md-btn is-small is-primary" disabled={Boolean(busy)} onClick={handlePrepare}>
            {busy === 'prepare' ? t('准备中…') : t(prepared ? '更新素材' : '准备素材')}
          </button>
          <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={handleGenerateCopy}>
            {busy === 'ai' ? t('生成中…') : t('AI 生成 7 平台文案')}
          </button>
          {prepared ? (
            <>
              <a className="md-btn is-small md-pub-dl" href={`media-desk/publish/bundle.zip?note=${encodeURIComponent(piece.note)}`} download>
                {t('下载封面和文案')}
              </a>
              {status.videoReady ? (
                <a className="md-btn is-small md-pub-dl" href={`media-desk/publish/video?note=${encodeURIComponent(piece.note)}`} download>
                  {t('下载成片')}
                </a>
              ) : null}
              <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={() => handleBackfill()}>
                {busy === 'backfill' ? t('导入中…') : t('读取本机发布记录')}
              </button>
              <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={() => recordInputRef.current?.click()}>
                {t('导入发布记录')}
              </button>
              <input ref={recordInputRef} type="file" hidden accept=".json,application/json" onChange={handleUploadRecordFile} />
            </>
          ) : null}
        </div>

      {prepared ? (
        <div className="md-pub-body">
          <div className="md-pub-meta-grid">
            <div>
              <small>{t('视频成片')}</small>
              <span>
                {status.videoReady
                  ? t('已添加成片')
                  : t('待添加成片')}
                {status.bundle?.durationSec ? ` · ${Math.round(status.bundle.durationSec)}s` : ''}
              </span>
            </div>
          </div>

          <div className="md-pub-inline-row">
            <input
              value={videoSource}
              onChange={e => setVideoSource(e.target.value)}
              placeholder={t('运行工作台的电脑上的视频文件路径')}
              aria-label={t('本地成片路径')}
            />
            <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={handlePlaceVideo}>
              {busy === 'video' ? t('添加中…') : t('添加成片')}
            </button>
          </div>

          {errs.length || warns.length ? (
            <ul className="md-pub-checks">
              {errs.map((item, idx) => <li key={`e-${idx}`} className="is-err">✕ {describeIssue(item)}</li>)}
              {warns.map((item, idx) => <li key={`w-${idx}`} className="is-warn">! {describeIssue(item)}</li>)}
            </ul>
          ) : null}

          <details className="md-pub-details" open={editorOpen} onToggle={e => setEditorOpen(e.currentTarget.open)}>
            <summary>{t('各平台文案与排期')}</summary>
            <div className="md-pub-editor">
              <div className="md-pub-inline-row">
                <label className="md-field" style={{ flex: 1 }}>
                  <span>
                    {t('统一定时发布')}
                    {bjSched ? ` · ${t('北京时间 {bj}', { bj: bjSched })}` : ''}
                  </span>
                  <input
                    value={scheduleInput}
                    onChange={e => setScheduleInput(e.target.value)}
                    placeholder={t('留空为立即填表不设自动定时，或填 YYYY-MM-DD HH:mm（需晚于当前 2 小时）')}
                  />
                </label>
              </div>

              <div className="md-pub-tabs" role="tablist">
                {VIDEO_PLATFORM_META.map(meta => {
                  const row = editMap[meta.id]
                  const isOn = activeMeta.id === meta.id
                  return (
                    <button
                      key={meta.id}
                      type="button"
                      role="tab"
                      aria-selected={isOn}
                      className={`md-pub-tab ${isOn ? 'is-active' : ''} ${row?.enabled === false ? 'is-muted' : ''}`}
                      onClick={() => setActivePlat(meta.id)}
                    >
                      <PlatformLogo platform={meta.desk} size={16} />
                      <span>{t(meta.desk)}</span>
                    </button>
                  )
                })}
              </div>

              <div className="md-pub-plat-form">
                <label className="md-bench-check">
                  <input
                    type="checkbox"
                    checked={Boolean(activeEdit.enabled)}
                    onChange={e => patchActive({ enabled: e.target.checked })}
                  />
                  <span>{t('在本次发布包中启用 {platform}', { platform: t(activeMeta.desk) })}</span>
                </label>

                {activeMeta.titleKey ? (
                  <label className="md-field">
                    <span>
                      {activeMeta.titleKey === 'shortTitle' ? t('短标题（6-16 字）') : t('标题')}
                      {' · '}
                      <b className={codeLen(activeEdit[activeMeta.titleKey]) > activeMeta.titleMax || (activeMeta.titleMin && codeLen(activeEdit[activeMeta.titleKey]) < activeMeta.titleMin) ? 'is-over' : ''}>
                        {codeLen(activeEdit[activeMeta.titleKey])}/{activeMeta.titleMax}
                      </b>
                    </span>
                    <input
                      value={activeEdit[activeMeta.titleKey] || ''}
                      onChange={e => patchActive({ [activeMeta.titleKey]: e.target.value })}
                    />
                  </label>
                ) : null}

                {activeMeta.bodyKey ? (
                  <label className="md-field">
                    <span>
                      {t('正文 / 简介')}
                      {' · '}
                      <b className={codeLen(activeEdit[activeMeta.bodyKey]) > activeMeta.bodyMax ? 'is-over' : ''}>
                        {codeLen(activeEdit[activeMeta.bodyKey])}/{activeMeta.bodyMax}
                      </b>
                    </span>
                    <textarea
                      rows={4}
                      value={activeEdit[activeMeta.bodyKey] || ''}
                      onChange={e => patchActive({ [activeMeta.bodyKey]: e.target.value })}
                    />
                  </label>
                ) : null}

                {activeMeta.listKey ? (
                  <label className="md-field">
                    <span>{t(activeMeta.listLabel)}</span>
                    <input
                      value={activeEdit.listText || ''}
                      onChange={e => patchActive({ listText: e.target.value })}
                    />
                  </label>
                ) : null}

                <div className="md-piece-actions">
                  <button type="button" className="md-btn is-small is-primary" disabled={Boolean(busy)} onClick={handleSaveCopy}>
                    {busy === 'save' ? t('保存中…') : t('保存平台文案')}
                  </button>
                </div>
              </div>
            </div>
          </details>
        </div>
      ) : <p className="md-pub-hint">{t('准备素材可分别修改平台文案，下载封面和文案。成片单独上传。')}</p>}
      </details>
    </section>
  )
}

export function LongArticleSyncSection({ piece, platforms, dirty, onSaveFirst, onPieceUpdated, onRegisterLink }) {
  const [wsStatus, setWsStatus] = React.useState(null)
  const [records, setRecords] = React.useState({})
  const [styles, setStyles] = React.useState([])
  const [styleId, setStyleId] = React.useState(() => {
    try { return localStorage.getItem(WX_STYLE_KEY) || 'minimal' } catch { return 'minimal' }
  })
  const [selectedIds, setSelectedIds] = React.useState([])
  const [pickedClientId, setPickedClientId] = React.useState('')
  const [pubStatus, setPubStatus] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const [job, setJob] = React.useState(null)
  const [dupPrompt, setDupPrompt] = React.useState(null)

  const refreshAll = React.useCallback(async (withExtRefresh = false, clientOverride = pickedClientId) => {
    const [ws, rec, pub] = await Promise.all([
      loadWechatsyncStatus(withExtRefresh, clientOverride).catch(() => null),
      loadWechatsyncRecords(piece.note).catch(() => ({ records: {} })),
      loadPublishStatus(piece.note).catch(() => null),
    ])
    if (ws) setWsStatus(ws)
    setRecords(rec?.records || {})
    if (pub) setPubStatus(pub)
  }, [piece.note, pickedClientId])

  React.useEffect(() => {
    let stop = false
    refreshAll(false)
    loadWechatStyles().then(data => {
      if (stop) return
      const list = data?.styles || []
      setStyles(list)
      if (list.length && !list.some(item => item.id === styleId)) setStyleId('minimal')
    }).catch(() => {})
    return () => { stop = true }
  }, [refreshAll])

  // 根据当前稿件勾选的平台初始化默认同步目标
  React.useEffect(() => {
    const defaults = CORE_WECHATSYNC
      .filter(item => platforms.includes(item.desk) && item.id !== 'x')
      .map(item => item.id)
    setSelectedIds(defaults.length ? defaults : ['weixin'])
  }, [piece.note])

  // 轮询后台同步任务
  React.useEffect(() => {
    if (!job || job.status !== 'running') return undefined
    let stop = false
    const timer = setTimeout(async () => {
      try {
        const next = await loadWechatsyncJob(job.id)
        if (stop) return
        setJob(next)
        if (next.status !== 'running') {
          const rec = await loadWechatsyncRecords(piece.note)
          if (!stop) setRecords(rec?.records || {})
          if (next.status === 'done') {
            const okCount = (next.results || []).filter(r => r.status === 'draft').length
            toast(t('已存入 {ok}/{total} 个平台草稿箱', { ok: okCount, total: (next.results || []).length }), { error: okCount !== (next.results || []).length })
          } else if (next.error) {
            toast(t('部分草稿未能送达，请检查平台登录后重试。'), { error: true })
          }
        }
      } catch { /* ignore transient poll errors */ }
    }, 1500)
    return () => { stop = true; clearTimeout(timer) }
  }, [job, piece.note])

  const extraExtPlatforms = (wsStatus?.platforms || []).filter(
    ext => ext.isAuthenticated && !CORE_WECHATSYNC.some(c => c.id === ext.id),
  )

  const toggleSyncTarget = (id) => {
    setSelectedIds(list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
  }

  const doSync = async (force = false) => {
    if (!selectedIds.length) {
      toast(t('请至少勾选一个要同步草稿的平台'), { error: true })
      return
    }
    setBusy('sync')
    setDupPrompt(null)
    try {
      await onSaveFirst?.()
      const res = await startWechatsync({
        note: piece.note,
        platforms: selectedIds,
        styleId: styleId || 'minimal',
        clientId: pickedClientId || undefined,
        force,
      })
      if (res.duplicateWarning) {
        setDupPrompt(res.recentPlatforms || [])
        return
      }
      if (res.job) setJob(res.job)
    } catch {
      toast(t('草稿未能送达，请检查浏览器连接和平台登录后重试。'), { error: true })
    } finally {
      setBusy('')
    }
  }

  const handleEnsureXHeading = async () => {
    setBusy('xhead')
    try {
      await onSaveFirst?.()
      const data = await ensurePublishXHeading(piece.note)
      if (data.piece) onPieceUpdated?.(data.piece)
      await refreshAll(false)
      toast(t(data.updated ? '已补上文章标题' : '已有文章标题'))
    } catch {
      toast(t('标题未能保存，请重新打开稿件后重试。'), { error: true })
    } finally {
      setBusy('')
    }
  }

  const recordEntries = Object.values(records || {}).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  const connected = Boolean(wsStatus?.connected)
  const clientList = wsStatus?.clients || []
  const extAuthMap = new Map((wsStatus?.platforms || []).map(p => [p.id, p]))

  return (
    <section className="md-pub-box">
      <div className="md-pub-head">
        <div className="md-pub-title">
          <h3>{t('长文发布')}</h3>
          <span className={`md-pub-pill ${connected ? 'is-ok' : 'is-muted'}`}>
            {connected
              ? (clientList.length > 1 ? t('已连接 {n} 台电脑', { n: clientList.length }) : t('浏览器已连接'))
              : t('浏览器未连接')}
          </span>
        </div>
        <div className="md-pub-btns">
          <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={() => { setBusy('check'); refreshAll(true).finally(() => setBusy('')) }}>
            {busy === 'check' ? t('检测中…') : t('检测登录状态')}
          </button>
        </div>
      </div>

      <div className="md-pub-body">
        {!connected ? <p className="md-pub-hint">{t('可先复制正文到平台编辑器。要直接存草稿，请先连接浏览器。')} <button type="button" className="md-btn is-small" onClick={() => setDesk({ settingsOpen: true })}>{t('发布设置')}</button></p> : null}

        {clientList.length > 1 ? (
          <div className="md-pub-inline-row">
            <label className="md-field" style={{ minWidth: 240 }}>
              <span>{t('发送草稿的电脑')}</span>
              <select
                value={pickedClientId}
                onChange={e => {
                  const val = e.target.value
                  setPickedClientId(val)
                  refreshAll(false, val)
                }}
              >
                <option value="">{t('自动匹配（优先当前操作的电脑）')}</option>
                {clientList.map(c => (
                  <option key={c.clientId} value={c.clientId}>
                    {c.label}{c.isCallerMatch ? ` · ${t('当前电脑')}` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        <div className="md-pub-inline-row">
          <label className="md-field" style={{ minWidth: 180 }}>
            <span>{t('排版风格')}</span>
            <select
              value={styleId}
              onChange={e => {
                setStyleId(e.target.value)
                try { localStorage.setItem(WX_STYLE_KEY, e.target.value) } catch { /* ignore */ }
              }}
            >
              {(styles.length ? styles : [{ id: 'minimal', name: '极简黑白' }]).map(item => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <div className="md-field" style={{ flex: 1 }}>
            <span>{t('草稿目标平台')}</span>
            <div className="md-pub-targets">
              {[...CORE_WECHATSYNC, ...extraExtPlatforms.map(p => ({ id: p.id, desk: p.deskPlatform, label: p.name }))].map(item => {
                const on = selectedIds.includes(item.id)
                const auth = extAuthMap.get(item.id)
                const sub = auth ? (auth.isAuthenticated ? '✓' : '×') : ''
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={on}
                    className={`md-pill is-small ${on ? 'is-primary' : ''}`}
                    onClick={() => toggleSyncTarget(item.id)}
                    title={auth ? (auth.isAuthenticated ? `${item.label}：${auth.username || t('已登录')}` : `${item.label}：${t('未登录')}`) : item.label}
                  >
                    {item.desk ? <PlatformLogo platform={item.desk} size={14} /> : null}
                    <span>{t(item.label)}{sub ? ` ${sub}` : ''}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="md-piece-actions">
          <button
            type="button"
            className="md-btn is-small is-primary"
            disabled={!connected || !selectedIds.length || Boolean(busy) || job?.status === 'running'}
            onClick={() => doSync(false)}
          >
            {job?.status === 'running' ? t('正在存入草稿箱…') : t('存入平台草稿箱')}
          </button>
          <small className="md-pub-subnote">{t('请到平台草稿箱预览图片和排版，再确认发布。')}</small>
        </div>

        {dupPrompt ? (
          <div className="md-pub-dup">
            <span>{t('「{names}」在 5 分钟内刚同步过草稿，确认再次推送并新建草稿？', { names: dupPrompt.join('、') })}</span>
            <button type="button" className="md-btn is-small is-primary" onClick={() => doSync(true)}>{t('确认再次同步')}</button>
            <button type="button" className="md-btn is-small" onClick={() => setDupPrompt(null)}>{t('取消')}</button>
          </div>
        ) : null}

        {job?.warnings?.length ? (
          <p className="md-pub-warn">{t('有图片未能带入草稿，请到平台检查并补上。')}</p>
        ) : null}

        {recordEntries.length ? (
          <div className="md-pub-records">
            <small>{t('草稿记录')}</small>
            <ul>
              {recordEntries.map(rec => (
                <li key={rec.platformId}>
                  <span className="md-pub-rec-name">
                    {rec.deskPlatform ? <PlatformLogo platform={rec.deskPlatform} size={15} /> : null}
                    <b>{rec.platformName}</b>
                    <i className={rec.status === 'draft' ? 'is-ok' : 'is-err'}>
                      {rec.status === 'draft' ? t('草稿') : t('失败')}
                    </i>
                  </span>
                  <span className="md-pub-rec-meta">
                    {rec.at ? stampShort(rec.at) : ''}
                    {rec.error ? ' · ' + t('请检查平台登录后重试') : ''}
                  </span>
                  <span className="md-pub-rec-acts">
                    {rec.postUrl ? <a href={rec.postUrl} target="_blank" rel="noreferrer">{t('打开草稿')}</a> : null}
                    {rec.status === 'draft' && rec.deskPlatform && onRegisterLink ? (
                      <button type="button" className="md-btn is-small" onClick={() => onRegisterLink(rec.deskPlatform)}>
                        {t('登记公开链接')}
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {platforms.includes('X') ? (
          <div className="md-pub-xarticle">
            <div className="md-pub-title">
              <strong>{t('X 长文')}</strong>
              <span className={`md-pub-pill ${pubStatus?.xArticle?.hasH1 ? 'is-ok' : 'is-warn'}`}>
                {pubStatus?.xArticle?.hasH1 ? t('标题已就绪') : t('待补文章标题')}
              </span>
            </div>
            <div className="md-pub-btns">
              {!pubStatus?.xArticle?.hasH1 ? (
                <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={handleEnsureXHeading}>
                  {t('补上文章标题')}
                </button>
              ) : null}
              <button type="button" className="md-btn is-small" onClick={() => window.open('https://x.com/compose/articles', '_blank', 'noopener')}>
                {t('打开 X 长文编辑页')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

export function PublishSettingsFields({ form, set, settings }) {
  const [genToken, setGenToken] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const hostForWs = form.publishWechatsyncAllowTailscale && typeof window !== 'undefined' && /^100\./.test(window.location.hostname)
    ? window.location.hostname
    : '127.0.0.1'
  const wsUrl = `ws://${hostForWs}:${form.publishWechatsyncPort || 9537}`
  const lockedExtId = settings?.publish?.wechatsyncLockedExtId || ''

  const onGenerateToken = async () => {
    setBusy(true)
    try {
      const data = await generateWechatsyncToken()
      setGenToken(data)
      await copyTextSafe(data.token, t('配对口令已复制'))
    } catch {
      toast(t('未能生成口令，请检查草稿发送设置。'), { error: true })
    } finally {
      setBusy(false)
    }
  }

  const onUnlockExt = async () => {
    setBusy(true)
    try {
      await unlockWechatsyncExtension()
      toast(t('已取消浏览器配对'))
    } catch {
      toast(t('未能取消配对，请稍后重试。'), { error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="md-pub-settings">
      <hr className="md-settings-sep" />
      <h4 className="md-settings-subhead">{t('发布设置')}</h4>
      <div className="md-pub-inline-row" style={{ marginBottom: 8 }}>
        <small style={{ flex: 1, color: 'var(--ink3)' }}>{t('视频填表扩展可将素材填入平台网页。下载后解压，在 Chrome 的扩展管理页加载解压后的目录。')}</small>
        <a className="md-btn is-small md-pub-dl" href="media-desk/publish/maitian-extension.zip" download>
          {t('下载视频填表扩展')}
        </a>
      </div>
      <label className="md-field">
        <span>{t('视频素材目录')}</span>
        <input
          value={form.publishBundleDir}
          onChange={e => set('publishBundleDir', e.target.value)}
          placeholder={`${settings?.defaultExportDir || '~/Documents/自媒体工作台'}/发布包`}
        />
      </label>
      <div className="md-field-row">
        <label className="md-field">
          <span>{t('视频必带标签（逗号分隔）')}</span>
          <input
            value={form.publishRequiredTags}
            onChange={e => set('publishRequiredTags', e.target.value)}
            placeholder={t('例如：纸飞机, 效率工具')}
          />
        </label>
        <label className="md-field">
          <span>{t('自定义违禁词（逗号分隔）')}</span>
          <input
            value={form.publishBannedWords}
            onChange={e => set('publishBannedWords', e.target.value)}
            placeholder={t('准备素材时提醒修改这些词')}
          />
        </label>
      </div>

      <div className="md-field">
        <label className="md-bench-check">
          <input
            type="checkbox"
            checked={Boolean(form.publishWechatsyncEnabled)}
            onChange={e => set('publishWechatsyncEnabled', e.target.checked)}
          />
          <span>{t('允许发送长文草稿')}</span>
        </label>
        {form.publishWechatsyncEnabled ? (
          <label className="md-bench-check" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={Boolean(form.publishWechatsyncAllowTailscale)}
              onChange={e => set('publishWechatsyncAllowTailscale', e.target.checked)}
            />
            <span>{t('允许同一 Tailscale 私网内的电脑连接')}</span>
          </label>
        ) : null}
      </div>

      {form.publishWechatsyncEnabled ? (
        <>
          <div className="md-field-row">
            <label className="md-field">
              <span>{t('连接端口')}</span>
              <input
                type="number"
                min="1024"
                max="65535"
                value={form.publishWechatsyncPort}
                onChange={e => set('publishWechatsyncPort', e.target.value)}
              />
            </label>
            <div className="md-field">
              <span>
                {t('连接口令')}
                {settings?.publish?.hasToken ? t('（已配置，末四位 {hint}）', { hint: settings.publish.tokenHint }) : ''}
              </span>
              <div className="md-pub-btns" style={{ marginTop: 4 }}>
                <button type="button" className="md-btn is-small" onClick={() => copyTextSafe(wsUrl, t('已复制连接地址'))}>{t('复制地址')}</button>
                <button type="button" className="md-btn is-small" disabled={busy} onClick={onGenerateToken}>{t('生成新口令')}</button>
              </div>
            </div>
          </div>
          {genToken ? (
            <div className="md-pub-token-box">
              <small>{t('新口令已生成，请填入 Chrome 扩展（关闭窗口后仅显示末四位）：')}</small>
              <code>{genToken.token}</code>
            </div>
          ) : null}
          {lockedExtId ? (
            <div className="md-pub-inline-row">
              <small>{t('浏览器已配对')}</small>
              <button type="button" className="md-btn is-small" disabled={busy} onClick={onUnlockExt}>{t('取消配对')}</button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
