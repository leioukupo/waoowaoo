import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type RuntimeInfrastructureConfig = {
  databaseUrl: string
  redis: {
    host: string
    port: number
    username?: string
    password?: string
    tls: boolean
  }
  temporal: {
    address: string
    namespace: string
    taskQueue: string
    apiKey?: string
    tls: boolean
  }
  storage: {
    endpoint: string
    uploadEndpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
    forcePathStyle: boolean
  }
  adminUserIds: string[]
  codexRuntime?: {
    driver: 'docker'
    hostRoot: string
    idleTimeoutMs: number
    image?: string
    networkName: string
    cpuLimit: number
    memoryBytes: number
    pidsLimit: number
  }
}

type BootstrapState = {
  version: 1
  setupToken: string
  nextAuthSecret: string
  apiEncryptionKey: string
  cronSecret: string
  configured: boolean
  updatedAt: string
}

type EncryptedPayload = {
  version: 1
  iv: string
  tag: string
  ciphertext: string
}

const DATA_DIR = process.env.WAO_DATA_DIR?.trim() || path.join(process.cwd(), 'data')
const STATE_FILE = path.join(DATA_DIR, 'bootstrap-state.json')
const CONFIG_FILE = path.join(DATA_DIR, 'runtime-config.enc.json')

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(DATA_DIR, 0o700) } catch { /* best effort on bind mounts */ }
}

function atomicWrite(file: string, content: string) {
  ensureDataDir()
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, file)
  try { fs.chmodSync(file, 0o600) } catch { /* best effort on bind mounts */ }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function deriveKey(secret: string): Buffer {
  return crypto.pbkdf2Sync(secret, 'waoowaoo-runtime-config-v1', 100_000, 32, 'sha256')
}

function encryptConfig(config: RuntimeInfrastructureConfig, secret: string): EncryptedPayload {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(config), 'utf8'),
    cipher.final(),
  ])
  return {
    version: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }
}

function decryptConfig(payload: EncryptedPayload, secret: string): RuntimeInfrastructureConfig {
  if (payload.version !== 1) throw new Error('RUNTIME_CONFIG_VERSION_UNSUPPORTED')
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(payload.iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'))
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')) as RuntimeInfrastructureConfig
}

export function getBootstrapState(): BootstrapState {
  ensureDataDir()
  const existing = readJson<BootstrapState>(STATE_FILE)
  if (existing?.version === 1 && existing.setupToken && existing.nextAuthSecret && existing.apiEncryptionKey && existing.cronSecret) {
    return existing
  }
  const state: BootstrapState = {
    version: 1,
    setupToken: crypto.randomBytes(32).toString('base64url'),
    nextAuthSecret: process.env.NEXTAUTH_SECRET?.trim() || crypto.randomBytes(48).toString('base64url'),
    apiEncryptionKey: process.env.API_ENCRYPTION_KEY?.trim() || crypto.randomBytes(32).toString('hex'),
    cronSecret: process.env.CRON_SECRET?.trim() || crypto.randomBytes(32).toString('base64url'),
    // Next.js may evaluate server components during the production build. Do
    // not create a real bootstrap state or secrets inside the build artifact.
    configured: process.env.NEXT_PHASE === 'phase-production-build',
    updatedAt: new Date().toISOString(),
  }
  if (process.env.NEXT_PHASE !== 'phase-production-build') {
    atomicWrite(STATE_FILE, JSON.stringify(state, null, 2))
  }
  return state
}

export function isRuntimeConfigured(): boolean {
  const state = getBootstrapState()
  if (!state.configured || !fs.existsSync(CONFIG_FILE)) return false
  try {
    return readRuntimeConfig() !== null
  } catch {
    return false
  }
}

export function writeRuntimeConfig(config: RuntimeInfrastructureConfig) {
  const state = getBootstrapState()
  atomicWrite(CONFIG_FILE, JSON.stringify(encryptConfig(config, state.apiEncryptionKey)))
  atomicWrite(STATE_FILE, JSON.stringify({ ...state, configured: true, updatedAt: new Date().toISOString() }, null, 2))
}

export function readRuntimeConfig(): RuntimeInfrastructureConfig | null {
  const state = getBootstrapState()
  const payload = readJson<EncryptedPayload>(CONFIG_FILE)
  if (!payload) return null
  return decryptConfig(payload, state.apiEncryptionKey)
}

export function getSetupToken(): string {
  return getBootstrapState().setupToken
}

export function getGeneratedSecrets() {
  const state = getBootstrapState()
  return {
    nextAuthSecret: state.nextAuthSecret,
    apiEncryptionKey: state.apiEncryptionKey,
    cronSecret: state.cronSecret,
  }
}

export function markConfiguredForTests() {
  const state = getBootstrapState()
  atomicWrite(STATE_FILE, JSON.stringify({ ...state, configured: true, updatedAt: new Date().toISOString() }, null, 2))
}
