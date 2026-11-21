import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dshHome, Store } from '../src/store.js'
import { Settings } from '../src/settings.js'
import { Pieces, STATUS_DIRS } from '../src/pieces.js'
import { PATHS } from '../src/vault.js'
import { OWN_SOURCE, OWN_COLUMNS } from '../src/own-source.js'
import { DESK_TO_MAITIAN, DESK_TO_WECHATSYNC, PublishStore } from '../src/publish-map.js'
import { BundleService } from '../src/publish-bundle.js'

const demoFile = async name => JSON.parse(await readFile(new URL(`../demo/${name}.json`, import.meta.url), 'utf8'))

const asset = name => fileURLToPath(new URL(`../assets/${name}`, import.meta.url))
const date = '2026-03-14'
const lines = [
  ['纸飞机的折痕', '先将纸沿中线对折，展开后把两个上角对准中线。机翼左右等宽时，再轻轻掷出。'],
  ['窗边的影子', '把一张白纸摆在窗边，分别记下午前和午后的影子。用相同机位拍摄，比较影子移动的方向。'],
]

// Public manuscripts only. Like an imported local vault, the folders determine
// status; the native reader derives badges and exposure from the Markdown headers.
async function seedContentBoard(settings, root, put, today) {
  const day = ago => new Date(today.getTime() - ago * 86400000).toISOString().slice(0,10)
  const shortSamples = [
    { topic:'重心的落点', title:'同一架纸飞机，回形针夹在哪里飞得最稳？', ago:8, views:6840, stage:'3升级', text:'沿机身画三条线，依次把同一枚回形针夹在前、中、后段。从同一条地板缝起飞，在落点贴一小块纸胶带。先看落点聚在哪里，再挑飞得最远的那次。' },
    { topic:'窗边的光', title:'用一条胶带，记下窗边光线走过的距离', ago:5, views:3760, stage:'2验证', text:'上午把胶带贴在书脊影子的末端。午饭后再拍同一个角度，保留桌沿作参照，两张照片就能拼成一张光线地图。' },
    { topic:'纸桥的跨度', title:'同一张纸横跨两只杯子，折一道能撑多久？', ago:2, views:920, stage:'1测试', text:'让两个杯口隔开一掌，先架平纸，再试手风琴折。每次只加一枚相同的垫片，记下桥面最早下弯的位置。' },
  ]
  const shorts = []
  for (const s of shortSamples) {
    const date = day(s.ago)
    const origin = `${date}-${s.topic}`
    const note = `${date}-${s.title}`
    const line = `知识原子/${s.topic}`
    await put(join(PATHS.atoms, origin+'.md'), `日期: ${date}\n\n# ${s.topic}\n\n${s.text}\n`)
    await put(join(STATUS_DIRS.短推.已发布, note+'.md'), `来源: [[${origin}]]\n日期: ${date}\n账号: 纸飞机编辑部\n平台: X\n选题: ${line}\n阶段: ${s.stage}\n状态: 已发布\n分发: X | ${date} | https://example.org/demo/short-${s.ago} | ${s.views}\n\n# ${s.title}\n\n${s.text}\n`)
    shorts.push({ note, line })
  }
  const drafts = [
    { title:'纸飞机配重实验：从一条投掷线到一张落点图', ago:4, parent:shorts[0], text:'在白板上画出起飞线和三组落点，每组用一种颜色。先讲为什么要固定投掷姿势，再拆开比较配重位置、飞行路径和落地距离。', next:'补拍一次侧面慢镜头，让读者看清机头从哪里开始下沉。' },
    { title:'一本能平摊的手工小册，装订前要留多少空白？', ago:3, text:'用同一张插画试做两本八页小册。把内侧的图案对齐，分别用线装和订书钉固定，打开后量一量书脊吃掉了多少画面。', next:'把两张跨页照片并排，标出被遮住的毫米数。' },
    { title:'雨天的收音练习：屋檐、水洼和一扇半开的窗', ago:1, text:'在三个位置各录十秒，保留一段环境底噪。回听时先辨别落点的材质，再找出声音被遮住的那一刻。', next:'整理三个试听片段，给每段加上麦克风距离。' },
  ]
  for (const draft of drafts) {
    const date = day(draft.ago)
    const source = draft.parent ? `[[${draft.parent.note}]]` : '工作台'
    await put(join(STATUS_DIRS.长文.进行中, `${date}-${draft.title}.md`), `来源: ${source}\n日期: ${date}\n账号: 纸飞机编辑部\n平台: X, 公众号, 知乎\n选题: ${draft.parent?.line || draft.title}\n阶段: 0想法\n状态: 进行中\n\n# ${draft.title}\n\n${draft.text}\n\n## 下次记录\n\n${draft.next}\n`)
  }
  const title = '视频示例：四秒潮汐'
  const date = day(0)
  const note = `${date}-${title}`
  const file = await put(join(STATUS_DIRS.视频.定稿, `${note}.md`),
    `来源: 工作台\n日期: ${date}\n账号: 纸飞机放映室\n平台: ${Object.keys(DESK_TO_MAITIAN).join(', ')}\n选题: 四秒潮汐\n阶段: 1测试\n状态: 定稿\n\n# ${title}\n\n浅沙色渐渐转为深蓝。一道白色的浪纹划过画面，四秒后回到起点。\n`)
  const media = file.slice(0, -3) + '-assets'
  await mkdir(media)
  const clip = join(media, '成片.mp4')
  await copyFile(asset('v-tide-poster.jpg'), join(media, 'cover.jpg'))
  await copyFile(asset('v-tide.mp4'), clip)
  const pieces = new Pieces(settings, { dataDir: root })
  const bundles = new BundleService({ settings, pieces: () => pieces, publishStore: new PublishStore(root) })
  await bundles.placeVideo({ note, sourcePath: clip })
  return shortSamples.length + drafts.filter(d => !d.parent).length + 1
}

