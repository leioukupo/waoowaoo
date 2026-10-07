#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.env.CODEX_RUNTIME_BUILD_CONTEXT?.trim() || process.cwd()
const dataDir = process.env.WAO_DATA_DIR?.trim() || path.join(root, 'data')
const image = process.env.CODEX_RUNTIME_BUILD_IMAGE?.trim() || 'waoowaoo-codex-runtime:local'
const dockerfile = process.env.CODEX_RUNTIME_DOCKERFILE?.trim() || 'Dockerfile.codex-runtime'
const fingerprintInputs = [dockerfile, 'docker/codex-runtime/entrypoint.sh', 'LICENSE']
const stateFile = path.join(dataDir, 'codex-runtime-image.json')

function hashInputs() {
  const hash = crypto.createHash('sha256')
  for (const relative of fingerprintInputs) {
    const file = path.join(root, relative)
    hash.update(relative)
    hash.update(fs.readFileSync(file))
  }
  return hash.digest('hex')
}

function inspect() {
  try {
    const raw = execFileSync('docker', ['image', 'inspect', image, '--format', '{{json .}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeState(value) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const temporary = `${stateFile}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, stateFile)
}

const previous = (() => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return null } })()
let fingerprint = null
try {
  fingerprint = hashInputs()
  const current = inspect()
  if (
    current
    && previous?.sourceSha256 === fingerprint
    && previous.imageId === current.Id
    && current.Config?.Labels?.['wao.codex.runtime.source-sha'] === fingerprint
  ) {
    process.stdout.write(`Codex Runtime image ready: ${image} (${current.Id})\n`)
    process.exit(0)
  }

  execFileSync('docker', [
    'build', '--label', `wao.codex.runtime.source-sha=${fingerprint}`,
    '--file', path.join(root, dockerfile), '--tag', image, root,
  ], { stdio: 'inherit', env: { ...process.env, DOCKER_BUILDKIT: process.env.DOCKER_BUILDKIT || '1' } })
  const built = inspect()
  if (!built?.Id || !built.Id.startsWith('sha256:')) throw new Error('CODEX_RUNTIME_IMAGE_ID_MISSING')
  writeState({
    version: 1,
    image,
    imageId: built.Id,
    sourceSha256: fingerprint,
    sourceLabel: built.Config?.Labels?.['wao.codex.runtime.source-sha'] || null,
    builtAt: new Date().toISOString(),
  })
  process.stdout.write(`Codex Runtime image ready: ${image} (${built.Id})\n`)
} catch (error) {
  const current = inspect()
  writeState({
    version: 1,
    image,
    imageId: current?.Id || null,
    sourceSha256: typeof fingerprint === 'string' ? fingerprint : null,
    sourceLabel: current?.Config?.Labels?.['wao.codex.runtime.source-sha'] || null,
    builtAt: previous?.builtAt || null,
    error: error instanceof Error ? error.message : String(error),
    errorAt: new Date().toISOString(),
  })
  process.stderr.write(`Codex Runtime image unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
