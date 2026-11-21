import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ORIGIN_DIR, Pieces, STATUS_DIRS } from '../src/pieces.js'
import { PublishStore } from '../src/publish-map.js'
import { Settings } from '../src/settings.js'
import { checkWechatHtml, loadStyles, prepareSyncArticle, toWechatHtml } from '../src/wechat.js'
import { isAllowedWsSourceIp, isTailscaleIp, WechatsyncService } from '../src/wechatsync.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 9599
      srv.close(err => (err ? reject(err) : resolve(port)))
    })
    srv.on('error', () => resolve(9599))
  })
}

function createSocketPair() {
  const clientSide = new EventEmitter()
  const serverSide = new EventEmitter()
  let closed = false
  const closeBoth = () => {
    if (closed) return
    closed = true
    queueMicrotask(() => {
      serverSide.emit('close')
      clientSide.emit('close')
    })
  }
  serverSide.setNoDelay = () => {}
  serverSide.write = (chunk) => {
    if (!closed) queueMicrotask(() => clientSide.emit('data', Buffer.from(chunk)))
    return true
  }
  serverSide.end = (chunk) => {
    if (chunk) serverSide.write(chunk)
    closeBoth()
  }
  serverSide.destroy = closeBoth

  clientSide.write = (chunk) => {
    if (!closed) queueMicrotask(() => serverSide.emit('data', Buffer.from(chunk)))
    return true
  }
  clientSide.destroy = closeBoth
  return { clientSide, serverSide }
}

function maskClientTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3]
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

function upgradeFakeWs(server, origin, onJson, remoteAddress = '127.0.0.1') {
  return new Promise((resolve) => {
    const { clientSide, serverSide } = createSocketPair()
    serverSide.remoteAddress = remoteAddress
    const key = randomBytes(16).toString('base64')
    const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64')
    let upgraded = false
    let buf = Buffer.alloc(0)

    clientSide.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!upgraded) {
        const headerEnd = buf.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        const headText = buf.subarray(0, headerEnd).toString('utf8')
        buf = buf.subarray(headerEnd + 4)
        const statusLine = headText.split('\r\n')[0]
        if (!statusLine.includes('101')) {
          clientSide.destroy()
          resolve({ ok: false, statusLine })
          return
        }
        assert.match(headText, new RegExp(`Sec-WebSocket-Accept: ${expectedAccept.replace(/[+/=]/g, '\\$&')}`, 'i'))
        upgraded = true
        resolve({
          ok: true,
          send(obj) {
            clientSide.write(maskClientTextFrame(JSON.stringify(obj)))
          },
          close() {
            clientSide.destroy()
          },
        })
      }

      while (upgraded && buf.length >= 2) {
        const opcode = buf[0] & 0x0f
        let len = buf[1] & 0x7f
        let offset = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          offset = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          offset = 10
        }
        if (buf.length < offset + len) return
        const payload = buf.subarray(offset, offset + len)
        buf = buf.subarray(offset + len)
        if (opcode === 0x1) {
          onJson?.(JSON.parse(payload.toString('utf8')))
        }
      }
    })

    server.emit('upgrade', {
      socket: { remoteAddress },
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': key,
        origin,
      },
    }, serverSide)
  })
}

