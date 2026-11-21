import React from 'react'
import { lang, t } from './i18n.js'
import { setDesk, useDesk } from './desk.js'
import { openDsh } from './dsh.js'

// A workspace task can use DSH's tools. The host opens a composer, never auto-sends it.
export function ChatPanel({ head, top, suggestions, placeholder, disabled, item }) {
  const quote = useDesk(s => s.chatQuote)
  const [text, setText] = React.useState('')
  const input = React.useRef(null)
  React.useEffect(() => { if (quote) input.current?.focus() }, [quote])
  function open(value) {
    if (!value.trim() || disabled) return
    openDsh([item.title, quote?.text || item.production?.article || item.body, quote?.label, value].filter(Boolean).join('\n\n'))
    setDesk({ chatQuote: null })
  }
  return <div className="md-chat"><header className="md-dock-head">{head}</header><div className="md-dock-scroll">{top}</div>
    <div className="md-suggest">{suggestions.map(s => <button type="button" key={s} onClick={() => setText(s)}>{s}</button>)}</div>
    <form className="md-composer" onSubmit={e => { e.preventDefault(); open(text) }}>
      {quote && <div className="md-composer-ctx"><span>{quote.text || quote.label}</span><button type="button" onClick={() => setDesk({ chatQuote: null })} aria-label={t('取消引用')}>×</button></div>}
      <textarea rows={2} ref={input} value={text} onChange={e => setText(e.target.value)} placeholder={placeholder} disabled={disabled} />
      <button className="md-btn is-small" disabled={!text.trim() || disabled}>{lang() === 'en' ? 'Continue in DSH' : '在 DSH 继续'}</button>
    </form></div>
}
