// Executable discovery for the optional X data reader. Manuscript editing uses DSH.
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

let cachedBin
function locateOmp() {
  const dirs = []
  const seen = new Set()
  const add = (dir) => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    dirs.push(dir)
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) add(dir)
  add(join(homedir(), '.local', 'bin'))
  add('/opt/homebrew/bin')
  add('/usr/local/bin')
  for (const dir of dirs) {
    const file = join(dir, 'omp')
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch { /* 下一个位置 */ }
  }
  return null
}

export function findOmp() {
  if (cachedBin !== undefined) return cachedBin
  cachedBin = locateOmp()
  return cachedBin
}

