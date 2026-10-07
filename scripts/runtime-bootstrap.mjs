#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'

const dataDir = process.env.WAO_DATA_DIR?.trim() || path.join(process.cwd(), 'data')
const stateFile = path.join(dataDir, 'bootstrap-state.json')
const configFile = path.join(dataDir, 'runtime-config.enc.json')
const runtimeImageStateFile = path.join(dataDir, 'codex-runtime-image.json')
const runtimeFingerprintInputs = ['Dockerfile.codex-runtime', 'docker/codex-runtime/entrypoint.sh', 'LICENSE']

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, file)
  try { fs.chmodSync(file, 0o600) } catch { /* best effort on bind mounts */ }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function ensureState() {
  const current = readJson(stateFile)
  if (current?.version === 1 && current.setupToken && current.nextAuthSecret && current.apiEncryptionKey && current.cronSecret) {
    return current
  }
  const state = {
    version: 1,
    setupToken: crypto.randomBytes(32).toString('base64url'),
    nextAuthSecret: process.env.NEXTAUTH_SECRET?.trim() || crypto.randomBytes(48).toString('base64url'),
    apiEncryptionKey: process.env.API_ENCRYPTION_KEY?.trim() || crypto.randomBytes(32).toString('hex'),
    cronSecret: process.env.CRON_SECRET?.trim() || crypto.randomBytes(32).toString('base64url'),
    configured: false,
    updatedAt: new Date().toISOString(),
  }
  writeJson(stateFile, state)
  return state
}

function decryptConfig(payload, secret) {
  const key = crypto.pbkdf2Sync(secret, 'waoowaoo-runtime-config-v1', 100_000, 32, 'sha256')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'))
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8'))
}

function runtimeSourceSha256() {
  const root = process.env.CODEX_RUNTIME_BUILD_CONTEXT?.trim() || process.cwd()
  const hash = crypto.createHash('sha256')
  for (const relative of runtimeFingerprintInputs) {
    hash.update(relative)
    hash.update(fs.readFileSync(path.join(root, relative)))
  }
  return hash.digest('hex')
}

