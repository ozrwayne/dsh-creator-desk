// dsh-media-desk 浏览器半片：侧栏入口 + main 全局面板。
import React from 'react'
import { HomeView } from './canvas.jsx'
import { FlowView } from './flow.jsx'
import { bindHost, openDsh } from './dsh.js'
import { ContentView } from './content.jsx'
import { PALETTES, captureFiles, captureUrl, dispatchOps, loadDesk, selectPalette, setDesk, stepFontScale, stepPalette, toggleLanguage, undo, useBoardRefresh, useDesk } from './desk.js'
import { InsightsView } from './insights.jsx'
import { ScheduleView } from './schedule.jsx'
import { AtomReader, AtomsView } from './atoms.jsx'
import { BenchView, benchText } from './bench.jsx'
import { PiecePanel } from './piece.jsx'
import { SettingsDialog } from './settings.jsx'
import { Studio } from './studio.jsx'
import css from './styles.css'
import { lang, subscribeLang, t, useLang } from './i18n.js'
import { Dialog, FormDialog, Icon, IconButton, Toast } from './ui.jsx'

const PANEL_ID = 'media-desk'

// navKey：同一个中文在别处意思不同（单数的“灵感”“风格”），英文导航另查一条
const NAV = [
  { id: 'home', label: '灵感', navKey: '灵感（导航）' },
  { id: 'bench', label: '对标账号' },
  { id: 'atoms', label: '知识原子' },
  { id: 'flow', label: '流程' },
  { id: 'content', label: '内容' },
  { id: 'schedule', label: '排期' },
  { id: 'insights', label: '复盘' },
]

const VIEWS = { home: HomeView, bench: BenchView, atoms: AtomsView, flow: FlowView, content: ContentView, schedule: ScheduleView, insights: InsightsView }

