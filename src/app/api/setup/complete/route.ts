import { NextRequest, NextResponse } from 'next/server'
import { isIP } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import bcrypt from 'bcryptjs'
import { getBootstrapState, isRuntimeConfigured, writeRuntimeConfig } from '@/lib/runtime-config/store'

const execFileAsync = promisify(execFile)

type SetupBody = {
  setupToken?: string
  database?: { host?: string; port?: number; username?: string; password?: string; name?: string }
  databaseUrl?: string
  adminName?: string
  adminEmail?: string
  adminPassword?: string
  redis?: { host?: string; port?: number; username?: string; password?: string; tls?: boolean }
  temporal?: { address?: string; namespace?: string; taskQueue?: string; apiKey?: string; tls?: boolean }
  storage?: { endpoint?: string; uploadEndpoint?: string; region?: string; bucket?: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; forcePathStyle?: boolean }
  codexRuntime?: { image?: string; hostRoot?: string; idleTimeoutMs?: number; cpuLimit?: number; memoryBytes?: number; pidsLimit?: number }
}

function readString(value: unknown, field: string, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min) throw new Error(`${field}_REQUIRED`)
  return value.trim()
}

function readUrl(value: unknown, field: string): string {
  const raw = readString(value, field)
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${field}_PROTOCOL_INVALID`)
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error(`${field}_INVALID`)
  return raw.replace(/\/$/u, '')
}

function readDatabaseUrl(value: unknown): string {
  const raw = readString(value, 'DATABASE_URL')
  if (!/^mysql(?:2)?:\/\//u.test(raw)) throw new Error('DATABASE_URL_PROTOCOL_INVALID')
  return raw
}

function readStructuredDatabase(value: SetupBody['database']): string {
  const host = readString(value?.host, 'DB_HOST')
  const port = Number(value?.port ?? 3306)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DB_PORT_INVALID')
  const username = readString(value?.username, 'DB_USERNAME')
  const password = typeof value?.password === 'string' ? value.password : ''
  const name = readString(value?.name, 'DB_NAME')
  if (/[\\/\s`]/u.test(name)) throw new Error('DB_NAME_INVALID')
  const hostPart = isIP(host) === 6 ? `[${host}]` : host
  return `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${hostPart}:${port}/${name}`
}

/**
 * 在 prisma db push 之前确认目标数据库存在：先直连目标库，若返回
 * "Unknown database"（errno 1049）则改连服务器并 CREATE DATABASE IF NOT EXISTS，
 * 让表单里填写的新库名可以直接生效；其他错误原样抛出。
 */
async function ensureMysqlDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl)
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''))
  if (!database) return
  const { createConnection } = await import('mysql2/promise')
  const connectionOptions = {
    host: url.hostname.replace(/^\[(.*)\]$/u, '$1'),
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectTimeout: 10_000,
  }
  try {
    const connection = await createConnection({ ...connectionOptions, database })
    await connection.end()
    return
  } catch (error) {
    if ((error as { errno?: number })?.errno !== 1049) throw error
  }
  const escapedName = database.replaceAll('`', '``')
  const connection = await createConnection(connectionOptions)
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${escapedName}\` CHARACTER SET utf8mb4`)
  } finally {
    await connection.end()
  }
}

function readPositiveNumber(value: unknown, field: string, fallback: number, minimum: number): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum) throw new Error(`${field}_INVALID`)
  return parsed
}

function readRuntimeImage(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const image = readString(value, 'CODEX_RUNTIME_IMAGE')
  if (image.endsWith(':local')) return image
  if (/^[^@\s]+@sha256:[a-f0-9]{64}$/u.test(image) && !image.endsWith(`@sha256:${'0'.repeat(64)}`)) return image
  throw new Error('CODEX_RUNTIME_IMAGE_MUST_USE_LOCAL_OR_DIGEST')
}

