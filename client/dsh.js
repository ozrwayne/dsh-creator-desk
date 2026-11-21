// Capture the host selection at send time; never store a provider preference here.
let host
export function bindHost(ctx) { host = ctx }
export async function selectedRoute() {
  const sessions = host?.get('sessions')
  const current = Object.values(sessions?.list.getSnapshot().byId || {}).find(row => row.retainedBy.mainView)
  if (!current) return null
  const directory = host.get('modelDirectories')?.directoryFor(current.id)
  if (!directory) throw new Error('DSH: 当前会话模型不可用 / Session model unavailable')
  let state = directory.store.getSnapshot()
  if (!state.current && !state.pending) state = await directory.load()
  if (state.pending) throw new Error('DSH: 正在切换模型 / Model change in progress')
  if (!state.current || state.status !== 'ready' || state.routable === false) throw new Error('请在 DSH 检查当前会话模型 / Check the session model in DSH')
  return state.current
}
export function openDsh(prompt) {
  if (!prompt) return host.layout.selectPanel(null)
  host.uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
}
