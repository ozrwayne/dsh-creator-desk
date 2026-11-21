import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import plugin from '../src/host.js'
import { ORIGIN_DIR, Pieces, STATUS_DIRS } from '../src/pieces.js'
import { BundleService, parseVideoSections } from '../src/publish-bundle.js'
import { checkMp4Faststart, validateBundle, xWeight } from '../src/publish-check.js'
import { beijingPreview, localScheduleToIso, PublishStore } from '../src/publish-map.js'
import { publicSettings, Settings } from '../src/settings.js'

const NOW_MS = Date.parse('2026-11-18T10:00:00+09:00')

function makeMp4Boxes(order = ['ftyp', 'moov', 'mdat'], { bigBox = false } = {}) {
  const chunks = []
  for (const type of order) {
    const payload = Buffer.alloc(16, 0x11)
    if (bigBox && type === 'mdat') {
      const header = Buffer.alloc(16)
      header.writeUInt32BE(1, 0)
      header.write(type, 4, 4, 'latin1')
      header.writeBigUInt64BE(BigInt(16 + payload.length), 8)
      chunks.push(header, payload)
    } else {
      const header = Buffer.alloc(8)
      header.writeUInt32BE(8 + payload.length, 0)
      header.write(type, 4, 4, 'latin1')
      chunks.push(header, payload)
    }
  }
  return Buffer.concat(chunks)
}

async function setupEnv() {
  const root = await mkdtemp(join(tmpdir(), 'media-desk-pub-'))
  const vault = join(root, 'vault')
  const dataDir = join(root, 'media-desk')
  const bundleDir = join(root, 'bundles')
  await mkdir(join(vault, ORIGIN_DIR), { recursive: true })
  for (const form of Object.values(STATUS_DIRS)) {
    for (const rel of Object.values(form)) await mkdir(join(vault, rel), { recursive: true })
  }
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(vault, ORIGIN_DIR, '2026-11-18-原点.md'), '日期: 2026-11-18\n\n# 原点\n\n内容。\n')
  const settings = new Settings(dataDir)
  await settings.update({
    exportDir: join(root, 'exports'),
    publish: {
      bundleDir,
      requiredTags: ['纸飞机'],
      bannedWords: ['绝对第一'],
      wechatsyncEnabled: false,
    },
  })
  // 注入测试 vaultRoot（Settings.update 不对外开放 vaultRoot）
  const raw = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'))
  raw.vaultRoot = vault
  raw.wechatStyles = join(root, 'missing-styles.md')
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify(raw, null, 2))
  return { root, vault, dataDir, bundleDir, settings }
}

test('排期本地时区换算与北京时间预览：支持跨日与非法日期拦截', () => {
  // 东九区 UTC+09:00 (+540 分钟)
  const iso = localScheduleToIso('2026-11-20 20:30', 540)
  assert.equal(iso, '2026-11-20T20:30:00+09:00')
  assert.equal(beijingPreview('2026-11-20 20:30', 540), '19:30')
  // 东九区凌晨 00:30 = 前一天 23:30 北京时间
  assert.equal(beijingPreview('2026-11-20 00:30', 540), '11-19 23:30')
  // 非法日期（2月30日）被拒
  assert.equal(localScheduleToIso('2026-02-30 12:00'), null)
})