async function seedPublishingBoard(settings, root, put, today) {
  // Retain the separate end-to-end publishing fixture, including local video assets.
  const pieces = new Pieces(settings, { dataDir: root, now: () => new Date(2026, 2, 14, 12) })
  for (const [topic, text] of lines) {
    const origin = `${date}-${topic}`
    await put(join(PATHS.atoms, origin+'.md'), `日期: ${date}\n\n# ${topic}\n\n${text}\n`)
    const short = await pieces.create({ form:'短推', title:topic+'速记', originNote:origin })
    const long = await pieces.create({ form:'长文', title:topic+'手记', parentNote:short.note })
    const video = await pieces.create({ form:'视频', title:topic+'镜头', parentNote:long.note })
    for (const [item, platforms, account, body] of [
      [short, ['X'], '纸飞机编辑部', text],
      [long, Object.keys(DESK_TO_WECHATSYNC), '纸飞机编辑部', `## 实验记录\n\n${text}\n\n## 复做方法\n\n保持纸张、光线和机位一致。`],
      [video, Object.keys(DESK_TO_MAITIAN), '纸飞机放映室', `## 一镜到底\n\n${text}\n\n## 收尾\n\n拉远机位，展示最后的画面。`],
    ]) {
      await pieces.setPlatforms({ note:item.note, platforms, accounts:[account] })
      const current = await pieces.readPiece(item.note)
      await pieces.saveBody({ note:item.note, mtimeMs:current.mtimeMs, body:`# ${item.note.slice(11)}\n\n${body}\n` })
    }
    const piece = await pieces.readPiece(video.note)
    const media = piece.file.slice(0,-3)+'-assets'
    await mkdir(media)
    await copyFile(asset('hills.jpg'), join(media,'cover.jpg'))
    if (topic === lines[0][0]) {
      for (const [item, platform, views] of [[short,'X',4210],[long,'公众号',1860]]) {
        await pieces.publish({note:item.note,platform,url:'https://example.org/demo/'+encodeURIComponent(platform),date:today.toISOString().slice(0,10)})
        await pieces.setImpressions({note:item.note,platform,impressions:views})
      }
    }
    await copyFile(asset('v-tide.mp4'), join(media,'成片.mp4'))
  }
  return lines.length
}

// Refuse existing directories, including symlinks. No merge, deletion or access to a previous workspace.
export async function initDemo(home, { publishing = false } = {}) {
  await mkdir(home, { mode: 0o700 })
  return seedNewHome(home, publishing)
}

