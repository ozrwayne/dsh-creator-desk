// Wechatsync 安全 WebSocket 服务端（B 线，支持本机 + Tailscale 多电脑同时在线）：
// - 仅监听 127.0.0.1 与本机 Tailscale 网卡 IP（100.64.0.0/10），绝不监听 0.0.0.0 或局域网 Wi-Fi
// - 握手校验来源 IP、chrome-extension:// Origin，首次鉴权通过后锁定扩展 ID
// - 支持多台电脑 Chrome 同时保持连接，按当前访问网页的设备 IP 自动路由（也可手动指定设备）
// - 仅开放 listPlatforms / checkAuth / syncArticle 三个出站调用
// - 草稿链接写入 publish/sync.json，不自动写入稿件正式 分发
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { tr } from './i18n.js'
import { DESK_TO_WECHATSYNC, WECHATSYNC_NAMES, WECHATSYNC_TO_DESK } from './publish-map.js'
import { loadStyles, prepareSyncArticle } from './wechat.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const ALLOWED_METHODS = new Set(['listPlatforms', 'checkAuth', 'syncArticle'])
const MAX_WS_PAYLOAD = 30 * 1024 * 1024 // 30 MB，容纳内嵌 data URI 图片
const DUPLICATE_WINDOW_MS = 5 * 60_000

export function normalizeIp(raw) {
  let ip = String(raw || '').trim()
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (ip === '::1') return '127.0.0.1'
  return ip
}

export function isTailscaleIp(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim())
  if (!m) return false
  const [a, b, c, d] = m.slice(1).map(Number)
  if ([a, b, c, d].some(n => n < 0 || n > 255)) return false
  return a === 100 && b >= 64 && b <= 127
}

export function isAllowedWsSourceIp(ip, { allowTailscale = true } = {}) {
  const clean = normalizeIp(ip)
  if (!clean || clean === '127.0.0.1') return true
  return Boolean(allowTailscale && isTailscaleIp(clean))
}

export function detectTailscaleIps(ifaces = networkInterfaces()) {
  const found = new Set()
  for (const list of Object.values(ifaces || {})) {
    for (const info of list || []) {
      if (info && info.family === 'IPv4' && !info.internal && isTailscaleIp(info.address)) {
        found.add(info.address)
      }
    }
  }
  return [...found].sort()
}

function fail(status, message, extra = {}) {
  return Object.assign(new Error(tr(message)), { status, ...extra })
}

function encodeFrame(opcode, payloadBuffer) {
  const len = payloadBuffer.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x80 | opcode
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payloadBuffer])
}

class WsConnection {
  constructor(socket, { clientId, remoteIp, isHostSelf, label, origin, extId, onMessage, onClose }) {
    this.socket = socket
    this.clientId = clientId
    this.remoteIp = remoteIp
    this.isHostSelf = Boolean(isHostSelf)
    this.label = label || remoteIp || 'Chrome'
    this.origin = origin
    this.extId = extId
    this.onMessage = onMessage
    this.onClose = onClose
    this.closed = false
    this.connectedAt = new Date().toISOString()
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentBytes = 0

    socket.on('data', chunk => this._onData(chunk))
    socket.on('close', () => this._finish())
    socket.on('error', () => this._finish())
  }

  _finish() {
    if (this.closed) return
    this.closed = true
    this.onClose?.(this)
  }

  sendText(text) {
    if (this.closed) throw new Error('WebSocket 已断开')
    const data = Buffer.from(text, 'utf8')
    this.socket.write(encodeFrame(0x1, data))
  }

