// 收录任务的子进程：独立进程组，退出码写到文件，父进程重启不会带走它。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const POLL_MS = 3000

export function exitPath(dataDir, id) {
  const text = String(id ?? '')
  if (!/^[\w.-]+$/.test(text)) return null
  return join(dataDir, 'jobs', `${text}.exit`)
}

export function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

export function killGroup(pid, signal = 'SIGTERM') {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return
  try { process.kill(-n, signal) } catch { /* 已经退出 */ }
}

export async function readExitCode(file) {
  if (!file) return null
  try {
    const text = (await readFile(file, 'utf8')).trim()
    if (!text) return null
    const code = Number(text)
    return Number.isInteger(code) ? code : null
  } catch (err) {
    if (err.code === 'ENOENT') return null
    return null
  }
}

/** 参数走 argv，退出码由包装写到 EXIT_FILE，不把命令拼进字符串。 */
export function spawnWrapped(spawn, { bin, args, cwd, env, logFd, exitFile }) {
  const child = spawn('/bin/sh', [
    '-c',
    '"$@"; echo $? > "$EXIT_FILE"',
    'sh',
    bin,
    ...args,
  ], {
    cwd,
    env: { ...env, EXIT_FILE: exitFile },
    detached: true,
    stdio: ['ignore', logFd, logFd],
    shell: false,
  })
  child.unref?.()
  return child
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 先看退出码文件，再看 pid。取消和超时由调用方的标志决定，避免和「进程意外退出」抢状态。
 */
export async function waitForExit({
  exitFile,
  pid,
  pollMs = POLL_MS,
  startedAt = null,
  timeoutMs = 0,
  isCancelled = () => false,
  isAbandoned = () => false,
}) {
  const deadline = timeoutMs > 0 && startedAt ? Date.parse(startedAt) + timeoutMs : 0
  for (;;) {
    if (isAbandoned()) return { abandoned: true }
    if (isCancelled()) {
      killGroup(pid)
      return { cancelled: true }
    }
    if (deadline && Date.now() >= deadline) {
      killGroup(pid)
      return { timedOut: true }
    }
    const code = await readExitCode(exitFile)
    if (code !== null) return { code }
    if (!pidAlive(pid)) {
      for (let i = 0; i < 5; i += 1) {
        if (isAbandoned()) return { abandoned: true }
        if (isCancelled()) return { cancelled: true }
        await sleep(40)
        const late = await readExitCode(exitFile)
        if (late !== null) return { code: late }
      }
      return { unexpected: true }
    }
    await sleep(pollMs)
    if (isAbandoned()) return { abandoned: true }
  }
}
