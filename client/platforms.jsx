// 平台品牌视觉系统：原生品牌圆角图标、品牌色、头像组件、品牌色渐变微缩趋势图与堆叠柱图。
import React from 'react'

const CJK = '"Inter", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif'
const stroke = { fill: 'none', stroke: '#fff', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
const word = (text, size, y = 12.6) => <text x="12" y={y} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontFamily={CJK} fontSize={size} fontWeight="700" letterSpacing="-.3">{text}</text>
const note = 'M13 5.5v9a2.8 2.8 0 1 1-2.6-2.8M13 5.5c.4 1.9 1.9 3.3 3.9 3.5'

const LOGOS = {
  公众号: {
    bg: '#07C160',
    chart: '#07C160',
    glyph: <>
      <ellipse cx="9.8" cy="10.4" rx="5.1" ry="4.2" fill="#fff" />
      <circle cx="8.1" cy="9.6" r=".68" fill="#07C160" />
      <circle cx="11.3" cy="9.6" r=".68" fill="#07C160" />
      <ellipse cx="14.9" cy="14" rx="4.2" ry="3.4" fill="#fff" stroke="#07C160" strokeWidth="1.15" />
      <circle cx="13.6" cy="13.4" r=".58" fill="#07C160" />
      <circle cx="16.2" cy="13.4" r=".58" fill="#07C160" />
    </>,
  },
  小红书: { bg: '#FF2442', chart: '#FF2442', glyph: word('小红书', 6.5) },
  抖音: {
    bg: '#111111',
    chart: '#262930',
    glyph: <>
      <path d={note} {...stroke} stroke="#25F4EE" transform="translate(-.8 -.6)" />
      <path d={note} {...stroke} stroke="#FE2C55" transform="translate(.8 .6)" />
      <path d={note} {...stroke} />
    </>,
  },
  TikTok: {
    bg: '#000000',
    chart: '#FE2C55',
    glyph: <>
      <path d={note} {...stroke} stroke="#25F4EE" transform="translate(-.8 -.6)" />
      <path d={note} {...stroke} stroke="#FE2C55" transform="translate(.8 .6)" />
      <path d={note} {...stroke} />
    </>,
  },
  视频号: {
    bg: '#FA9D3B',
    chart: '#F59E0B',
    glyph: <path d="M5.5 9.2c2.2-2.6 4.4.3 6.5 2.8s4.3 5.4 6.5 2.8M5.5 14.8c2.2 2.6 4.4-.3 6.5-2.8s4.3-5.4 6.5-2.8" {...stroke} strokeWidth="1.9" />,
  },
  B站: {
    bg: '#00AEEC',
    chart: '#00AEEC',
    glyph: <>
      <rect x="5.5" y="8.5" width="13" height="9" rx="2.4" {...stroke} strokeWidth="1.8" />
      <path d="M9 5.8l1.8 2.2M15 5.8L13.2 8M9.8 12.2v1.5M14.2 12.2v1.5" {...stroke} strokeWidth="1.8" />
    </>,
  },
  知乎: { bg: '#0066FF', chart: '#0066FF', glyph: word('知', 13) },
  今日头条: { bg: '#F04142', chart: '#F04142', glyph: word('头条', 8.4) },
  YouTube: { bg: '#FF0000', chart: '#EF4444', glyph: <path d="M9.8 8.2v7.6l6.5-3.8z" fill="#fff" /> },
  LinkedIn: {
    bg: '#0A66C2',
    chart: '#0A66C2',
    glyph: <text x="12" y="16.4" textAnchor="middle" fill="#fff" fontFamily="Helvetica, Arial, sans-serif" fontSize="12.5" fontWeight="700" letterSpacing="-.4">in</text>,
  },
  GitHub: {
    bg: '#181717',
    chart: '#475569',
    glyph: <path transform="translate(4 4)" fill="#fff" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />,
  },
  Substack: { bg: '#FF6719', chart: '#FF6719', glyph: <path fill="#fff" d="M7 6.2h10v1.7H7zM7 9.5h10v1.7H7zM7 12.8h10V18.6l-5-2.9-5 2.9z" /> },
  Instagram: {
    bg: '#E1306C',
    chart: '#E1306C',
    glyph: <>
      <rect x="6" y="6" width="12" height="12" rx="3.6" {...stroke} strokeWidth="1.8" />
      <circle cx="12" cy="12" r="2.8" {...stroke} strokeWidth="1.8" />
      <circle cx="15.4" cy="8.6" r=".9" fill="#fff" />
    </>,
  },
  X: {
    bg: '#0F1419',
    chart: '#334155',
    glyph: <path d="M6.4 6.2h2.8l3.5 4.7 4-4.7h1.9l-5 5.8 5.4 7.3h-2.8l-3.8-5.1-4.4 5.1H6.1l5.3-6.2z" fill="#fff" />,
  },
  微博: { bg:'#DF2637', glyph:word('微',13) },
  小宇宙: { bg:'#459CDD', glyph:<g {...stroke}><ellipse cx="12" cy="12" rx="7" ry="3" transform="rotate(-30 12 12)" /><circle cx="12" cy="12" r="3" /></g> },
  'Apple Podcasts': { bg:'#8E38D4', glyph:<g {...stroke}><circle cx="12" cy="10" r="2" /><path d="M9.7 14a2.3 2 0 0 1 4.6 0l-.9 4.3h-2.8zM7.5 15a6.3 6.3 0 1 1 9 0" /></g> },
  播客: {
    bg: '#8E44EC',
    chart: '#8E44EC',
    glyph: <path d="M12 5.2a2.4 2.4 0 0 0-2.4 2.4v3.8a2.4 2.4 0 0 0 4.8 0V7.6A2.4 2.4 0 0 0 12 5.2zM7.8 11.2a4.2 4.2 0 0 0 8.4 0M12 15.4v3.2" {...stroke} strokeWidth="1.8" />,
  },
}

const AVATAR_GRADIENTS = [
  ['#3B82F6', '#1D4ED8'],
  ['#10B981', '#047857'],
  ['#F43F5E', '#BE123C'],
  ['#8B5CF6', '#6D28D9'],
  ['#F59E0B', '#D97706'],
  ['#06B6D4', '#0E7490'],
  ['#EC4899', '#BE185D'],
  ['#6366F1', '#4338CA'],
]

const AVATAR_STORE_KEY = 'media-desk:custom-avatars'

export function readCustomAvatars() {
  try { return JSON.parse(localStorage.getItem(AVATAR_STORE_KEY) || '{}') || {} } catch { return {} }
}

export function saveCustomAvatar(key, url) {
  try {
    const next = { ...readCustomAvatars() }
    if (url) next[key] = url
    else delete next[key]
    localStorage.setItem(AVATAR_STORE_KEY, JSON.stringify(next))
  } catch { /* ignore */ }
}

function hashSeed(text = '') {
  let h = 2166136261
  for (const ch of String(text)) h = Math.imul(h ^ ch.codePointAt(0), 16777619)
  return h >>> 0
}

function avatarMonogram(name = '', handle = '') {
  const clean = String(name || handle || '').replace(/^@/, '').trim()
  if (!clean) return '·'
  const cjk = clean.match(/[\u4e00-\u9fff]/)
  if (cjk) return cjk[0]
  const words = clean.split(/[\s._-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return clean.slice(0, 2).toUpperCase()
}

/** 平台品牌色，给筛选条、小标签和迷你图表用。 */
export const platformColor = platform => LOGOS[platform]?.bg || '#64748B'
export const platformChartColor = platform => LOGOS[platform]?.chart || LOGOS[platform]?.bg || '#3B82F6'

export function PlatformLogo({ platform, size = 20, className = '', radius = 6.5 }) {
  const logo = LOGOS[platform]
  return (
    <svg className={`md-plat-logo ${className}`} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={platform || ''}>
      <rect width="24" height="24" rx={radius} fill={logo?.bg || '#64748B'} />
      {logo ? logo.glyph : word([...String(platform || '·')][0], 12)}
    </svg>
  )
}

/**
 * 账号头像组件：优先展示自定义头像 / 本地头像 / X 实时头像，失败或离线时平滑回退到高质感渐变首字母 + 平台角标。
 */
export function AccountAvatar({
  name = '',
  handle = '',
  platform = 'X',
  src = '',
  avatarKey = '',
  size = 40,
  badge = true,
  square = false,
  className = '',
}) {
  const custom = avatarKey ? readCustomAvatars()[avatarKey] : ''
  const cleanHandle = String(handle || '').replace(/^@/, '').trim()
  const autoX = !custom && !src && !avatarKey?.startsWith('demo-') && platform === 'X' && /^[A-Za-z0-9_]{1,15}$/.test(cleanHandle)
    ? `https://unavatar.io/x/${encodeURIComponent(cleanHandle)}`
    : ''
  const resolved = custom || src || autoX
  const [failedUrl, setFailedUrl] = React.useState('')
  const showImage = Boolean(resolved && failedUrl !== resolved)

  const seed = hashSeed(`${platform}:${cleanHandle || name}`)
  const [c1, c2] = AVATAR_GRADIENTS[seed % AVATAR_GRADIENTS.length]
  const mono = avatarMonogram(name, cleanHandle)
  const badgeSize = Math.max(14, Math.round(size * 0.4))

  return (
    <span
      className={`md-acct-avatar ${square ? 'is-square' : ''} ${className}`}
      style={{
        width: size,
        height: size,
        '--av-c1': c1,
        '--av-c2': c2,
        fontSize: Math.max(11, Math.round(size * (mono.length > 1 ? 0.34 : 0.42))),
      }}
    >
      <span className="md-acct-avatar-inner">
        {showImage ? (
          <img
            src={resolved}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailedUrl(resolved)}
          />
        ) : (
          <b>{mono}</b>
        )}
      </span>
      {badge && platform ? (
        <span className="md-acct-avatar-badge" style={{ width: badgeSize, height: badgeSize }}>
          <PlatformLogo platform={platform} size={badgeSize} radius={6.5} />
        </span>
      ) : null}
    </span>
  )
}

/**
 * 麦田式品牌色渐变面积微缩折线图（Area Sparkline）：用于各渠道卡片和账号卡片底部。
 */
export function AreaSparkline({
  values = [],
  platform = '',
  color = '',
  width = 200,
  height = 48,
  className = '',
}) {
  const gradId = React.useId()
  const strokeColor = color || platformChartColor(platform)
  const series = values.length >= 2 ? values.map(v => Number(v) || 0) : [0, ...(values.map(v => Number(v) || 0)), 0]
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min
  const padX = 3
  const padTop = 6
  const padBot = 4
  const innerW = Math.max(10, width - padX * 2)
  const innerH = Math.max(10, height - padTop - padBot)

  const pts = series.map((val, idx) => {
    const x = padX + (idx / Math.max(series.length - 1, 1)) * innerW
    const ratio = span > 0 ? (val - min) / span : (max > 0 ? 0.55 : 0.14)
    const y = padTop + (1 - ratio) * innerH
    return [x, y]
  })

  // 平滑曲线连接
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    const cx = ((x0 + x1) / 2).toFixed(1)
    d += ` C ${cx} ${y0.toFixed(1)}, ${cx} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`
  }
  const last = pts[pts.length - 1]
  const first = pts[0]
  const areaD = `${d} L ${last[0].toFixed(1)} ${height} L ${first[0].toFixed(1)} ${height} Z`

  return (
    <svg
      className={`md-area-spark ${className}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.24" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gradId})`} />
      <path d={d} fill="none" stroke={strokeColor} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