export async function POST(request: NextRequest) {
  if (isRuntimeConfigured()) return NextResponse.json({ error: { code: 'SETUP_ALREADY_COMPLETE' } }, { status: 409 })
  const body = await request.json() as SetupBody
  const state = getBootstrapState()
  if (!body.setupToken || body.setupToken !== state.setupToken) {
    return NextResponse.json({ error: { code: 'SETUP_TOKEN_INVALID' } }, { status: 403 })
  }

  let client: import('@prisma/client').PrismaClient | null = null
  try {
    const databaseUrl = body.database
      ? readStructuredDatabase(body.database)
      : readDatabaseUrl(body.databaseUrl)
    const adminName = readString(body.adminName, 'ADMIN_NAME')
    const adminEmail = readString(body.adminEmail, 'ADMIN_EMAIL')
    const adminPassword = readString(body.adminPassword, 'ADMIN_PASSWORD', 10)
    const redisHost = readString(body.redis?.host, 'REDIS_HOST')
    const temporalAddress = readString(body.temporal?.address, 'TEMPORAL_ADDRESS')
    const storageEndpoint = readUrl(body.storage?.endpoint, 'S3_ENDPOINT')
    const uploadEndpoint = readUrl(body.storage?.uploadEndpoint || storageEndpoint, 'S3_UPLOAD_ENDPOINT')
    const bucket = readString(body.storage?.bucket, 'S3_BUCKET')
    const accessKeyId = readString(body.storage?.accessKeyId, 'S3_ACCESS_KEY_ID')
    const secretAccessKey = readString(body.storage?.secretAccessKey, 'S3_SECRET_ACCESS_KEY')
    const port = Number(body.redis?.port ?? 6379)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('REDIS_PORT_INVALID')

    await ensureMysqlDatabase(databaseUrl)
    await execFileAsync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    const { PrismaClient } = await import('@prisma/client')
    process.env.DATABASE_URL = databaseUrl
    client = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    await client.$connect()
    const password = await bcrypt.hash(adminPassword, 12)
    const user = await client.user.upsert({
      where: { name: adminName },
      update: { email: adminEmail, password },
      create: { name: adminName, email: adminEmail, password },
      select: { id: true },
    })

    const runtimeImage = readRuntimeImage(body.codexRuntime?.image)
    const runtimeHostRoot = body.codexRuntime?.hostRoot
      ? readString(body.codexRuntime.hostRoot, 'CODEX_RUNTIME_HOST_ROOT')
      : process.env.CODEX_RUNTIME_HOST_ROOT?.trim() || '/var/lib/wao/codex-runtime'
    if (!runtimeHostRoot.startsWith('/') || runtimeHostRoot === '/' || /^\/(?:bin|boot|dev|etc|home|lib|lib64|proc|root|run|sbin|sys|usr|var)$/u.test(runtimeHostRoot) || /^\/(?:tmp|run)(?:\/|$)/u.test(runtimeHostRoot) || /^\/dev\/shm(?:\/|$)/u.test(runtimeHostRoot)) {
      throw new Error('CODEX_RUNTIME_HOST_ROOT_INVALID')
    }
    const runtimeIdleTimeoutMs = readPositiveNumber(body.codexRuntime?.idleTimeoutMs, 'CODEX_RUNTIME_IDLE_TIMEOUT_MS', 900_000, 60_000)
    const runtimeCpuLimit = readPositiveNumber(body.codexRuntime?.cpuLimit, 'CODEX_RUNTIME_CPU_LIMIT', 2, 0.1)
    const runtimeMemoryBytes = readPositiveNumber(body.codexRuntime?.memoryBytes, 'CODEX_RUNTIME_MEMORY_BYTES', 2_147_483_648, 256 * 1024 * 1024)
    const runtimePidsLimit = readPositiveNumber(body.codexRuntime?.pidsLimit, 'CODEX_RUNTIME_PIDS_LIMIT', 256, 32)
    if (!Number.isSafeInteger(runtimePidsLimit)) throw new Error('CODEX_RUNTIME_PIDS_LIMIT_INVALID')

    writeRuntimeConfig({
      databaseUrl,
      redis: { host: redisHost, port, username: body.redis?.username?.trim() || undefined, password: body.redis?.password || undefined, tls: body.redis?.tls === true },
      temporal: { address: temporalAddress, namespace: body.temporal?.namespace?.trim() || 'waoowaoo', taskQueue: body.temporal?.taskQueue?.trim() || 'waoowaoo-runtime', apiKey: body.temporal?.apiKey || undefined, tls: body.temporal?.tls === true },
      storage: { endpoint: storageEndpoint, uploadEndpoint, region: body.storage?.region?.trim() || 'us-east-1', bucket, accessKeyId, secretAccessKey, sessionToken: body.storage?.sessionToken || undefined, forcePathStyle: body.storage?.forcePathStyle !== false },
      adminUserIds: [user.id],
      codexRuntime: {
        driver: 'docker',
        hostRoot: runtimeHostRoot,
        idleTimeoutMs: runtimeIdleTimeoutMs,
        networkName: process.env.CODEX_RUNTIME_NETWORK?.trim() || 'waoowaoo_codex-runtime',
        ...(runtimeImage ? { image: runtimeImage } : {}),
        cpuLimit: runtimeCpuLimit,
        memoryBytes: runtimeMemoryBytes,
        pidsLimit: Math.floor(runtimePidsLimit),
      },
    })
    return NextResponse.json({ success: true, restartRequired: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SETUP_FAILED'
    return NextResponse.json({ error: { code: message.slice(0, 160), message: message.slice(0, 400) } }, { status: 400 })
  } finally {
    await client?.$disconnect().catch(() => undefined)
  }
}