  ping() {
    if (this.closed) return
    this.socket.write(encodeFrame(0x9, Buffer.alloc(0)))
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    this.closed = true
    try {
      const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 120)
      const body = Buffer.alloc(2 + reasonBuf.length)
      body.writeUInt16BE(code, 0)
      reasonBuf.copy(body, 2)
      this.socket.write(encodeFrame(0x8, body))
      this.socket.end()
    } catch {
      this.socket.destroy()
    }
    this.onClose?.(this)
  }

  _onData(chunk) {
    if (this.closed) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk

    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0]
      const b1 = this.buffer[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2

      if (len === 126) {
        if (this.buffer.length < 4) return
        len = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_WS_PAYLOAD)) {
          this.close(1009, 'Payload too large')
          return
        }
        len = Number(big)
        offset = 10
      }

      if (len > MAX_WS_PAYLOAD || this.fragmentBytes + len > MAX_WS_PAYLOAD) {
        this.close(1009, 'Payload too large')
        return
      }

      const maskLen = masked ? 4 : 0
      if (this.buffer.length < offset + maskLen + len) return

      const payload = Buffer.from(this.buffer.subarray(offset + maskLen, offset + maskLen + len))
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4)
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= mask[i & 3]
        }
      }
      this.buffer = this.buffer.subarray(offset + maskLen + len)

      // Control frames
      if (opcode === 0x8) {
        this.close(1000)
        return
      }
      if (opcode === 0x9) {
        if (!this.closed) this.socket.write(encodeFrame(0x0a, payload))
        continue
      }
      if (opcode === 0x0a) {
        continue
      }

      if (opcode === 0x1 || opcode === 0x2) {
        this.fragments = [payload]
        this.fragmentBytes = payload.length
      } else if (opcode === 0x0) {
        this.fragments.push(payload)
        this.fragmentBytes += payload.length
      } else {
        this.close(1003, 'Unsupported opcode')
        return
      }

      if (fin) {
        const full = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments)
        this.fragments = []
        this.fragmentBytes = 0
        this.onMessage?.(full.toString('utf8'))
      }
    }
  }
}

function parseExtensionId(origin) {
  const match = /^chrome-extension:\/\/([a-z0-9]{16,64})\/?$/i.exec(String(origin || '').trim())
  return match ? match[1].toLowerCase() : null
}

export class WechatsyncService {
  constructor({ settings, pieces, publishStore, now = () => Date.now(), allowTestOrigin = false, tailscaleIps = null } = {}) {
    this.settings = settings
    this.pieces = pieces
    this.publishStore = publishStore
    this.now = now
    this.allowTestOrigin = allowTestOrigin
    this.tailscaleIpsOverride = Array.isArray(tailscaleIps) ? tailscaleIps : null

    this.server = null
    this.servers = []
    this.listeningPort = null
    this.listeningHosts = []
    this.listenConfigKey = ''
    this.listenError = null
    this.clients = new Map() // clientId -> WsConnection
    this.pending = new Map() // id -> { resolve, reject, timer, conn }
    this.pingTimer = null
    this.jobs = new Map() // jobId -> job
    this.activeJobId = null
    this._bgTasks = new Set()
  }

  get client() {
    for (let i = this.clients.size - 1; i >= 0; i -= 1) {
      const conn = [...this.clients.values()][i]
      if (conn && !conn.closed) return conn
    }
    return null
  }

  _hostTailscaleIps() {
    if (this.tailscaleIpsOverride) return this.tailscaleIpsOverride
    if (process.env.NODE_TEST_CONTEXT) return []
    return detectTailscaleIps()
  }

  pickClient({ clientId = '', callerIp = '' } = {}) {
    const active = [...this.clients.values()].filter(c => c && !c.closed)
    if (!active.length) return null
    if (clientId) {
      const exact = this.clients.get(clientId)
      if (exact && !exact.closed) return exact
    }
    const cleanCaller = normalizeIp(callerIp)
    if (cleanCaller) {
      const hostTs = this._hostTailscaleIps()
      const callerIsHost = cleanCaller === '127.0.0.1' || hostTs.includes(cleanCaller)
      if (callerIsHost) {
        const hostConn = active.findLast(c => c.isHostSelf)
        if (hostConn) return hostConn
      } else {
        const sameDevice = active.findLast(c => c.remoteIp === cleanCaller)
        if (sameDevice) return sameDevice
      }
    }
    return active.at(-1) || null
  }

  async ensureStarted() {
    const saved = await this.settings.read()
    const pub = saved.publish || {}
    if (!pub.wechatsyncEnabled) {
      await this.stop()
      return
    }
    const desiredPort = pub.wechatsyncPort || 9537
    const allowTailscale = pub.wechatsyncAllowTailscale !== false
    const tsIps = allowTailscale ? this._hostTailscaleIps() : []
    const hosts = ['127.0.0.1', ...tsIps.filter(ip => ip !== '127.0.0.1')]
    const configKey = `${desiredPort}:${hosts.join(',')}`
    if (this.servers.length && this.listenConfigKey === configKey) return
    await this.stop()
    await this._listen(desiredPort, hosts, allowTailscale)
    this.listenConfigKey = this.servers.length ? configKey : ''
  }