function CaptureDialog() {
  const capture = useDesk(s => s.capture)
  const [tab, setTab] = React.useState('text')
  const [text, setText] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const fileInput = React.useRef(null)
  React.useEffect(() => {
    if (!capture) return
    setTab(capture.tab ?? 'text')
    setText('')
    setUrl('')
  }, [capture])
  if (!capture) return null
  const close = () => setDesk({ capture: null })
  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    if (tab === 'link' && url.trim()) {
      const id = await captureUrl(url.trim())
      if (id) close()
    } else if (tab === 'quote' || tab === 'text') {
      const value = text.trim()
      if (value) {
        await dispatchOps([{ op: 'add_item', kind: tab === 'quote' ? 'quote' : 'note', title: tab === 'quote' ? value : value.split(/[。！？\n]|[.!?](?=\s|$)/)[0].slice(0, 40), body: tab === 'quote' ? '' : value }], { label: t('记下灵感') })
        close()
      }
    }
    setBusy(false)
  }
  const tabs = [['text', t('笔记')], ['quote', t('金句')], ['link', t('链接')], ['file', t('图片/视频')]]
  return (
    <Dialog title={t('记下一个灵感')} onClose={close} width={480}>
      <div className="md-capture-tabs" role="tablist">
        {tabs.map(([id, label]) => <button type="button" role="tab" key={id} aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <form className="md-form" onSubmit={save}>
        {tab === 'link' ? (
          <label className="md-field">
            <span>{t('链接')}</span>
            <input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://" />
            <small>{t('工作台会读取页面的标题、简介和封面。')}</small>
          </label>
        ) : tab === 'file' ? (
          <button type="button" className="md-dropzone" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={22} />
            <span>{t('选择图片或视频')}</span>
            <small>{t('也可以把文件拖到灵感墙上')}</small>
            <input ref={fileInput} type="file" hidden multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={async (e) => { const files = [...e.target.files]; close(); await captureFiles(files) }} />
          </button>
        ) : (
          <label className="md-field">
            <span>{tab === 'quote' ? t('这句话') : t('想法')}</span>
            <textarea rows={4} required value={text} onChange={e => setText(e.target.value)} placeholder={tab === 'quote' ? t('输入金句') : t('先记下想法，之后可以让助手补充。')} />
          </label>
        )}
        {tab === 'file' ? null : (
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={close}>{t('取消')}</button>
            <button type="submit" className="md-btn is-primary" disabled={busy}>{busy ? t('保存中…') : t('放到灵感墙')}</button>
          </div>
        )}
      </form>
    </Dialog>
  )
}

function SampleBadge() {
  const hasSample = useDesk(s => s.state.items.some(i => i.sample))
  if (!hasSample) return null
  return (
    <button type="button" className="md-sample" title={t('当前内容均为示例数据，可以一键清空')} onClick={() => setDesk({
      dialog: {
        title: t('清空示例数据'),
        submitLabel: t('清空'),
        fields: [],
        onSubmit: () => dispatchOps([{ op: 'clear_samples' }], { label: t('清空示例数据') }),
      },
    })}>{t('示例数据 · 清空')}</button>
  )
}

function PaletteSwitcher({ palette }) {
  const [open, setOpen] = React.useState(false)
  const wrapRef = React.useRef(null)
  const isEn = lang() === 'en'
  const current = PALETTES.find(p => p.id === palette) || PALETTES[0]

  React.useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="md-palette-wrap" ref={wrapRef}>
      <div className="md-palette-group">
        <button
          type="button"
          className="md-palette-step"
          aria-label={isEn ? 'Previous palette' : '上一个配色'}
          title={isEn ? 'Previous palette' : '上一个配色'}
          onClick={() => stepPalette(-1)}
        >‹</button>
        <button
          type="button"
          className="md-palette-trigger"
          aria-expanded={open}
          title={isEn ? 'Choose among 4 color themes' : '展开选择 4 套主题色调'}
          onClick={() => setOpen(v => !v)}
        >
          <span className="md-palette-swatch" aria-hidden="true">
            <i style={{ background: current.c1 }} />
            <i style={{ background: current.c2 }} />
          </span>
          <span className="md-palette-name">{isEn ? current.en : current.zh}</span>
        </button>
        <button
          type="button"
          className="md-palette-step"
          aria-label={isEn ? 'Next palette' : '下一个配色'}
          title={isEn ? 'Next palette' : '下一个配色'}
          onClick={() => stepPalette(1)}
        >›</button>
      </div>
      {open ? (
        <div className="md-palette-menu" role="menu">
          {PALETTES.map(item => {
            const active = item.id === current.id
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={active}
                key={item.id}
                className={`md-palette-option ${active ? 'is-on' : ''}`}
                onClick={() => { selectPalette(item.id); setOpen(false) }}
              >
                <span className="md-palette-swatch is-lg" aria-hidden="true">
                  <i style={{ background: item.c1 }} />
                  <i style={{ background: item.c2 }} />
                </span>
                <span className="md-palette-opt-copy">
                  <strong>{isEn ? item.en : item.zh}</strong>
                  <small>{isEn ? item.subEn : item.subZh}</small>
                </span>
                {active ? <Icon name="check" size={14} /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function Desk() {
  // 切换语言时整棵树重新渲染
  useLang()
  useBoardRefresh()
  const ready = useDesk(s => Boolean(s.state))
  const error = useDesk(s => s.error)
  const view = useDesk(s => s.view)
  const canUndo = useDesk(s => s.canUndo)
  const fontScale = useDesk(s => s.settings?.fontScale || 1)
  const rootRef = React.useRef(null)
  const navRef = React.useRef(null)
  const [width, setWidth] = React.useState(1600)
  const narrow = width < 1020

  React.useEffect(() => { loadDesk() }, [])
  React.useEffect(() => {
    const el = rootRef.current
    if (!el) return undefined
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  React.useLayoutEffect(() => {
    const nav = navRef.current
    const selected = nav?.querySelector('[aria-current="page"]')
    if (!selected) return
    const left = selected.offsetLeft
    const right = left + selected.offsetWidth
    if (left < nav.scrollLeft) nav.scrollLeft = left
    else if (right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right - nav.clientWidth
  }, [view, width])
  React.useEffect(() => {
    const onKey = (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable
      if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey && !typing && canUndo) {
        event.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canUndo])

  const palette = useDesk(s => s.palette || 'warm')
  const Active = VIEWS[view] ?? HomeView
  return (
    <div className={`md-root ${narrow ? 'is-narrow' : ''} ${width < 780 ? 'is-compact' : ''}`} data-palette={palette} style={{ zoom: fontScale }} ref={rootRef}>
      <style>{css}</style>
      <div className="md-ambient" aria-hidden="true"><i /><i /><i /></div>
      <div className="md-main">
        <header className="md-topbar" data-window-drag="">
          <nav ref={navRef} className="md-nav" aria-label={t('工作台导航')}>
            {NAV.map(entry => (
              <button type="button" key={entry.id} className={view === entry.id ? 'is-on' : ''} aria-current={view === entry.id ? 'page' : undefined} onClick={() => setDesk({ view: entry.id, focusId: null, ownOpen: null, atomOpen: entry.id === 'atoms' ? undefined : null })}>{entry.id === 'bench' ? benchText(entry.label) : entry.navKey && lang() === 'en' ? t(entry.navKey) : t(entry.label)}</button>
            ))}
          </nav>
          <div className="md-topbar-tools">
            {ready ? <SampleBadge /> : null}
            {canUndo ? <IconButton icon="undo" label={t('撤销上一步')} onClick={undo} /> : null}
            <PaletteSwitcher palette={palette} />
            <button type="button" className="md-font-btn" aria-label={t('减小字号')} onClick={() => stepFontScale(-1)}>A−</button>
            <button type="button" className="md-font-btn" aria-label={t('增大字号')} onClick={() => stepFontScale(1)}>A+</button>
            <button type="button" className="md-lang-btn" aria-label={t('切换语言')} onClick={toggleLanguage}><span className={lang() === 'en' ? '' : 'is-on'}>中</span><span aria-hidden="true"> / </span><span className={lang() === 'en' ? 'is-on' : ''}>EN</span></button>
            <IconButton icon="gear" label={t('设置')} onClick={() => setDesk({ settingsOpen: true })} />
            <button type="button" className="md-open-dock md-assistant-open" onClick={() => openDsh()}><Icon name="chat" size={15} /><span>{lang() === 'en' ? 'DSH chat' : 'DSH 对话'}</span></button>
          </div>
        </header>
        <main className="md-content" key={view}>
          {error ? (
            <div className="md-page"><p className="md-muted">{t('工作台加载失败：{error}', { error })}</p><button type="button" className="md-btn" onClick={loadDesk}>{t('重试')}</button></div>
          ) : ready ? <Active /> : <div className="md-loading"><span className="md-shimmer">{t('正在加载灵感…')}</span></div>}
        </main>
        {ready ? <Studio /> : null}
      </div>
      {ready ? <AtomReader /> : null}
      {ready ? <PiecePanel /> : null}
      {ready ? <CaptureDialog /> : null}
      <FormDialog />
      {ready ? <SettingsDialog /> : null}
      <Toast />
    </div>
  )
}

function PanelIcon({ size }) {
  return <Icon name="scatter" size={size} />
}

export const inject = ['slots', 'layout', 'uiWorkspace']

export function apply(ctx) {
  bindHost(ctx)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Desk))
  // 侧栏的名字只在注册时读一次，换语言时重新注册
  ctx.effect(() => {
    let release = null
    const mount = () => {
      release?.()
      release = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 5,
        label: () => t('自媒体工作台'),
      }, PanelIcon))
    }
    mount()
    const off = subscribeLang(mount)
    return () => { off(); release?.() }
  }, 'dsh-media-desk: sidebar entry')
}