function resolveAttestedLocalRuntimeImage(candidate) {
  if (!candidate || !candidate.endsWith(':local')) return null
  try {
    const state = readJson(runtimeImageStateFile)
    if (!state?.imageId || !state?.sourceSha256 || state.image !== candidate) return null
    const sourceSha = runtimeSourceSha256()
    if (sourceSha !== state.sourceSha256) return null
    const inspected = JSON.parse(execFileSync('docker', [
      'image', 'inspect', candidate, '--format', '{{json .}}',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    const labels = inspected?.Config?.Labels || {}
    if (inspected?.Id !== state.imageId || labels['wao.codex.runtime.source-sha'] !== sourceSha) return null
    return state.imageId
  } catch {
    return null
  }
}

function applyRuntimeEnvironment(state) {
  process.env.NEXTAUTH_SECRET = state.nextAuthSecret
  process.env.API_ENCRYPTION_KEY = state.apiEncryptionKey
  process.env.CRON_SECRET = state.cronSecret
  process.env.WAO_SETUP_MODE = state.configured ? '0' : '1'

  const payload = readJson(configFile)
  if (!state.configured || !payload) {
    if (state.configured) process.env.WAO_SETUP_MODE = '1'
    return
  }
  const config = decryptConfig(payload, state.apiEncryptionKey)
  process.env.DATABASE_URL = config.databaseUrl
  process.env.REDIS_HOST = config.redis.host
  process.env.REDIS_PORT = String(config.redis.port)
  process.env.REDIS_USERNAME = config.redis.username || ''
  process.env.REDIS_PASSWORD = config.redis.password || ''
  process.env.REDIS_TLS = config.redis.tls ? 'true' : ''
  process.env.TEMPORAL_ADDRESS = config.temporal.address
  process.env.TEMPORAL_NAMESPACE = config.temporal.namespace
  process.env.TEMPORAL_TASK_QUEUE = config.temporal.taskQueue
  process.env.TEMPORAL_API_KEY = config.temporal.apiKey || ''
  process.env.TEMPORAL_TLS_ENABLED = config.temporal.tls ? 'true' : 'false'
  process.env.S3_ENDPOINT = config.storage.endpoint
  process.env.S3_UPLOAD_ENDPOINT = config.storage.uploadEndpoint
  process.env.S3_REGION = config.storage.region
  process.env.S3_BUCKET = config.storage.bucket
  process.env.S3_ACCESS_KEY_ID = config.storage.accessKeyId
  process.env.S3_SECRET_ACCESS_KEY = config.storage.secretAccessKey
  process.env.S3_SESSION_TOKEN = config.storage.sessionToken || ''
  process.env.S3_FORCE_PATH_STYLE = config.storage.forcePathStyle ? 'true' : 'false'
  process.env.ADMIN_USER_IDS = (config.adminUserIds || []).join(',')
  const runtime = config.codexRuntime || {}
  process.env.CODEX_RUNTIME_DRIVER = runtime.driver || 'docker'
  process.env.CODEX_RUNTIME_HOST_ROOT = runtime.hostRoot || '/var/lib/wao/codex-runtime'
  process.env.CODEX_RUNTIME_IDLE_TIMEOUT_MS = String(runtime.idleTimeoutMs || 900000)
  const configuredImage = runtime.image || process.env.CODEX_RUNTIME_BUILD_IMAGE || 'waoowaoo-codex-runtime:local'
  process.env.CODEX_RUNTIME_IMAGE = configuredImage
  process.env.CODEX_RUNTIME_NETWORK = runtime.networkName || 'waoowaoo_codex-runtime'
  process.env.CODEX_RUNTIME_CPU_LIMIT = String(runtime.cpuLimit || 2)
  process.env.CODEX_RUNTIME_MEMORY_BYTES = String(runtime.memoryBytes || 2147483648)
  process.env.CODEX_RUNTIME_PIDS_LIMIT = String(runtime.pidsLimit || 256)
  const attestedImage = resolveAttestedLocalRuntimeImage(configuredImage)
  if (attestedImage) {
    // Use the immutable image ID for runtime containers after verifying the
    // local tag and its source fingerprint.
    process.env.CODEX_RUNTIME_IMAGE = attestedImage
    process.env.CODEX_RUNTIME_IMAGE_ATTESTED = '1'
  } else {
    delete process.env.CODEX_RUNTIME_IMAGE_ATTESTED
  }
}

const state = ensureState()
if (process.argv.includes('--init')) {
  let validConfig = false
  const payload = readJson(configFile)
  if (state.configured && payload) {
    try { decryptConfig(payload, state.apiEncryptionKey); validConfig = true } catch { /* setup recovery below */ }
  }
  if (!validConfig) {
    process.stderr.write(`Waoowaoo setup URL token: ${state.setupToken}\n`)
  }
  process.exit(0)
}

try {
  applyRuntimeEnvironment(state)
} catch (error) {
  // A damaged or partially written encrypted config must leave the Web
  // settings page reachable. Runtime integrations remain disabled until an
  // administrator completes setup again.
  process.env.WAO_SETUP_MODE = '1'
  process.stderr.write(`Waoowaoo runtime config unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
}
const command = process.argv.slice(2)
if (command.length === 0) process.exit(0)
const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env })
let forwardedSignal = false
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    if (forwardedSignal) return
    forwardedSignal = true
    try { child.kill(signal) } catch { /* child may have exited */ }
  })
}
child.on('exit', (code, signal) => {
  if (signal) {
    // Remove the forwarding handler before re-emitting the child's signal;
    // otherwise PID 1 would catch its own signal and loop indefinitely.
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  }
  else process.exit(code ?? 1)
})