test('prepareSyncArticle：内嵌库内图片为 data URI、保留外链、拒绝软链接越界，且不影响原粘贴模式', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-sync-art-'))
  try {
    const vault = join(root, 'vault')
    const outsideSecret = join(root, 'secret.png')
    await mkdir(join(vault, '素材'), { recursive: true })
    await writeFile(outsideSecret, Buffer.from('SECRET_OUTSIDE_BYTES'))
    await writeFile(join(vault, '素材', 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await symlink(outsideSecret, join(vault, '素材', 'escape.png'))

    const pieceDir = join(vault, STATUS_DIRS.长文.进行中)
    await mkdir(pieceDir, { recursive: true })
    const pieceFile = join(pieceDir, '2026-11-18-测试长文.md')
    const assetsDir = `${pieceFile.slice(0, -3)}-assets`
    await mkdir(assetsDir, { recursive: true })
    await writeFile(join(assetsDir, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))

    const markdown = [
      '# 深度长文标题',
      '',
      '第一段带[参考链接](https://example.com/ref)。',
      '',
      '![[素材/chart.png|趋势图]]',
      '',
      '![越界图](素材/escape.png)',
    ].join('\n')

    const style = (await loadStyles(join(root, 'no-styles.md')))[0]

    // 原有粘贴模式保持不变：无外部 URL，图片仍是占位文字
    const pasteHtml = toWechatHtml(markdown, style)
    assert.equal(checkWechatHtml(pasteHtml).join('\n'), '')
    assert.match(pasteHtml, /\[图片：趋势图\]/)

    // Wechatsync 同步模式：内嵌合法图片，拦截软链越界图片并记录 warning
    const article = await prepareSyncArticle(
      { note: '2026-11-18-测试长文', title: '兜底标题', file: pieceFile, body: markdown },
      style,
      { vaultRoot: vault },
    )
    assert.equal(article.title, '深度长文标题')
    assert.match(article.cover, /^data:image\/jpeg;base64,/)
    assert.match(article.content, /<img src="data:image\/png;base64,[^"]+" alt="趋势图"/)
    assert.match(article.content, /<a href="https:\/\/example\.com\/ref"/)
    assert.equal(article.content.includes(Buffer.from('SECRET_OUTSIDE_BYTES').toString('base64')), false)
    assert.equal(article.warnings.some(w => w.includes('escape.png')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WechatsyncService：Origin 校验、扩展 ID 首次锁定与重置、仅发内联 HTML、5 分钟防重与草稿隔离', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-wxsync-svc-'))
  let svc = null
  const clients = []
  try {
    const vault = join(root, 'vault')
    const dataDir = join(root, 'media-desk')
    await mkdir(join(vault, ORIGIN_DIR), { recursive: true })
    for (const form of Object.values(STATUS_DIRS)) {
      for (const rel of Object.values(form)) await mkdir(join(vault, rel), { recursive: true })
    }
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(vault, ORIGIN_DIR, '2026-11-18-原点.md'), '日期: 2026-11-18\n\n# 原点\n\n内容。\n')

    const port = await getFreePort()
    const settings = new Settings(dataDir)
    await settings.update({
      publish: { wechatsyncEnabled: true, wechatsyncPort: port },
    })
    const raw = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'))
    raw.vaultRoot = vault
    raw.wechatStyles = join(root, 'missing-styles.md')
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify(raw, null, 2))

    const pieces = new Pieces(settings, { dataDir })
    const shortPiece = await pieces.create({ form: '短推', title: '短句', originNote: '2026-11-18-原点' })
    const longPiece = await pieces.create({ form: '长文', title: '同步测试长文', parentNote: shortPiece.note })
    const read0 = await pieces.readPiece(longPiece.note)
    await pieces.saveBody({ note: longPiece.note, body: '\n# 同步测试长文\n\n这里是**加粗**正文。\n', mtimeMs: read0.mtimeMs })

    let currentMs = Date.parse('2026-11-18T12:00:00Z')
    const publishStore = new PublishStore(dataDir)
    svc = new WechatsyncService({
      settings,
      pieces: () => pieces,
      publishStore,
      now: () => currentMs,
    })

    const { token } = await svc.generateToken()
    assert.match(token, /^mdsync_/)
    assert.ok(svc.server)

    // 1. 网页恶意 Origin 被 403 拒绝握手
    const evil = await upgradeFakeWs(svc.server, 'https://evil.example.com')
    assert.equal(evil.ok, false)
    assert.match(evil.statusLine, /403/)

    // 2. 合法 Chrome 扩展连接，响应 listPlatforms 与 syncArticle
    const extOriginA = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
    const receivedCalls = []
    let clientA
    clientA = await upgradeFakeWs(svc.server, extOriginA, (msg) => {
      receivedCalls.push(msg)
      assert.equal(msg.token, token)
      if (msg.method === 'listPlatforms') {
        clientA.send({
          id: msg.id,
          result: [
            { id: 'weixin', name: '微信公众号', isAuthenticated: true, username: '纸飞机' },
            { id: 'zhihu', name: '知乎', isAuthenticated: true, username: 'Editor' },
          ],
        })
      } else if (msg.method === 'syncArticle') {
        clientA.send({
          id: msg.id,
          result: {
            results: msg.params.platforms.map(pid => ({
              platform: pid,
              success: true,
              draftOnly: true,
              postUrl: `https://draft.example.com/${pid}/123`,
            })),
          },
        })
      }
    })
    assert.equal(clientA.ok, true)
    clients.push(clientA)

    const st = await svc.status({ refreshPlatforms: true })
    assert.equal(st.connected, true)
    assert.equal(st.platforms.length, 2)
    // 首次鉴权调用后自动锁定了扩展 ID
    const afterLock = await settings.read()
    assert.equal(afterLock.publish.wechatsyncLockedExtId, 'abcdefghijklmnopabcdefghijklmnop')

    // 3. 另一个未授权扩展 ID 连接被 403 拒绝
    const rogue = await upgradeFakeWs(svc.server, 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')
    assert.equal(rogue.ok, false)
    assert.match(rogue.statusLine, /403/)

    // 4. 发起同步草稿：验证只传内联 HTML content，绝不传 markdown；草稿记录不污染正式 分发
    const started = await svc.startSync({
      note: longPiece.note,
      platforms: ['公众号', '知乎'],
      styleId: 'minimal',
    })
    assert.ok(started.job)

    // 等待异步同步完成
    for (let i = 0; i < 30 && svc.job(started.job.id).status === 'running'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    const doneJob = svc.job(started.job.id)
    assert.equal(doneJob.status, 'done')
    assert.equal(doneJob.results.length, 2)

    const syncCall = receivedCalls.find(c => c.method === 'syncArticle')
    assert.ok(syncCall)
    assert.equal(syncCall.params.article.title, '同步测试长文')
    assert.equal('markdown' in syncCall.params.article, false)
    assert.match(syncCall.params.article.content, /<strong style="/)

    // 正式稿件仍为「进行中」且 distributions 为空（草稿绝不冒充已发布）
    const pieceAfter = await pieces.readPiece(longPiece.note)
    assert.equal(pieceAfter.status, '进行中')
    assert.deepEqual(pieceAfter.distributions, [])

    const savedRecords = await svc.records(longPiece.note)
    assert.equal(savedRecords.records.weixin.postUrl, 'https://draft.example.com/weixin/123')

    // 5. 5 分钟内重复同步同一平台触发防重提醒；force=true 放行
    currentMs += 60_000
    const dup = await svc.startSync({ note: longPiece.note, platforms: ['公众号'] })
    assert.equal(dup.duplicateWarning, true)
    assert.deepEqual(dup.recentPlatforms, ['公众号'])

    const forced = await svc.startSync({ note: longPiece.note, platforms: ['公众号'], force: true })
    assert.ok(forced.job)
    for (let i = 0; i < 30 && svc.job(forced.job.id).status === 'running'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    assert.equal(svc.job(forced.job.id).status, 'done')

    // 6. 解除扩展 ID 锁定后清空配置
    await svc.resetExtensionLock()
    assert.equal((await settings.read()).publish.wechatsyncLockedExtId, '')
  } finally {
    for (const c of clients) c.close()
    await svc?.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('多电脑 Tailscale 协同：拦截局域网 Wi-Fi IP，本机与远程电脑同时在线不互踢且按当前设备路由', async () => {
  const peerIp = '100.64.0.1' // synthetic CGNAT range boundary
  const lanIp = '192.168.0.1'
  assert.equal(isTailscaleIp(peerIp), true)
  assert.equal(isTailscaleIp('100.127.255.255'), true)
  assert.equal(isTailscaleIp('100.63.255.255'), false)
  assert.equal(isTailscaleIp(lanIp), false)
  assert.equal(isAllowedWsSourceIp(lanIp, { allowTailscale: true }), false)
  assert.equal(isAllowedWsSourceIp(peerIp, { allowTailscale: true }), true)
  assert.equal(isAllowedWsSourceIp(peerIp, { allowTailscale: false }), false)

  const root = await mkdtemp(join(tmpdir(), 'md-wxsync-multi-'))
  let svc = null
  const clients = []
  try {
    const vault = join(root, 'vault')
    const dataDir = join(root, 'media-desk')
    await mkdir(join(vault, ORIGIN_DIR), { recursive: true })
    for (const form of Object.values(STATUS_DIRS)) {
      for (const rel of Object.values(form)) await mkdir(join(vault, rel), { recursive: true })
    }
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(vault, ORIGIN_DIR, '2026-11-18-原点.md'), '日期: 2026-11-18\n\n# 原点\n\n内容。\n')

    const port = await getFreePort()
    const settings = new Settings(dataDir)
    await settings.update({
      publish: { wechatsyncEnabled: true, wechatsyncAllowTailscale: true, wechatsyncPort: port },
    })
    const raw = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'))
    raw.vaultRoot = vault
    raw.wechatStyles = join(root, 'missing-styles.md')
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify(raw, null, 2))

    const pieces = new Pieces(settings, { dataDir })
    const shortPiece = await pieces.create({ form: '短推', title: '短句', originNote: '2026-11-18-原点' })
    const longPiece = await pieces.create({ form: '长文', title: '多电脑测试', parentNote: shortPiece.note })

    const publishStore = new PublishStore(dataDir)
    svc = new WechatsyncService({
      settings,
      pieces: () => pieces,
      publishStore,
      tailscaleIps: ['127.0.0.1'], // 测试中避免绑不存在的网卡，单独测试 IP 路由规则
    })
    await svc.generateToken()

    const extOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

    // 普通局域网来源被拒绝
    const lanAttempt = await upgradeFakeWs(svc.server, extOrigin, null, lanIp)
    assert.equal(lanAttempt.ok, false)
    assert.match(lanAttempt.statusLine, /403/)

    // 两台客户端同时连接，按来源路由
    const hits = { local: 0, remote: 0 }
    let localWs, remoteWs
    localWs = await upgradeFakeWs(svc.server, extOrigin, (msg) => {
      if (msg.method === 'listPlatforms') {
        localWs.send({ id: msg.id, result: [{ id: 'weixin', name: '公众号', isAuthenticated: true, username: '本机端' }] })
      } else if (msg.method === 'syncArticle') {
        hits.local += 1
        localWs.send({ id: msg.id, result: { results: [{ platform: 'weixin', success: true, postUrl: 'https://mp.weixin.qq.com/local' }] } })
      }
    }, '127.0.0.1')
    remoteWs = await upgradeFakeWs(svc.server, extOrigin, (msg) => {
      if (msg.method === 'listPlatforms') {
        remoteWs.send({ id: msg.id, result: [{ id: 'weixin', name: '公众号', isAuthenticated: true, username: '远程端' }] })
      } else if (msg.method === 'syncArticle') {
        hits.remote += 1
        remoteWs.send({ id: msg.id, result: { results: [{ platform: 'weixin', success: true, postUrl: 'https://mp.weixin.qq.com/remote' }] } })
      }
    }, peerIp)

    assert.equal(localWs.ok, true)
    assert.equal(remoteWs.ok, true)
    clients.push(localWs, remoteWs)

    // 从远程电脑访问 status，优先拿到远程端 Chrome 的登录状态，且在线设备数为 2
    const stFromRemote = await svc.status({ callerIp: peerIp })
    assert.equal(stFromRemote.clients.length, 2)
    assert.equal(stFromRemote.platforms[0].username, '远程端')

    // 从本机访问 status，优先拿到本机端 Chrome 的登录状态
    const stFromLocal = await svc.status({ callerIp: '127.0.0.1' })
    assert.equal(stFromLocal.platforms[0].username, '本机端')

    // 从远程电脑发起同步，路由到远程电脑 Chrome
    const sync1 = await svc.startSync({ note: longPiece.note, platforms: ['公众号'], callerIp: peerIp, force: true })
    for (let i = 0; i < 30 && svc.job(sync1.job.id).status === 'running'; i += 1) await new Promise(r => setTimeout(r, 20))
    assert.equal(hits.remote, 1)
    assert.equal(hits.local, 0)

    // 从本机发起同步，路由到本机 Chrome
    const sync2 = await svc.startSync({ note: longPiece.note, platforms: ['公众号'], callerIp: '127.0.0.1', force: true })
    for (let i = 0; i < 30 && svc.job(sync2.job.id).status === 'running'; i += 1) await new Promise(r => setTimeout(r, 20))
    assert.equal(hits.local, 1)
  } finally {
    for (const c of clients) c.close()
    await svc?.stop()
    await rm(root, { recursive: true, force: true })
  }
})
