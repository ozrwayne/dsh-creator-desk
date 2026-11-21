import test from 'node:test'
import assert from 'node:assert/strict'
import { withSelection } from '../src/ai.js'
import { draftReply } from '../src/draft-chat.js'

const message = { title: 'Title', scope: 'selection', draft: 'only this passage', instruction: 'tighten', history: [] }
function host(chunks) {
  const calls = []
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'default', model: 'one' }) },
    llm: { async prepareCall(config) { return { config, async *stream(request) { calls.push(request); yield* chunks } } } },
  }
  return { get: name => services[name], calls }
}
const complete = [{ type: 'reasoning-delta', text: 'private' }, { type: 'text-delta', text: '{"reply":"tightened","replacement":"passage"}' }, { type: 'finish', reason: {kind:'stop'} }]
test('the session route and effort take precedence; the next unscoped call uses the DSH default', async () => {
  const ctx = host(complete)
  const route = { provider: 'session', model: 'two', reasoningEffort: 'high' }
  const answer = await withSelection(encodeURIComponent(JSON.stringify(route)), () => draftReply(ctx, message))
  assert.deepEqual(answer, { reply: 'tightened', replacement: 'passage', model: 'session/two' })
  assert.equal(ctx.calls[0].reasoningEffort, 'high')
  assert.deepEqual(JSON.parse(ctx.calls[0].messages[0].content[0].text), message)
  assert.equal(ctx.calls[0].tools, undefined)
  assert.equal((await draftReply(ctx, message)).model, 'default/one')
})
test('failed and truncated streams cannot propose an edit or try another provider', async () => {
  for (const kind of ['max-tokens','aborted','error']) {
    const ctx = host([...complete.slice(0,2), {type:'finish',reason:{kind}}])
    await assert.rejects(draftReply(ctx, message), /DSH/)
    assert.equal(ctx.calls.length,1)
  }
})
test('advice is distinct from deletion; invalid input never reaches the model', async () => {
  for (const replacement of [null,'']) {
    const ctx = host([{ type:'text-delta', text:JSON.stringify({ reply:'ok', replacement }) },complete.at(-1)])
    assert.equal((await draftReply(ctx, message)).replacement, replacement)
    await assert.rejects(draftReply(ctx,{...message,history:[{question:'oversize'.repeat(600)}]}), {status:400})
    assert.equal(ctx.calls.length,1)
  }
})