  _attachUpgradeHandler(server, allowTailscale) {
    server.on('upgrade', async (req, socket) => {
      try {
        const remoteIp = normalizeIp(req.socket?.remoteAddress || socket?.remoteAddress)
        if (!isAllowedWsSourceIp(remoteIp, { allowTailscale })) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }
        const key = req.headers['sec-websocket-key']
        const upgrade = String(req.headers.upgrade || '').toLowerCase()
        if (!key || upgrade !== 'websocket') {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
          socket.destroy()
          return
        }
        const origin = String(req.headers.origin || '')
        const extId = parseExtensionId(origin)
        if (!extId && !(this.allowTestOrigin && origin === 'test://wechatsync')) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }
        const saved = await this.settings.read()
        const locked = saved.publish?.wechatsyncLockedExtId || ''
        if (locked && extId && locked !== extId) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }

        const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '\r\n',
        ].join('\r\n'))
        socket.setNoDelay?.(true)

        const cleanIp = remoteIp || '127.0.0.1'
        const hostTs = this._hostTailscaleIps()
        const isHostSelf = cleanIp === '127.0.0.1' || hostTs.includes(cleanIp)
        const clientId = `${cleanIp}:${(extId || 'test').slice(0, 8)}`
        const label = isHostSelf ? '本机 Chrome' : `远程电脑 Chrome (${cleanIp})`

        const prevSame = this.clients.get(clientId)
        if (prevSame && !prevSame.closed) {
          this.clients.delete(clientId)
          prevSame.close(1000, 'Replaced by reconnect')
        }

        const conn = new WsConnection(socket, {
          clientId,
          remoteIp: cleanIp,
          isHostSelf,
          label,
          origin,
          extId: extId || 'test',
          onMessage: raw => this._onClientMessage(conn, raw),
          onClose: closedConn => {
            if (this.clients.get(clientId) === closedConn) {
              this.clients.delete(clientId)
            }
            this._rejectPendingFor(closedConn, new Error(tr('Wechatsync 扩展连接已断开')))
          },
        })
        this.clients.set(clientId, conn)
      } catch {
        socket.destroy()
      }
    })
  }

  async _listen(port, hosts, allowTailscale) {
    this.listenError = null
    this.servers = []
    this.listeningHosts = []

    for (const host of hosts) {
      const server = createServer((req, res) => {
        res.statusCode = 426
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('WebSocket Upgrade Required')
      })
      this._attachUpgradeHandler(server, allowTailscale)

      const bound = await new Promise((resolvePromise) => {
        server.once('error', (err) => {
          if (host === '127.0.0.1') {
            this.listenError = err.code === 'EADDRINUSE'
              ? `端口 ${port} 已被占用，请在设置中更换 Wechatsync 端口`
              : err.message
          }
          resolvePromise(false)
        })
        server.listen(port, host, () => {
          const addr = server.address()
          if (!this.listeningPort) {
            this.listeningPort = typeof addr === 'object' && addr ? addr.port : port
          }
          resolvePromise(true)
        })
      })

      if (bound) {
        this.servers.push(server)
        this.listeningHosts.push(host)
      }
    }

    this.server = this.servers[0] || null
    if (this.servers.length) {
      this.pingTimer = setInterval(() => {
        for (const conn of this.clients.values()) conn.ping()
      }, 25_000)
      this.pingTimer.unref?.()
    }
  }

  async stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    for (const conn of [...this.clients.values()]) {
      conn.close(1001, 'Server stopping')
    }
    this.clients.clear()
    this._rejectAllPending(new Error('Wechatsync 服务已停止'))
    const toClose = [...this.servers]
    this.servers = []
    this.server = null
    this.listeningPort = null
    this.listeningHosts = []
    this.listenConfigKey = ''
    for (const srv of toClose) {
      await new Promise(r => srv.close(() => r()))
    }
    if (this._bgTasks.size) {
      await Promise.allSettled([...this._bgTasks])
    }
  }

  _rejectPendingFor(conn, err) {
    for (const [id, entry] of this.pending) {
      if (entry.conn === conn) {
        clearTimeout(entry.timer)
        this.pending.delete(id)
        entry.reject(err)
      }
    }
  }

  _rejectAllPending(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }

  async _onClientMessage(conn, raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (!msg || typeof msg.id !== 'string') return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(msg.id)
    if (msg.error) {
      const err = new Error(msg.error.message || 'Wechatsync 调用失败')
      err.code = msg.error.code
      pending.reject(err)
      return
    }
    // 首次鉴权调用成功后自动锁定扩展 ID（等待落盘后再唤醒调用方，消除并发写竞态）
    if (conn.extId && conn.extId !== 'test') {
      const lockTask = this.settings.read().then(saved => {
        if (!saved.publish?.wechatsyncLockedExtId) {
          return this.settings.update({ publish: { wechatsyncLockedExtId: conn.extId } })
        }
        return null
      }).catch(() => {})
      this._bgTasks.add(lockTask)
      try {
        await lockTask
      } finally {
        this._bgTasks.delete(lockTask)
      }
    }
    pending.resolve(msg.result)
  }

  async callExtension(method, params = {}, timeoutMs = 30_000, targetConn = null) {
    if (!ALLOWED_METHODS.has(method)) throw fail(400, '不支持的同步方法')
    await this.ensureStarted()
    const saved = await this.settings.read()
    const token = saved.publish?.wechatsyncToken || ''
    if (!token) throw fail(400, '请先在工作台「设置」里生成 Wechatsync Token 并填入扩展')
    const conn = targetConn || this.pickClient()
    if (!conn || conn.closed) {
      throw fail(503, 'Wechatsync 扩展尚未连接，请确认 Chrome 扩展已开启 MCP 连接并填入 ws://127.0.0.1:{port}')
    }
    const id = randomUUID()
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(fail(504, '等待 Wechatsync 扩展响应超时'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, conn })
      try {
        conn.sendText(JSON.stringify({ id, method, token, params }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        rejectPromise(err)
      }
    })
  }

  _urlsFor(port, pub) {
    const localWsUrl = `ws://127.0.0.1:${port}`
    const tsHost = (pub?.wechatsyncAllowTailscale !== false)
      ? (this.listeningHosts.find(h => isTailscaleIp(h)) || this._hostTailscaleIps()[0] || null)
      : null
    const tailscaleWsUrl = tsHost ? `ws://${tsHost}:${port}` : null
    return {
      wsUrl: tailscaleWsUrl || localWsUrl,
      localWsUrl,
      tailscaleWsUrl,
    }
  }

  async generateToken() {
    const token = `mdsync_${randomBytes(18).toString('hex')}`
    await this.settings.update({ publish: { wechatsyncToken: token } })
    await this.ensureStarted()
    const saved = await this.settings.read()
    const port = this.listeningPort || saved.publish?.wechatsyncPort || 9537
    return {
      token,
      ...this._urlsFor(port, saved.publish),
      tokenHint: token.slice(-4),
    }
  }

  async resetExtensionLock() {
    await this.settings.update({ publish: { wechatsyncLockedExtId: '' } })
    return { ok: true }
  }

  async status({ refreshPlatforms = false, callerIp = '', clientId = '' } = {}) {
    await this.ensureStarted()
    const saved = await this.settings.read()
    const pub = saved.publish || {}
    const port = this.listeningPort || pub.wechatsyncPort || 9537
    const urls = this._urlsFor(port, pub)
    const targetConn = this.pickClient({ clientId, callerIp })
    const connected = Boolean(targetConn && !targetConn.closed)
    const cleanCaller = normalizeIp(callerIp)
    const hostTs = this._hostTailscaleIps()
    const callerIsHost = cleanCaller === '127.0.0.1' || hostTs.includes(cleanCaller)

    const clientList = [...this.clients.values()]
      .filter(c => c && !c.closed)
      .map(c => ({
        clientId: c.clientId,
        remoteIp: c.remoteIp,
        isHostSelf: c.isHostSelf,
        isCallerMatch: callerIsHost ? c.isHostSelf : (Boolean(cleanCaller) && c.remoteIp === cleanCaller),
        label: c.label,
        connectedAt: c.connectedAt,
      }))

    let platforms = []
    let authError = null
    if (connected && pub.wechatsyncToken) {
      try {
        const list = await this.callExtension('listPlatforms', { forceRefresh: Boolean(refreshPlatforms) }, 25_000, targetConn)
        if (Array.isArray(list)) {
          platforms = list.map(item => ({
            id: item.id,
            name: WECHATSYNC_NAMES[item.id] || item.name || item.id,
            deskPlatform: WECHATSYNC_TO_DESK[item.id] || null,
            isAuthenticated: Boolean(item.isAuthenticated),
            username: item.username || '',
            error: item.error || '',
          }))
        }
      } catch (err) {
        authError = err.message
      }
    }
    return {
      enabled: Boolean(pub.wechatsyncEnabled),
      allowTailscale: pub.wechatsyncAllowTailscale !== false,
      port,
      ...urls,
      listeningHosts: [...this.listeningHosts],
      hasToken: Boolean(pub.wechatsyncToken),
      tokenHint: pub.wechatsyncToken ? pub.wechatsyncToken.slice(-4) : '',
      lockedExtId: pub.wechatsyncLockedExtId || '',
      connected,
      connectedAt: targetConn?.connectedAt || null,
      selectedClientId: targetConn?.clientId || null,
      selectedClientLabel: targetConn?.label || null,
      clients: clientList,
      listenError: this.listenError,
      authError,
      platforms,
      activeJobId: this.activeJobId,
    }
  }

  async records(note) {
    return {
      records: await this.publishStore.getSyncRecords(String(note ?? '')),
    }
  }

  job(id) {
    const found = this.jobs.get(String(id ?? ''))
    if (!found) throw fail(404, '找不到这个同步任务')
    return found
  }

  async startSync({ note, platforms, styleId = 'minimal', force = false, clientId = '', callerIp = '' }) {
    if (this.activeJobId) {
      const running = this.jobs.get(this.activeJobId)
      if (running?.status === 'running') throw fail(409, '上一篇稿件仍在同步草稿，请稍候')
    }
    const saved = await this.settings.read()
    const piece = await this.pieces().readPiece(String(note ?? ''))
    if (piece.form !== '长文') throw fail(400, '只有长文可以通过 Wechatsync 同步草稿')

    const requested = Array.isArray(platforms)
      ? platforms.map(p => DESK_TO_WECHATSYNC[p] || String(p).trim()).filter(Boolean)
      : []
    const uniquePlatforms = [...new Set(requested)]
    if (!uniquePlatforms.length) throw fail(400, '请至少勾选一个要同步草稿的平台')

    const targetConn = this.pickClient({ clientId, callerIp })
    if (!targetConn || targetConn.closed) {
      throw fail(503, 'Wechatsync 扩展未连接，请先确认 Chrome 已打开并开启 MCP 连接')
    }

    // 5 分钟防重复同步检查
    if (!force) {
      const prev = await this.publishStore.getSyncRecords(piece.note)
      const nowMs = this.now()
      const recent = uniquePlatforms.filter(id => {
        const rec = prev[id]
        if (!rec || rec.status !== 'draft' || !rec.at) return false
        return nowMs - Date.parse(rec.at) < DUPLICATE_WINDOW_MS
      })
      if (recent.length) {
        return {
          duplicateWarning: true,
          recentPlatforms: recent.map(id => WECHATSYNC_NAMES[id] || id),
        }
      }
    }

    const styles = await loadStyles(saved.wechatStyles)
    const style = styles.find(item => item.id === styleId) || styles[0]
    const article = await prepareSyncArticle(piece, style, { vaultRoot: saved.vaultRoot })

    const jobId = `sync_${randomUUID().slice(0, 8)}`
    const startedAt = new Date(this.now()).toISOString()
    const jobState = {
      id: jobId,
      note: piece.note,
      title: article.title,
      platforms: uniquePlatforms,
      styleId: style.id,
      clientId: targetConn.clientId,
      clientLabel: targetConn.label,
      status: 'running',
      startedAt,
      finishedAt: null,
      warnings: article.warnings || [],
      results: [],
      error: null,
    }
    this.jobs.set(jobId, jobState)
    this.activeJobId = jobId

    // 后台执行，页面通过 GET wechatsync/job 轮询
    void (async () => {
      try {
        // 关键：只传 content (内联样式 HTML)，绝不传 markdown，防止扩展用 markdown 重绘冲掉公众号样式
        const payload = {
          platforms: uniquePlatforms,
          article: {
            title: article.title,
            content: article.content,
            ...(article.cover ? { cover: article.cover } : {}),
          },
        }
        const res = await this.callExtension('syncArticle', payload, 360_000, targetConn)
        const list = Array.isArray(res?.results) ? res.results : []
        const nowIso = new Date(this.now()).toISOString()
        const toSave = {}
        const mapped = list.map(r => {
          const pid = r.platform
          const row = {
            platformId: pid,
            platformName: WECHATSYNC_NAMES[pid] || r.platformName || pid,
            deskPlatform: WECHATSYNC_TO_DESK[pid] || null,
            status: r.success ? 'draft' : 'failed',
            postUrl: r.postUrl || '',
            draftOnly: r.draftOnly !== false,
            error: r.error || '',
            styleId: style.id,
            at: nowIso,
          }
          toSave[pid] = row
          return row
        })
        await this.publishStore.saveSyncRecords(piece.note, toSave)
        jobState.results = mapped
        jobState.status = 'done'
        jobState.finishedAt = nowIso
      } catch (err) {
        jobState.status = 'failed'
        jobState.error = err.message
        jobState.finishedAt = new Date(this.now()).toISOString()
      } finally {
        if (this.activeJobId === jobId) this.activeJobId = null
      }
    })()

    return { job: jobState }
  }
}
