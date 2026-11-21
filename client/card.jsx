// 灵感卡片：散落画布与信息流共用的现代 Bento 视觉卡片。
import React from 'react'
import { setDesk } from './desk.js'
import { lang, t } from './i18n.js'
import { PlatformLogo } from './platforms.jsx'
import { Icon } from './ui.jsx'
import { KIND_LABEL, STATUS_LABEL, displayItem, hash, relativeDay } from './util.js'

const tr = (zh, en) => (lang() === 'en' ? en : zh)

export function Media({ item, autoPlay = false, controls = false, onFirstFrame }) {
  const ref = React.useRef(null)
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => {
    const video = ref.current
    if (!video || item.kind !== 'video') return
    if (autoPlay) video.play().catch(() => {})
    else {
      video.pause()
      video.currentTime = 0
    }
  }, [autoPlay, item.kind])
  if (!item.media || broken) return <div className="md-media-fallback"><span>{item.title.slice(0, 1)}</span></div>
  const ratio = item.media.w && item.media.h ? { aspectRatio: `${item.media.w} / ${item.media.h}` } : undefined
  if (item.kind === 'video') {
    return <video ref={ref} className="md-media" style={ratio} src={item.media.src} poster={item.media.poster} muted={!controls} loop playsInline controls={controls} preload="metadata" onError={() => setBroken(true)} />
  }
  return <img className="md-media" style={ratio} src={item.media.src} alt="" loading="lazy" draggable={false} referrerPolicy="no-referrer" onError={() => setBroken(true)} onLoad={onFirstFrame} />
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export function detectSourcePlatform(source = '') {
  const s = String(source || '')
  if (/抖音|douyin/i.test(s)) return '抖音'
  if (/小红书|xhs|xiaohongshu/i.test(s)) return '小红书'
  if (/公众号|微信|wechat/i.test(s)) return '公众号'
  if (/B站|bilibili/i.test(s)) return 'B站'
  if (/视频号/i.test(s)) return '视频号'
  if (/知乎|zhihu/i.test(s)) return '知乎'
  if (/YouTube/i.test(s)) return 'YouTube'
  if (/^@|twitter|\bX\b/i.test(s)) return 'X'
  return null
}

function cardToneAndIcon(raw, item) {
  if (raw.external === 'fav') return { tone: 'fav', icon: 'bookmark' }
  if (raw.external === 'pending') return { tone: 'pending', icon: 'spark' }
  if (raw.external === 'atom') return { tone: 'atom', icon: 'star' }
  if (item.kind === 'quote') return { tone: 'quote', icon: 'spark' }
  if (item.kind === 'web') return { tone: 'web', icon: 'globe' }
  if (item.kind === 'video') return { tone: 'video', icon: 'film' }
  if (item.kind === 'image') return { tone: 'image', icon: 'image' }
  return { tone: 'note', icon: 'pen' }
}

function levelBadge(rawValue) {
  const v = String(rawValue || '').trim()
  if (v.startsWith('高')) return { code: 'high', text: tr('高', 'High') }
  if (v.startsWith('中')) return { code: 'mid', text: tr('中', 'Med') }
  if (v.startsWith('低')) return { code: 'low', text: tr('低', 'Low') }
  return null
}

export function Card({ item: raw, onOpen }) {
  const item = displayItem(raw)
  const inverted = item.pinned
  const running = item.production?.status === 'running'
  const [hover, setHover] = React.useState(false)
  const hasMedia = Boolean(item.media) && ['image', 'video', 'web'].includes(item.kind)
  const lines = hash(item.id) % 2 === 0
  const { tone, icon } = cardToneAndIcon(raw, item)
  const badgeText = item.badge
    ? (lang() === 'en' && item.badgeKey ? t(item.badgeKey) : t(item.badge))
    : t(KIND_LABEL[item.kind])
  const srcText = item.badge
    ? (item.source || '')
    : item.kind === 'web' && item.url
      ? hostOf(item.url)
      : item.source || ''
  const detectedPlat = detectSourcePlatform(srcText)
  const valLevel = levelBadge(raw.meta?.商业价值)
  const trafLevel = levelBadge(raw.meta?.流量)
  const mechanism = raw.meta?.机制 ? String(raw.meta.机制).trim() : ''

  return (
    <article
      className={`md-card md-bento-idea-card kind-${item.kind} tone-${tone} ${inverted ? 'is-inverted' : ''} ${item.status === 'published' ? 'is-published' : ''}`}
      data-card={item.id}
      tabIndex={0}
      role="button"
      aria-label={t('{kind}：{title}', { kind: t(KIND_LABEL[item.kind]), title: item.title })}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={event => onOpen?.(raw, event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen?.(raw, event)
        }
      }}
    >
      <header className="md-card-top">
        <span className={`md-card-pill is-${tone}`}>
          <Icon name={icon} size={11} />
          <span>{badgeText}</span>
        </span>
        <span className="md-card-top-right">
          {valLevel?.code === 'high' ? (
            <em className="md-card-lvl is-high">{tr('商业·高', 'High Val')}</em>
          ) : trafLevel?.code === 'high' ? (
            <em className="md-card-lvl is-traffic">{tr('高潜流量', 'Viral')}</em>
          ) : raw.group ? (
            <em className="md-card-domain">{raw.group}</em>
          ) : null}
        </span>
      </header>

      {hasMedia ? (
        <div className="md-card-media" data-media={item.id}>
          <Media item={item} autoPlay={hover} />
          {item.kind === 'video' ? <span className="md-card-play"><Icon name="play" size={12} fill /></span> : null}
        </div>
      ) : null}

      {item.kind === 'quote' ? (
        <div className="md-card-insight">
          <blockquote className="md-card-quote">{item.title}</blockquote>
          {mechanism ? (
            <p className="md-card-mech">{mechanism}</p>
          ) : item.body ? (
            <p className="md-card-mech">{item.body}</p>
          ) : null}
        </div>
      ) : item.kind === 'note' ? (
        <div className="md-card-note">
          {item.rel ? <span className="md-card-rel">{item.rel}</span> : null}
          <h3>{item.title}</h3>
          {item.body ? <p className={lines ? 'is-ruled' : ''}>{item.body}</p> : null}
        </div>
      ) : (
        <div className="md-card-caption"><h3>{item.title}</h3></div>
      )}

      <footer className="md-card-foot">
        {detectedPlat ? (
          <PlatformLogo platform={detectedPlat} size={14} />
        ) : item.badge ? null : (
          <span className={`md-dot status-${item.status}`} title={t(STATUS_LABEL[item.status])} />
        )}
        <span className="md-card-source">{srcText || (!item.badge ? t(KIND_LABEL[item.kind]) : tr('知识库', 'Vault'))}</span>
        <span className="md-card-time">
          {item.badge
            ? (item.when || '')
            : running
              ? <span className="md-shimmer">{t('正在成稿')}</span>
              : item.production?.status === 'done'
                ? t('已成稿')
                : item.scheduledAt && item.status !== 'published'
                  ? relativeDay(item.scheduledAt)
                  : ''}
        </span>
      </footer>
    </article>
  )
}

export function openCapture(tab = 'text') {
  setDesk({ capture: { tab } })
}
