import net from 'node:net'
import {
  SETUP_PROBE_SERVICES,
  type ProbeServiceKey,
  type ProbeServiceResult,
  type ProbeServicesResponse,
  type ProbeServiceSpec,
} from './probe-spec'

/**
 * 初始化页的服务探测（服务端）。
 *
 * 浏览器无法发起原始 TCP 连接，探测必须由服务端完成：对每个固定默认端口
 * 建立 TCP 连接并做最小化协议握手（MySQL 问候包、Redis PING、HTTP/2 前导、
 * HTTP GET），仅返回"是否存活 + 版本线索"，不传输任何凭据。
 */

export { SETUP_PROBE_SERVICES }
export type {
  ProbeServiceKey,
  ProbeServiceResult,
  ProbeServiceSpec,
  ProbeServicesResponse,
} from './probe-spec'

export interface ProbeServicesOptions {
  /** 每个服务等待 TCP 连接/握手的超时，默认 1500ms。 */
  timeoutMs?: number
  /** 覆盖默认端口（测试用；生产路径固定使用服务默认端口）。 */
  ports?: Partial<Record<ProbeServiceKey, number>>
}

const DEFAULT_TIMEOUT_MS = 1500
const HARD_DEADLINE_MS = 4000
// Cloud metadata endpoints are the classic SSRF target; probing them is
// never useful for the setup form.
const BLOCKED_HOSTS = new Set(['169.254.169.254'])

const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i

export function isProbeHostAllowed(host: unknown): host is string {
  if (typeof host !== 'string') return false
  const trimmed = host.trim()
  if (trimmed.length === 0 || trimmed.length > 253) return false
  if (BLOCKED_HOSTS.has(trimmed)) return false
  if (net.isIP(trimmed) !== 0) return true
  return HOSTNAME_PATTERN.test(trimmed)
}

function openSocket(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: timeoutMs })
    const fail = (error: Error) => {
      socket.destroy()
      reject(error)
    }
    socket.once('connect', () => resolve(socket))
    socket.once('error', (error) => fail(error))
    socket.once('timeout', () => fail(new Error('PROBE_TIMEOUT')))
  })
}

function readFirstData(socket: net.Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const finish = (error?: Error) => {
      socket.removeListener('data', onData)
      if (error) reject(error)
      else resolve(Buffer.concat(chunks))
    }
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      finish()
    }
    socket.once('data', onData)
    socket.once('error', (error) => finish(error))
    socket.once('timeout', () => finish(new Error('PROBE_TIMEOUT')))
    socket.setTimeout(timeoutMs)
  })
}

function readSome(socket: net.Socket, minBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.removeListener('data', onData)
      if (error) reject(error)
      else resolve(Buffer.concat(chunks))
    }
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      const total = chunks.reduce((sum, item) => sum + item.length, 0)
      if (total >= minBytes) {
        finish()
        return
      }
      // A few more milliseconds may complete the packet; the outer
      // deadline bounds the wait.
      setTimeout(() => finish(), 250)
    }
    socket.once('data', onData)
    socket.once('error', (error) => finish(error))
    socket.once('timeout', () => finish())
    socket.setTimeout(timeoutMs)
  })
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PROBE_DEADLINE')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

interface HandshakeOutcome {
  detected: boolean
  detail?: string
}

function parseMysqlVersion(greeting: Buffer): string | null {
  // A live MySQL greeting is a framed packet:
  // [3-byte payload length][1-byte sequence][protocol 0x0a][version\0]...
  // (Defensively also accept an unframed stream for test doubles.)
  let offset: number
  if (greeting.length >= 5 && greeting[4] === 0x0a) offset = 4
  else if (greeting.length >= 1 && greeting[0] === 0x0a) offset = 0
  else return null
  const terminator = greeting.indexOf(0x00, offset + 1)
  if (terminator < 0) return null
  const version = greeting.subarray(offset + 1, terminator).toString('utf8')
  return /^[0-9][0-9A-Za-z._-]*$/u.test(version) ? version : null
}

async function handshakeMysql(socket: net.Socket, timeoutMs: number): Promise<HandshakeOutcome> {
  const greeting = await readSome(socket, 5, timeoutMs)
  const version = parseMysqlVersion(greeting)
  return version ? { detected: true, detail: `MySQL ${version}` } : { detected: false }
}

async function handshakeRedis(socket: net.Socket, timeoutMs: number): Promise<HandshakeOutcome> {
  socket.write('PING\r\n')
  const reply = await readFirstData(socket, timeoutMs)
  const first = reply[0]
  if (first === undefined) return { detected: false }
  // RESP markers: + simple string, - error, : integer, $ bulk, > array.
  if (![0x2b, 0x2d, 0x3a, 0x24, 0x3e].includes(first)) return { detected: false }
  const body = reply.subarray(1).toString('utf8')
  if (body.startsWith('NOAUTH')) return { detected: true, detail: 'Redis（需要密码认证）' }
  return { detected: true, detail: 'Redis' }
}

async function handshakeTemporal(socket: net.Socket, timeoutMs: number): Promise<HandshakeOutcome> {
  // HTTP/2 client preface plus an empty SETTINGS frame. A gRPC endpoint
  // (Temporal frontend on 7233) answers with its own SETTINGS frame.
  const preface = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'
  socket.write(Buffer.concat([Buffer.from(preface, 'utf8'), Buffer.alloc(9)]))
  const frame = await readFirstData(socket, timeoutMs)
  if (frame.length < 9) return { detected: false }
  // 9-byte frame header: 3-byte length, 1-byte type, 4-byte flags/stream id.
  if (frame[3] === 0x04) return { detected: true, detail: 'Temporal gRPC（HTTP/2）' }
  return { detected: false }
}

async function handshakeS3(
  socket: net.Socket,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<HandshakeOutcome> {
  socket.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`)
  const reply = await readFirstData(socket, timeoutMs)
  const head = reply.subarray(0, 64).toString('utf8')
  if (!/^HTTP\/\d+\.\d+ \d{3}/u.test(head)) return { detected: false }
  const server = /Server:\s*([^\r\n]+)/i.exec(reply.toString('utf8'))?.[1]?.trim()
  return { detected: true, detail: server || 'S3/HTTP 服务' }
}

async function probeOneService(
  host: string,
  spec: ProbeServiceSpec,
  port: number,
  timeoutMs: number,
): Promise<HandshakeOutcome> {
  let socket: net.Socket | null = null
  try {
    socket = await openSocket(host, port, timeoutMs)
    switch (spec.key) {
      case 'mysql':
        return await handshakeMysql(socket, timeoutMs)
      case 'redis':
        return await handshakeRedis(socket, timeoutMs)
      case 'temporal':
        return await handshakeTemporal(socket, timeoutMs)
      case 's3':
        return await handshakeS3(socket, host, port, timeoutMs)
    }
    return { detected: false }
  } catch {
    return { detected: false }
  } finally {
    socket?.destroy()
  }
}

export async function probeSetupServices(
  host: string,
  options: ProbeServicesOptions = {},
): Promise<ProbeServicesResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const services = await Promise.all(
    SETUP_PROBE_SERVICES.map(async (spec): Promise<ProbeServiceResult> => {
      const port = options.ports?.[spec.key] ?? spec.defaultPort
      const outcome = await withDeadline(
        probeOneService(host, spec, port, timeoutMs),
        HARD_DEADLINE_MS,
      ).catch(() => ({ detected: false } as HandshakeOutcome))
      return {
        key: spec.key,
        label: spec.label,
        port,
        detected: outcome.detected,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      }
    }),
  )
  return { host, services }
}
