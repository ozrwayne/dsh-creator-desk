// 知识库回收站。稿件删除和笔记否决都落到 <vaultRoot>/.trash/自媒体工作台/<时间>/。
import { lstat, mkdir, rename, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'

export function trashStamp(date) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

export async function openTrashDir(vaultRoot, date) {
  let dir = vaultRoot
  for (const part of ['.trash', '自媒体工作台', trashStamp(date)]) {
    dir = join(dir, part)
    try { await mkdir(dir) } catch (err) { if (err.code !== 'EEXIST') throw err }
    if (!(await lstat(dir)).isDirectory()) throw Object.assign(new Error('路径无效'), { status: 400 })
  }
  return dir
}

export async function uniqueDest(dir, name) {
  let dest = join(dir, name)
  let n = 2
  for (;;) {
    try {
      await stat(dest)
    } catch (err) {
      if (err.code === 'ENOENT') return dest
      throw err
    }
    const dot = name.lastIndexOf('.')
    const next = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`
    dest = join(dir, next)
    n += 1
  }
}

/** 把一个文件移进回收站，返回相对 vaultRoot 的路径。 */
export async function moveToTrash(vaultRoot, file, date) {
  const destDir = await openTrashDir(vaultRoot, date)
  const dest = await uniqueDest(destDir, basename(file))
  await rename(file, dest)
  return relative(vaultRoot, dest).split(sep).join('/')
}
