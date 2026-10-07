import fs from 'node:fs'
import path from 'node:path'
import { readRuntimeConfig, writeRuntimeConfig, type RuntimeInfrastructureConfig } from './store'

function mask(value: string | undefined): boolean {
  return Boolean(value?.trim())
}

function databaseUrlHint(value: string): string {
  try {
    const parsed = new URL(value)
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`
  } catch {
    return '已配置'
  }
}

export async function getRuntimeInfrastructurePublicConfig() {
  const config = readRuntimeConfig()
  if (!config) return { configured: false }
  return {
    configured: true,
    restartRequired: false,
    mysql: { configured: Boolean(config.databaseUrl), hint: databaseUrlHint(config.databaseUrl) },
    redis: { host: config.redis.host, port: config.redis.port, username: config.redis.username || '', tls: config.redis.tls, passwordConfigured: mask(config.redis.password) },
    temporal: { address: config.temporal.address, namespace: config.temporal.namespace, taskQueue: config.temporal.taskQueue, tls: config.temporal.tls, apiKeyConfigured: mask(config.temporal.apiKey) },
    storage: { endpoint: config.storage.endpoint, uploadEndpoint: config.storage.uploadEndpoint, region: config.storage.region, bucket: config.storage.bucket, forcePathStyle: config.storage.forcePathStyle, accessKeyConfigured: mask(config.storage.accessKeyId), secretKeyConfigured: mask(config.storage.secretAccessKey) },
    codexRuntime: config.codexRuntime || null,
    codexRuntimeImage: readCodexRuntimeImageState(),
    codexRuntimeDockerSocket: isDockerSocketAvailable(),
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readCodexRuntimeImageState() {
  const dataDir = process.env.WAO_DATA_DIR?.trim() || path.join(process.cwd(), 'data')
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'codex-runtime-image.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function isDockerSocketAvailable(): boolean {
  try {
    return fs.statSync('/var/run/docker.sock').isSocket()
  } catch {
    return false
  }
}

function validateRuntimeImage(value: string): string {
  if (value.endsWith(':local')) return value
  if (/^[^@\s]+@sha256:[a-f0-9]{64}$/u.test(value) && !value.endsWith(`@sha256:${'0'.repeat(64)}`)) return value
  throw new Error('CODEX_RUNTIME_IMAGE_MUST_USE_LOCAL_OR_DIGEST')
}

function validateRuntimeHostRoot(value: string): string {
  if (!value.startsWith('/') || value === '/' || /^\/(?:bin|boot|dev|etc|home|lib|lib64|proc|root|run|sbin|sys|usr|var)$/u.test(value) || /^\/(?:tmp|run)(?:\/|$)/u.test(value) || /^\/dev\/shm(?:\/|$)/u.test(value)) {
    throw new Error('CODEX_RUNTIME_HOST_ROOT_INVALID')
  }
  return value
}

function validateStorageEndpoint(value: string, field: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error(`${field}_INVALID`) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error(`${field}_INVALID`)
  }
  return value.replace(/\/+$/u, '')
}

function validateDatabaseUrl(value: string): string {
  if (!/^mysql(?:2)?:\/\//u.test(value)) throw new Error('DATABASE_URL_PROTOCOL_INVALID')
  return value
}

export async function updateRuntimeInfrastructureConfig(input: unknown) {
  const current = readRuntimeConfig()
  if (!current) throw new Error('RUNTIME_CONFIG_NOT_INITIALIZED')
  const body = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, unknown> : {}
  const redis = (body.redis && typeof body.redis === 'object' ? body.redis : {}) as Record<string, unknown>
  const temporal = (body.temporal && typeof body.temporal === 'object' ? body.temporal : {}) as Record<string, unknown>
  const storage = (body.storage && typeof body.storage === 'object' ? body.storage : {}) as Record<string, unknown>
  const codex = (body.codexRuntime && typeof body.codexRuntime === 'object' ? body.codexRuntime : {}) as Record<string, unknown>
  const redisPort = Number.isInteger(redis.port) ? Number(redis.port) : current.redis.port
  if (redisPort < 1 || redisPort > 65535) throw new Error('REDIS_PORT_INVALID')
  const cpuLimit = typeof codex.cpuLimit === 'number' ? codex.cpuLimit : current.codexRuntime?.cpuLimit
  const memoryBytes = typeof codex.memoryBytes === 'number' ? codex.memoryBytes : current.codexRuntime?.memoryBytes
  const pidsLimit = typeof codex.pidsLimit === 'number' ? codex.pidsLimit : current.codexRuntime?.pidsLimit
  const idleTimeoutMs = typeof codex.idleTimeoutMs === 'number' ? codex.idleTimeoutMs : current.codexRuntime?.idleTimeoutMs
  if (cpuLimit !== undefined && cpuLimit <= 0) throw new Error('CODEX_RUNTIME_CPU_INVALID')
  if (memoryBytes !== undefined && memoryBytes < 256 * 1024 * 1024) throw new Error('CODEX_RUNTIME_MEMORY_INVALID')
  if (pidsLimit !== undefined && (!Number.isInteger(pidsLimit) || pidsLimit < 32)) throw new Error('CODEX_RUNTIME_PIDS_INVALID')
  if (idleTimeoutMs !== undefined && (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 60_000)) throw new Error('CODEX_RUNTIME_IDLE_TIMEOUT_INVALID')
  const next: RuntimeInfrastructureConfig = {
    ...current,
    databaseUrl: typeof body.databaseUrl === 'string' && body.databaseUrl.trim()
      ? validateDatabaseUrl(body.databaseUrl.trim())
      : current.databaseUrl,
    redis: {
      ...current.redis,
      host: stringOr(redis.host, current.redis.host),
      port: redisPort,
      username: typeof redis.username === 'string' ? redis.username.trim() : current.redis.username,
      password: typeof redis.password === 'string' && redis.password ? redis.password : current.redis.password,
      tls: boolOr(redis.tls, current.redis.tls),
    },
    temporal: {
      ...current.temporal,
      address: stringOr(temporal.address, current.temporal.address),
      namespace: stringOr(temporal.namespace, current.temporal.namespace),
      taskQueue: stringOr(temporal.taskQueue, current.temporal.taskQueue),
      apiKey: typeof temporal.apiKey === 'string' && temporal.apiKey ? temporal.apiKey : current.temporal.apiKey,
      tls: boolOr(temporal.tls, current.temporal.tls),
    },
    storage: {
      ...current.storage,
      endpoint: typeof storage.endpoint === 'string' && storage.endpoint.trim()
        ? validateStorageEndpoint(storage.endpoint.trim(), 'S3_ENDPOINT')
        : current.storage.endpoint,
      uploadEndpoint: typeof storage.uploadEndpoint === 'string' && storage.uploadEndpoint.trim()
        ? validateStorageEndpoint(storage.uploadEndpoint.trim(), 'S3_UPLOAD_ENDPOINT')
        : current.storage.uploadEndpoint,
      region: stringOr(storage.region, current.storage.region),
      bucket: stringOr(storage.bucket, current.storage.bucket),
      accessKeyId: stringOr(storage.accessKeyId, current.storage.accessKeyId),
      secretAccessKey: typeof storage.secretAccessKey === 'string' && storage.secretAccessKey ? storage.secretAccessKey : current.storage.secretAccessKey,
      sessionToken: typeof storage.sessionToken === 'string' && storage.sessionToken ? storage.sessionToken : current.storage.sessionToken,
      forcePathStyle: boolOr(storage.forcePathStyle, current.storage.forcePathStyle),
    },
    codexRuntime: current.codexRuntime ? {
      ...current.codexRuntime,
      hostRoot: typeof codex.hostRoot === 'string' && codex.hostRoot.trim()
        ? validateRuntimeHostRoot(codex.hostRoot.trim())
        : current.codexRuntime.hostRoot,
      idleTimeoutMs: typeof codex.idleTimeoutMs === 'number' ? codex.idleTimeoutMs : current.codexRuntime.idleTimeoutMs,
      image: typeof codex.image === 'string'
        ? (codex.image.trim() ? validateRuntimeImage(codex.image.trim()) : undefined)
        : current.codexRuntime.image,
      networkName: stringOr(codex.networkName, current.codexRuntime.networkName),
      cpuLimit: typeof codex.cpuLimit === 'number' ? codex.cpuLimit : current.codexRuntime.cpuLimit,
      memoryBytes: typeof codex.memoryBytes === 'number' ? codex.memoryBytes : current.codexRuntime.memoryBytes,
      pidsLimit: typeof codex.pidsLimit === 'number' ? codex.pidsLimit : current.codexRuntime.pidsLimit,
    } : current.codexRuntime,
  }
  writeRuntimeConfig(next)
  process.env.REDIS_HOST = next.redis.host
  process.env.REDIS_PORT = String(next.redis.port)
  process.env.REDIS_USERNAME = next.redis.username || ''
  process.env.REDIS_PASSWORD = next.redis.password || ''
  process.env.REDIS_TLS = next.redis.tls ? 'true' : ''
  process.env.TEMPORAL_ADDRESS = next.temporal.address
  process.env.TEMPORAL_NAMESPACE = next.temporal.namespace
  process.env.TEMPORAL_TASK_QUEUE = next.temporal.taskQueue
  process.env.TEMPORAL_API_KEY = next.temporal.apiKey || ''
  process.env.TEMPORAL_TLS_ENABLED = next.temporal.tls ? 'true' : 'false'
  process.env.S3_ENDPOINT = next.storage.endpoint
  process.env.S3_UPLOAD_ENDPOINT = next.storage.uploadEndpoint
  process.env.S3_REGION = next.storage.region
  process.env.S3_BUCKET = next.storage.bucket
  process.env.S3_ACCESS_KEY_ID = next.storage.accessKeyId
  process.env.S3_SECRET_ACCESS_KEY = next.storage.secretAccessKey
  process.env.S3_SESSION_TOKEN = next.storage.sessionToken || ''
  process.env.S3_FORCE_PATH_STYLE = next.storage.forcePathStyle ? 'true' : 'false'
  await import('@/lib/redis').then((module) => module.resetRedisRuntime?.()).catch(() => undefined)
  await import('@/lib/storage').then((module) => module.resetStorageProvider?.()).catch(() => undefined)
  await import('@/lib/temporal/client').then((module) => module.resetTemporalClient?.()).catch(() => undefined)
  return {
    success: true,
    restartRequired: next.databaseUrl !== current.databaseUrl
      || JSON.stringify(next.codexRuntime) !== JSON.stringify(current.codexRuntime),
  }
}