test('PublishStore 并发写入串行化，且 publicSettings 隐藏连接口令明文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'md-pubstore-'))
  try {
    const store = new PublishStore(dir)
    await Promise.all([
      store.saveBundle('note-a', { dir: '/tmp/a' }),
      store.saveBundle('note-b', { dir: '/tmp/b' }),
      store.saveSyncRecords('note-a', { weixin: { status: 'draft', postUrl: 'https://mp.weixin.qq.com/1' } }),
      store.saveSyncRecords('note-a', { zhihu: { status: 'draft', postUrl: 'https://zhuanlan.zhihu.com/p/2' } }),
    ])
    assert.equal((await store.getBundle('note-a')).dir, '/tmp/a')
    assert.equal((await store.getBundle('note-b')).dir, '/tmp/b')
    const sync = await store.getSyncRecords('note-a')
    assert.equal(sync.weixin.status, 'draft')
    assert.equal(sync.zhihu.status, 'draft')

    const settings = new Settings(dir)
    const updated = await settings.update({
      publish: { wechatsyncToken: 'mdsync_1234567890abcdef', wechatsyncPort: 9600 },
    })
    const pub = publicSettings(updated, false)
    assert.equal(pub.publish.hasToken, true)
    assert.equal(pub.publish.tokenHint, 'cdef')
    assert.equal('wechatsyncToken' in pub.publish, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('validateBundle 与 checkMp4Faststart：覆盖平台规则、模型名降级提醒与 64 位 box 头扫描', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'md-mp4-'))
  try {
    const goodMp4 = join(dir, 'good.mp4')
    const slowMp4 = join(dir, 'slow.mp4')
    await writeFile(goodMp4, makeMp4Boxes(['ftyp', 'moov', 'mdat'], { bigBox: true }))
    await writeFile(slowMp4, makeMp4Boxes(['ftyp', 'mdat', 'moov']))

    assert.deepEqual(await checkMp4Faststart(goodMp4), { ok: true })
    const slow = await checkMp4Faststart(slowMp4)
    assert.equal(slow.ok, false)
    assert.match(slow.reason, /faststart/)
    const missing = await checkMp4Faststart(join(dir, 'none.mp4'))
    assert.equal(missing.ok, false)
    assert.equal(missing.missing, true)

    assert.equal(xWeight('中文 https://example.com/abc'), 4 + 1 + 23)

    const files = new Set(['成片.mp4', '封面/cover-3x4.jpg'])
    const res = validateBundle({
      version: 1,
      video: '成片.mp4',
      requiredTags: ['纸飞机'],
      schedule: new Date(NOW_MS + 3 * 3600_000).toISOString(),
      covers: { '3x4': '封面/cover-3x4.jpg' },
      platforms: {
        xhs: {
          covers: ['3x4'],
          title: '用 DeepSeek 提效的一天',
          body: '今天实测一套新工作流',
          topics: ['纸飞机', '效率'],
        },
        channels: {
          covers: ['3x4'],
          shortTitle: '太短',
          body: '加微 abcdef123 领取，绝对第一',
          topics: ['效率'],
        },
      },
    }, { files, now: NOW_MS, bannedWords: ['绝对第一'] })

    // 小红书出现 DeepSeek 只给 warning，不进 errors
    assert.equal(res.errors.some(e => e.includes('小红书')), false)
    assert.equal(res.warnings.some(w => w.includes('DeepSeek')), true)
    // 视频号短标题过短、微信号、缺少必带标签、命中自定义禁词都进 errors
    assert.equal(res.errors.some(e => e.includes('视频号') && e.includes('shortTitle')), true)
    assert.equal(res.errors.some(e => e.includes('微信号')), true)
    assert.equal(res.errors.some(e => e.includes('缺少必带标签「纸飞机」')), true)
    assert.equal(res.errors.some(e => e.includes('自定义禁词「绝对第一」')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('BundleService 全链路：准备发布包、排期对齐、AI 生成文案、禁软链成片归位、回填链接与视频号兜底', async () => {
  const { root, vault, dataDir, settings } = await setupEnv()
  try {
    const pieces = new Pieces(settings, { dataDir, now: () => new Date(NOW_MS) })
    const publishStore = new PublishStore(dataDir)
    const shortPiece = await pieces.create({ form: '短推', title: '原点短推', originNote: '2026-11-18-原点' })
    const longPiece = await pieces.create({ form: '长文', title: '长文节点', parentNote: shortPiece.note })
    const videoPiece = await pieces.create({
      form: '视频',
      title: '为什么多平台分发要靠结构化包',
      parentNote: longPiece.note,
    })
    await pieces.setPlatforms({
      note: videoPiece.note,
      accounts: ['B站-纸飞机', '视频号-纸飞机'],
      platforms: ['B站', '小红书', '视频号', 'Instagram'],
    })
    // 在 B 站设一个 +4 小时的排期：2026-11-18 14:00 (+09:00)
    await pieces.setSchedule({ note: videoPiece.note, platform: 'B站', at: '2026-11-18 14:00' })

    const current = await pieces.readPiece(videoPiece.note)
    const scriptBody = [
      '# 为什么多平台分发要靠结构化包',
      '',
      '这里是视频口播主干内容。',
      '',
      '## 小红书',
      '**标题：** 多平台发视频不再手忙脚乱',
      '**正文：** 把封面和文案一次准备好。',
      '**话题：** #效率工具 #自媒体',
    ].join('\n')
    await pieces.saveBody({ note: videoPiece.note, body: scriptBody, mtimeMs: current.mtimeMs })

    // 放入源封面
    const assetsDir = `${current.file.slice(0, -3)}-assets`
    await mkdir(assetsDir, { recursive: true })
    await writeFile(join(assetsDir, 'cover.png'), Buffer.from('fake-image-bytes'))

    const parsedSecs = parseVideoSections(scriptBody)
    assert.equal(parsedSecs.xhs.fields.标题, '多平台发视频不再手忙脚乱')

    const svc = new BundleService({
      settings,
      pieces: () => pieces,
      publishStore,
      now: () => NOW_MS,
      fixedOffsetMinutes: 540,
      callText: async () => ({
        text: JSON.stringify({
          bilibili: { title: 'AI生成的B站标题', desc: 'B站简介', tags: ['测试'] },
          xhs: { title: '小红书短标题不超过二十字', body: '干净正文 https://strip.me', topics: ['小红书话题'] },
          douyin: { title: '抖音标题', body: '抖音正文', topics: ['话题A'] },
          channels: { shortTitle: '视频号六到十六字标题', body: '视频号描述', topics: ['视频号'] },
          youtube: { title: 'YouTube <Title>', desc: 'Desc <ok>', tags: ['yt'] },
          x: { text: 'X post copy' },
          instagram: { caption: 'IG caption #reels' },
        }),
      }),
    })

    const prepared = await svc.prepare({ note: videoPiece.note })
    assert.equal(prepared.prepared, true)
    assert.equal(prepared.videoReady, false)
    assert.equal(prepared.bundle.schedule, '2026-11-18T14:00:00+09:00')
    assert.equal(prepared.beijingSchedule, '13:00')
    assert.equal(prepared.bundle.platforms.xhs.title, '多平台发视频不再手忙脚乱')
    assert.equal(prepared.bundle.platforms.xhs.topics.includes('纸飞机'), true)
    assert.equal(Boolean(prepared.bundle.platforms.youtube.skip), true)

    // 勾选的其它视频平台排期也被对齐到了 2026-11-18 14:00
    const afterAlign = await pieces.readPiece(videoPiece.note)
    assert.equal(afterAlign.schedules.find(s => s.platform === '小红书')?.at, '2026-11-18 14:00')
    assert.equal(afterAlign.schedules.find(s => s.platform === 'Instagram')?.at, '2026-11-18 14:00')

    // AI 生成 7 平台文案：自动剥除小红书外链和 YouTube 尖括号，并保留必带标签
    const aiRes = await svc.generateCopy({}, { note: videoPiece.note })
    assert.equal(aiRes.bundle.platforms.bilibili.title, 'AI生成的B站标题')
    assert.equal(aiRes.bundle.platforms.xhs.body.includes('https://'), false)
    assert.equal(aiRes.bundle.platforms.youtube.title.includes('<'), false)
    assert.equal(aiRes.bundle.platforms.bilibili.tags.includes('纸飞机'), true)

    // 软链接成片被拒绝
    const realMp4 = join(root, 'raw-video.mp4')
    const linkMp4 = join(root, 'symlink-video.mp4')
    await writeFile(realMp4, makeMp4Boxes(['ftyp', 'moov', 'mdat']))
    await symlink(realMp4, linkMp4)
    await assert.rejects(() => svc.placeVideo({ note: videoPiece.note, sourcePath: linkMp4 }), /软链接/)

    // 正常成片归位通过校验
    const placed = await svc.placeVideo({ note: videoPiece.note, sourcePath: realMp4 })
    assert.equal(placed.videoReady, true)
    assert.equal(placed.faststart.ok, true)
    assert.deepEqual(placed.validation.errors, [])
    assert.equal(placed.readyToFill, true)

    // 写入麦田 发布记录.json：B站有链接、视频号已上线无单条链接（触发后台列表页兜底）、小红书定时、抖音失败
    await writeFile(join(placed.dir, '发布记录.json'), JSON.stringify({
      updatedAt: '2026-11-18T02:00:00Z',
      platforms: {
        bilibili: { status: '已发布', url: 'https://www.bilibili.com/video/BV1xx411c7mD', time: '2026-11-18T12:00:00+08:00' },
        channels: { status: '已上线', url: '', note: '视频号无单条固定链接' },
        xhs: { status: '定时', time: '2026-11-18T18:00:00+08:00' },
        douyin: { status: '出错', note: '上传超时' },
      },
    }))

    const backfilled = await svc.backfill({ note: videoPiece.note })
    assert.equal(backfilled.applied.length, 2)
    assert.equal(backfilled.pending.length, 1)
    assert.equal(backfilled.failed.length, 1)
    assert.equal(backfilled.piece.status, '已发布')
    assert.equal(backfilled.piece.distributions.find(d => d.platform === 'B站')?.url, 'https://www.bilibili.com/video/BV1xx411c7mD')
    assert.equal(backfilled.piece.distributions.find(d => d.platform === '视频号')?.url, 'https://channels.weixin.qq.com/platform/post/list')
    assert.equal(backfilled.piece.distributions.some(d => d.platform === '小红书'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Host 路由：/media-desk/publish/x-heading 补齐长文标题并拦截跨站写请求', async () => {
  const { root, dataDir, settings } = await setupEnv()
  const prevHome = process.env.MEDIA_DESK_HOME
  process.env.MEDIA_DESK_HOME = root
  const cleanups = []
  try {
    const pieces = new Pieces(settings, { dataDir, now: () => new Date(NOW_MS) })
    const shortPiece = await pieces.create({ form: '短推', title: '短句', originNote: '2026-11-18-原点' })
    const longPiece = await pieces.create({ form: '长文', title: 'X长文测试标题', parentNote: shortPiece.note })
    const read0 = await pieces.readPiece(longPiece.note)
    await pieces.saveBody({ note: longPiece.note, body: '\n直接写正文，没有一级标题。\n', mtimeMs: read0.mtimeMs })

    let handler
    plugin.apply({
      get: name => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
      effect: (fn) => {
        const off = fn()
        if (typeof off === 'function') cleanups.push(off)
      },
      webServer: { register: opts => { handler = opts.handler } },
    })

    const call = (method, route, body, extraHeaders = {}) => new Promise((resolve) => {
      const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
      const req = {
        method,
        url: `/media-desk/${route}`,
        headers: { ...extraHeaders },
        async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
      }
      const res = {
        statusCode: 0,
        headersSent: false,
        setHeader() {},
        end: raw => resolve({ status: res.statusCode, data: JSON.parse(String(raw || '{}')) }),
      }
      handler(req, res)
    })

    const st0 = await call('GET', `publish/status?note=${encodeURIComponent(longPiece.note)}`)
    assert.equal(st0.status, 200)
    assert.equal(st0.data.xArticle.hasH1, false)

    // 跨站请求被 403 拦截
    const csrf = await call('POST', 'publish/x-heading', { note: longPiece.note }, { 'sec-fetch-site': 'cross-site' })
    assert.equal(csrf.status, 403)

    const fixed = await call('POST', 'publish/x-heading', { note: longPiece.note })
    assert.equal(fixed.status, 200)
    assert.equal(fixed.data.updated, true)
    assert.match(fixed.data.piece.body, /^# X长文测试标题/m)

    const again = await call('POST', 'publish/x-heading', { note: longPiece.note })
    assert.equal(again.data.updated, false)
  } finally {
    for (const fn of cleanups) fn()
    if (prevHome === undefined) delete process.env.MEDIA_DESK_HOME
    else process.env.MEDIA_DESK_HOME = prevHome
    await rm(root, { recursive: true, force: true })
  }
})

test('跨电脑 ZIP 导出与远程记录回填：bundle.zip、maitian-extension.zip 通过 unzip 校验，上传记录直接回填', async () => {
  const { root, dataDir, settings } = await setupEnv()
  try {
    const pieces = new Pieces(settings, { dataDir, now: () => new Date(NOW_MS) })
    const publishStore = new PublishStore(dataDir)
    const s = await pieces.create({ form: '短推', title: '原点短推', originNote: '2026-11-18-原点' })
    const l = await pieces.create({ form: '长文', title: '长文', parentNote: s.note })
    const v = await pieces.create({ form: '视频', title: '跨电脑视频导出测试', parentNote: l.note })
    await pieces.setPlatforms({ note: v.note, accounts: ['YouTube-Editor'], platforms: ['YouTube'] })

    const current = await pieces.readPiece(v.note)
    const assetsDir = `${current.file.slice(0, -3)}-assets`
    await mkdir(assetsDir, { recursive: true })
    await writeFile(join(assetsDir, 'cover.png'), Buffer.from('fake-cover-data'))

    const svc = new BundleService({ settings, pieces: () => pieces, publishStore, now: () => NOW_MS })
    await svc.prepare({ note: v.note })

    const mp4Path = join(root, 'source.mp4')
    await writeFile(mp4Path, makeMp4Boxes(['ftyp', 'moov', 'mdat']))
    await svc.placeVideo({ note: v.note, sourcePath: mp4Path })

    // 1. 导出发布包 ZIP（含中文文件名和封面，不含大体积 mp4）并用系统 unzip 校验完整性
    const bundleZip = await svc.exportBundleZip({ note: v.note })
    const bundleZipPath = join(root, bundleZip.filename)
    await writeFile(bundleZipPath, bundleZip.buffer)
    const { stdout: testOut } = await execFileAsync('/usr/bin/unzip', ['-t', bundleZipPath])
    assert.match(testOut, /No errors detected/i)
    const { stdout: listOut } = await execFileAsync('/usr/bin/unzip', ['-l', bundleZipPath])
    assert.match(listOut, /publish\.json/)
    assert.match(listOut, /cover-16x9\.jpg/)
    assert.equal(listOut.includes('成片.mp4'), false)

    // 2. 成片流式文件路径获取正常
    const vf = await svc.videoFileFor({ note: v.note })
    assert.match(vf.filename, /成片\.mp4$/)

    // 3. 导出麦田 Chrome 扩展安装包并通过 unzip 校验（不含 tools/ 和 tests/）
    const extZip = await svc.exportMaitianZip()
    const extZipPath = join(root, extZip.filename)
    await writeFile(extZipPath, extZip.buffer)
    const { stdout: extTest } = await execFileAsync('/usr/bin/unzip', ['-t', extZipPath])
    assert.match(extTest, /No errors detected/i)
    const { stdout: extList } = await execFileAsync('/usr/bin/unzip', ['-l', extZipPath])
    assert.match(extList, /maitian-publisher\/manifest\.json/)
    assert.match(extList, /maitian-publisher\/lib\/devbridge\.js/)
    assert.equal(extList.includes('tools/'), false)

    // 4. 从远程浏览器直接上传 发布记录.json 对象回填，落盘并更新正式分发
    const remoteBackfill = await svc.backfill({
      note: v.note,
      record: {
        updatedAt: '2026-11-18T12:00:00Z',
        platforms: {
          youtube: { status: '已发布', url: 'https://youtu.be/dQw4w9WgXcQ', time: '2026-11-18T12:00:00Z' },
        },
      },
    })
    assert.equal(remoteBackfill.applied.length, 1)
    assert.equal(remoteBackfill.piece.status, '已发布')
    assert.equal(remoteBackfill.piece.distributions[0].url, 'https://youtu.be/dQw4w9WgXcQ')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
