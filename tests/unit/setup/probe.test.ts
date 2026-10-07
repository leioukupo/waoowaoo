import { afterAll, describe, expect, it } from 'vitest'
import net from 'node:net'
import { isProbeHostAllowed, probeSetupServices } from '@/lib/setup/probe'
import { createSlidingWindowThrottle } from '@/lib/setup/throttle'

function startFakeServerListeningOnly(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(() => undefined)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        resolve({ port: address.port, close: () => new Promise((done) => server.close(() => done())) })
      } else reject(new Error('no address'))
    })
  })
}

const servers: net.Server[] = []
describe('setup service probe', () => {
  afterAll(async () => {
    for (const server of servers) await new Promise((done) => server.close(done))
  })

  it('accepts IPv4, IPv6 and hostname formats', () => {
    expect(isProbeHostAllowed('192.168.31.9')).toBe(true)
    expect(isProbeHostAllowed('10.0.0.1 ')).toBe(true)
    expect(isProbeHostAllowed('::1')).toBe(true)
    expect(isProbeHostAllowed('rustfs.example.com')).toBe(true)
    expect(isProbeHostAllowed('a.b-c.d')).toBe(true)
  })

  it('rejects metadata endpoints, malformed hosts and foreign input', () => {
    expect(isProbeHostAllowed('169.254.169.254')).toBe(false)
    expect(isProbeHostAllowed('')).toBe(false)
    expect(isProbeHostAllowed('   ')).toBe(false)
    expect(isProbeHostAllowed('bad host')).toBe(false)
    expect(isProbeHostAllowed('http://x')).toBe(false)
    expect(isProbeHostAllowed('a..b')).toBe(false)
    expect(isProbeHostAllowed('a b'.repeat(100))).toBe(false)
    expect(isProbeHostAllowed(42)).toBe(false)
    expect(isProbeHostAllowed(null)).toBe(false)
  })

  it('detects each protocol by handshake and reports version hints', async () => {
    const mysqlPort = await new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        // Initial MySQL handshake as a framed packet:
        // [3-byte length][sequence 0][protocol 10][version\0][padding]
        const payload = Buffer.concat([Buffer.from([0x0a]), Buffer.from('8.0.36\0'), Buffer.alloc(24)])
        const header = Buffer.alloc(4)
        header.writeUInt32LE(payload.length, 0)
        socket.write(Buffer.concat([header, payload]))
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('no address'))
      })
      servers.push(server)
    })

    const redisPort = await new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.once('data', () => socket.write('+PONG\r\n'))
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('no address'))
      })
      servers.push(server)
    })

    const redisNoauthPort = await new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.once('data', () => socket.write('-NOAUTH Authentication required.\r\n'))
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('no address'))
      })
      servers.push(server)
    })

    const temporalPort = await new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        // Reply with an empty HTTP/2 SETTINGS frame (length 0, type 0x04).
        socket.once('data', () => socket.write(Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0])))
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('no address'))
      })
      servers.push(server)
    })

    const s3Port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.once('data', () =>
          socket.write('HTTP/1.1 400 Bad Request\r\nServer: rustfs/0.1\r\nContent-Length: 0\r\n\r\n'),
        )
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('no address'))
      })
      servers.push(server)
    })

    const result = await probeSetupServices('127.0.0.1', {
      timeoutMs: 1000,
      ports: { mysql: mysqlPort, redis: redisPort, temporal: temporalPort, s3: s3Port },
    })

    const byKey = Object.fromEntries(result.services.map((service) => [service.key, service]))
    expect(byKey.mysql.detected).toBe(true)
    expect(byKey.mysql.detail).toBe('MySQL 8.0.36')
    expect(byKey.redis.detected).toBe(true)
    expect(byKey.redis.detail).toBe('Redis')
    expect(byKey.temporal.detected).toBe(true)
    expect(byKey.temporal.detail).toContain('HTTP/2')
    expect(byKey.s3.detected).toBe(true)
    expect(byKey.s3.detail).toContain('rustfs')

    // A NOAUTH Redis is detected but flagged as requiring a password.
    const noauth = await probeSetupServices('127.0.0.1', {
      timeoutMs: 1000,
      ports: { redis: redisNoauthPort },
    })
    expect(noauth.services.find((service) => service.key === 'redis')?.detail).toContain('需要密码')
  })

  it('reports undetected when nothing is listening on the default ports', async () => {
    const { port, close } = await startFakeServerListeningOnly()
    await close()
    const result = await probeSetupServices('127.0.0.1', {
      timeoutMs: 500,
      ports: { mysql: port, redis: port, temporal: port, s3: port },
    })
    for (const service of result.services) expect(service.detected).toBe(false)
  })

  it('throttles repeated probes per key inside the sliding window', () => {
    const throttle = createSlidingWindowThrottle(1000, 2)
    expect(throttle.allow('a', 1000)).toBeNull()
    expect(throttle.allow('a', 1500)).toBeNull()
    expect(throttle.allow('a', 1600)).toBeGreaterThan(0)
    expect(throttle.allow('b', 1600)).toBeNull()
    // The oldest hit leaves the window; one request becomes available.
    expect(throttle.allow('a', 2601)).toBeNull()
    expect(throttle.allow('a', 2602)).toBeNull()
  })
})
