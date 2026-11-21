// 把 client/ 打包成 DSH 的 lazy CommonJS 模块：react 留给宿主提供，CSS 内联成字符串。
import { build, context } from 'esbuild'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildMaitianExtensionZip } from '../src/publish-bundle.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const options = {
  entryPoints: ['client/index.jsx'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  external: ['react'],
  loader: { '.css': 'text' },
  minify: !process.argv.includes('--watch'),
  legalComments: 'none',
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{const module={exports:{}};const exports=module.exports;` },
  footer: { js: 'return module.exports}})' },
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('watching client/')
} else {
  const result = await build({ ...options, metafile: true })
  const size = Object.values(result.metafile.outputs)[0].bytes
  console.log(`dist/client.js ${(size / 1024).toFixed(1)} KB`)
  const extDir = join(ROOT, 'extensions', 'maitian-publisher')
  if (await stat(join(extDir, 'manifest.json')).then(s => s.isFile(), () => false)) {
    await mkdir(join(ROOT, 'dist'), { recursive: true })
    const zipBuf = await buildMaitianExtensionZip(extDir)
    await writeFile(join(ROOT, 'dist', 'maitian-publisher.zip'), zipBuf)
    console.log(`dist/maitian-publisher.zip ${(zipBuf.length / 1024).toFixed(1)} KB`)
  }
}
