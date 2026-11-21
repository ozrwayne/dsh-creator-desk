import React from 'react'
import { request } from './desk.js'
import { lang } from './i18n.js'

export function DraftChat({ title, body, editor, onChange, selection }) {
  const en = lang() === 'en'
  const say = (zh, english) => en ? english : zh
  const [question, setQuestion] = React.useState('')
  const [turns, setTurns] = React.useState([])
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState('')
  const [proposal, setProposal] = React.useState(null)
  const [undo, setUndo] = React.useState(null)
  const sending = React.useRef(null)
  const log = React.useRef(null)
  React.useEffect(() => () => { sending.current?.abort(); sending.current = null }, [])
  React.useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [turns, pending])
  async function send() {
    const instruction = question.trim()
    if (!instruction || sending.current || !editor.current) return
    const { selectionStart, selectionEnd } = editor.current
    const part = selectionStart !== selectionEnd
    const start = part ? selectionStart : 0, end = part ? selectionEnd : body.length
    const controller = new AbortController()
    sending.current = controller
    setError(''); setPending(true)
    const history = turns.slice(-6).map(({ question, answer, suggestion }) => ({ question, answer: answer.slice(0,6000), suggestion: (suggestion ?? '').slice(0,6000) }))
    try {
      const result = await request('draft/chat', { title, instruction, scope: part ? 'selection' : 'draft', draft: body.slice(start, end), history }, controller.signal)
      if (controller.signal.aborted) return
      setTurns(rows => [...rows, { question: instruction, answer: result.reply, suggestion: result.replacement, model: result.model }])
      setProposal(result.replacement === null ? null : { base: body, start, end, replacement: result.replacement })
      setQuestion('')
    } catch (e) { if (!controller.signal.aborted) setError(e.message) }
    finally { if (sending.current === controller) { sending.current = null; setPending(false) } }
  }
  return <section className="md-draft-chat" aria-label={say('稿件对话', 'Draft chat')}>
    <header><h3>{say('稿件对话', 'Draft chat')}</h3><small>{say('模型跟随 DSH', 'DSH model')}</small></header>
    <div ref={log} className="md-draft-log" role="log" aria-live="polite">
      {!turns.length && <p>{say('想改哪里？可以选中一段，或直接问整篇。', 'Select a passage, or ask about the whole draft.')}</p>}
      {turns.map((turn,i) => <div className="md-draft-turn" key={i}><strong>{turn.question}</strong><p>{turn.answer}</p>{turn.suggestion !== null && <blockquote>{turn.suggestion || say('删除所选内容', 'Remove this text')}</blockquote>}<small>{turn.model}</small></div>)}
    </div>
    {proposal && <div>{proposal.base === body ? <button type="button" className="md-btn is-small" disabled={pending} onClick={() => {
      if (body !== proposal.base) return
      const next = body.slice(0, proposal.start) + proposal.replacement + body.slice(proposal.end)
      onChange(next); setUndo({ before: body, after: next }); setProposal(null)
    }}>{say('采用到正文', 'Apply to draft')}</button> : <small>{say('正文已更改，请重新提问。', 'Draft changed. Ask again before applying.')}</small>}</div>}
    {undo?.after === body && <div><button type="button" className="md-btn is-small" onClick={() => { onChange(undo.before); setUndo(null) }}>{say('撤回采用', 'Undo edit')}</button> <small>{say('点「保存正文」写入稿件', 'Save the draft to keep changes')}</small></div>}
    <form onSubmit={e => { e.preventDefault(); send() }}>
      <textarea rows={2} maxLength={4000} value={question} disabled={pending} aria-label={say('稿件问题', 'Ask about draft')} placeholder={say('例如：把开头缩短一半', 'Try: cut the opening in half')} onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
      <div className="md-draft-actions"><small>{selection ? say('发送选中段落', 'Send selection') : say('发送当前正文', 'Send draft')}</small>{pending ? <button type="button" className="md-btn is-small" onClick={() => sending.current?.abort()}>{say('停止', 'Stop')}</button> : <button type="submit" className="md-btn is-small is-primary" disabled={!question.trim()}>{say('发送', 'Send')}</button>}</div>
    </form>
    {error && <small role="alert">{error}</small>}
  </section>
}
