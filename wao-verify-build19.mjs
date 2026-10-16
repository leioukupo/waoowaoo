import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const DATA_DIR = process.env.WAO_DATA_DIR?.trim() || path.join(process.cwd(), 'data')
const state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bootstrap-state.json'), 'utf8'))
const payload = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runtime-config.enc.json'), 'utf8'))

const b64urlDecode = (value) => Buffer.from(value, 'base64url')
const deriveKey = (secret) => crypto.pbkdf2Sync(secret, 'waoowaoo-runtime-config-v1', 100_000, 32, 'sha256')

const key = deriveKey(state.apiEncryptionKey)
const decipher = crypto.createDecipheriv('aes-256-gcm', key, b64urlDecode(payload.iv))
decipher.setAuthTag(b64urlDecode(payload.tag))
const decrypted = Buffer.concat([decipher.update(b64urlDecode(payload.ciphertext)), decipher.final()])
const config = JSON.parse(decrypted.toString('utf8'))

const env = {
  ...process.env,
  DATABASE_URL: config.databaseUrl,
  NEXTAUTH_SECRET: state.nextAuthSecret,
  API_ENCRYPTION_KEY: state.apiEncryptionKey,
}
const result = spawnSync('./node_modules/.bin/tsx', ['wao-verify-build19.ts'], {
  cwd: '/app',
  stdio: 'inherit',
  env,
})
process.exit(result.status ?? 1)