// Claim only the default public home. Never add samples to an existing or custom workspace.
export async function initializeDefaultGallery(env = process.env) {
  if (env.MEDIA_DESK_HOME || env.MEDIA_DESK_INTEGRATIONS === '1') return
  const home = dshHome(env)
  try { await mkdir(home, { mode: 0o700 }) }
  catch (err) { if (err.code === 'EEXIST') return; throw err }
  await seedNewHome(home, false)
}

async function seedNewHome(home, publishing) {
  const root = join(home, 'media-desk')
  const store = new Store(root)
  await store.read()
  const settings = new Settings(root)
  const { vaultRoot } = await settings.update({ language:'zh', fontScale:1.15 })
  const put = async (rel, text) => {
    const file = join(vaultRoot, rel)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, { flag: 'wx' })
    return file
  }
  for (const rel of [...Object.values(PATHS), ...Object.values(STATUS_DIRS).flatMap(Object.values)]) await mkdir(join(vaultRoot, rel), { recursive: true })
  await put(join(PATHS.favorites, date, '纸翼观察.md'), `---\nauthor: 纸飞机编辑部\nsource: 原创演示\nsaved: ${date}\n---\n\n# 纸翼观察\n\n平放纸飞机，检查左右机翼的折角是否一致。\n`)
  const { groups } = await demoFile('matrix')
  const rows = []
  const ownPosts = []
  const today = new Date()
  today.setUTCHours(0,0,0,0)
  const subjects = ['机翼的折角','窗边光线','纸张的重量','低机位试拍','镜头里的影子','调整重心','试飞记录','纸翼配色','投掷角度','午后延时','逆光剪影','风向笔记']
  for (const group of groups) for (const platform of group.platforms) {
    const i = rows.length
    const slot = String(i + 1).padStart(2,'0')
    const key = 'own-' + (i + 1).toString(16).padStart(6,'0')
    rows.push([slot, platform, group.zh, '', '虚构演示', '', key])
    for (let week = 0; week < 12; week++) {
      const entries = (i + 3 * week + Math.floor(week / 2)) % 4
      for (let j = 0; j < entries; j++) {
        const days = week * 7 + (i + j * 2) % 7
        ownPosts.push({accountId:key,id:`sample-${slot}-${days}`,title:subjects[(i + days) % subjects.length]+' · '+(week + 1),publishedAt:new Date(+today - days * 86400000).toISOString(),likes:12 + (i * 31 + days * 13) % 307,comments:1 + (i + days) % 19,saves:(i * 5 + days) % 37,sample:true})
      }
    }
  }
  await mkdir(join(root,'own'))
  await writeFile(join(root,'own','posts.jsonl'), ownPosts.map(p=>JSON.stringify(p)).join('\n')+'\n', {flag:'wx'})
  const catalog = await demoFile('bench-snapshot')
  await mkdir(join(root,'bench'))
  await writeFile(join(root,'bench','media-index.json'), JSON.stringify(catalog), {flag:'wx'})
  await put(OWN_SOURCE, [OWN_COLUMNS, OWN_COLUMNS.map(()=>'---'), ...rows].map(row => `| ${row.join(' | ')} |`).join('\n')+'\n')
  const seedBoard = publishing ? seedPublishingBoard : seedContentBoard
  const lineCount = await seedBoard(settings, root, put, today)
  await put(join(PATHS.pending, `${date}-光线观察.md`), `日期: ${date}\n\n# 光线观察\n\n试着在两个时刻记录同一座纸山的影子。\n`)
  await put(join(PATHS.pending, `${date}-废弃草图.md`), `日期: ${date}\n\n# 废弃草图\n\n用于演示移入回收站。\n`)
  await writeFile(join(home,'DEMO.json'), JSON.stringify({schema:3, profile:publishing ? 'publishing' : 'content', accounts:rows.length, lines:lineCount})+'\n',{ flag:'wx' })
  return {home,root,vaultRoot}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const paths = args.filter(arg => arg !== '--publishing')
  if (paths.length > 1 || paths.some(path => path.startsWith('-'))) throw new Error('用法：init-demo.mjs [新目录] [--publishing]')
  const result = await initDemo(resolve(paths[0] || process.env.MEDIA_DESK_HOME || '.demo'), { publishing:args.includes('--publishing') })
  console.log(`演示数据已生成：${result.home}`)
}
