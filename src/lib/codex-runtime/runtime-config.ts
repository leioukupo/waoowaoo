import path from 'node:path'
import { getDeploymentConfig } from '../deployment/config'
import { editionServer } from '@/lib/edition/current/server'
import { DockerRuntimeContainerAdapter } from './docker-runtime-container'
import { LocalProcessRuntimeContainerAdapter } from './local-process-runtime-container'
import type { RuntimeClientInfo, RuntimeInitializeCapabilities } from './runtime-adapter'
import type { RuntimeContainerAdapter } from './runtime-container'

export type CodexRuntimeDriver = 'local' | 'docker'

type RuntimeConfigBase = {
  readonly driver: CodexRuntimeDriver
  readonly hostRoot: string
  readonly idleTimeoutMs: number
}

export type LocalCodexRuntimeConfig = RuntimeConfigBase & {
  readonly driver: 'local'
}

export type DockerCodexRuntimeConfig = RuntimeConfigBase & {
  readonly driver: 'docker'
  readonly image: string
  readonly networkName: string
  readonly cpuLimit: number
  readonly memoryBytes: number
  readonly pidsLimit: number
  readonly localImageAttested: boolean
}

export type CodexRuntimeConfig = LocalCodexRuntimeConfig | DockerCodexRuntimeConfig

export type CodexRuntimeContainerFactoryParams = {
  readonly clientInfo: RuntimeClientInfo
  readonly processEnvironment?: NodeJS.ProcessEnv
  readonly shutdownTimeoutMs?: number
}

export const PRODUCTION_CODEX_INITIALIZE_CAPABILITIES: RuntimeInitializeCapabilities = Object.freeze({
  experimentalApi: true,
  requestAttestation: false,
  mcpServerOpenaiFormElicitation: false,
})

export function readCodexRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CodexRuntimeConfig {
  getDeploymentConfig()
  const driver = requireDriver(environment.CODEX_RUNTIME_DRIVER)
  if (
    editionServer.codexRuntime.requireDockerInProduction
    && environment.NODE_ENV === 'production'
    && driver !== 'docker'
  ) {
    throw new Error('CODEX_RUNTIME_CLOUD_REQUIRES_DOCKER')
  }
  const base: RuntimeConfigBase = {
    driver,
    hostRoot: requireHostRoot(environment.CODEX_RUNTIME_HOST_ROOT),
    idleTimeoutMs: requireInteger(
      environment.CODEX_RUNTIME_IDLE_TIMEOUT_MS,
      'CODEX_RUNTIME_IDLE_TIMEOUT_INVALID',
      10_000,
    ),
  }
  if (driver === 'local') return { ...base, driver }

  const localImageAttested = environment.CODEX_RUNTIME_IMAGE_ATTESTED === '1'

  return {
    ...base,
    driver,
    image: requireImageReference(
      environment.CODEX_RUNTIME_IMAGE,
      environment.NODE_ENV === 'production' && !localImageAttested,
      localImageAttested,
    ),
    networkName: requireNetworkName(environment.CODEX_RUNTIME_NETWORK),
    cpuLimit: requirePositiveNumber(environment.CODEX_RUNTIME_CPU_LIMIT, 'CODEX_RUNTIME_CPU_LIMIT_INVALID'),
    memoryBytes: requireInteger(
      environment.CODEX_RUNTIME_MEMORY_BYTES,
      'CODEX_RUNTIME_MEMORY_LIMIT_INVALID',
      256 * 1024 * 1024,
    ),
    pidsLimit: requireInteger(environment.CODEX_RUNTIME_PIDS_LIMIT, 'CODEX_RUNTIME_PIDS_LIMIT_INVALID', 32),
    localImageAttested,
  }
}

export function createRuntimeContainerAdapter(
  config: CodexRuntimeConfig,
  params: CodexRuntimeContainerFactoryParams,
): RuntimeContainerAdapter {
  if (config.driver === 'local') {
    return new LocalProcessRuntimeContainerAdapter({
      clientInfo: params.clientInfo,
      initializeCapabilities: PRODUCTION_CODEX_INITIALIZE_CAPABILITIES,
      shutdownTimeoutMs: params.shutdownTimeoutMs,
    })
  }
  return new DockerRuntimeContainerAdapter({
    image: config.image,
    networkName: config.networkName,
    clientInfo: params.clientInfo,
    initializeCapabilities: PRODUCTION_CODEX_INITIALIZE_CAPABILITIES,
    cpuLimit: config.cpuLimit,
    memoryBytes: config.memoryBytes,
    pidsLimit: config.pidsLimit,
    immutableImageRequired: (params.processEnvironment ?? process.env).NODE_ENV === 'production' && !config.localImageAttested,
    processEnvironment: params.processEnvironment ?? process.env,
    shutdownTimeoutMs: params.shutdownTimeoutMs,
  })
}

function requireDriver(value: string | undefined): CodexRuntimeDriver {
  if (value === 'local' || value === 'docker') return value
  throw new Error('CODEX_RUNTIME_DRIVER_REQUIRED')
}

function requireHostRoot(value: string | undefined): string {
  if (!value || value !== value.trim()) throw new Error('CODEX_RUNTIME_HOST_ROOT_REQUIRED')
  const normalized = path.normalize(value)
  if (!path.isAbsolute(normalized) || normalized === path.parse(normalized).root) {
    throw new Error('CODEX_RUNTIME_HOST_ROOT_INVALID')
  }
  return normalized
}

function requireInteger(
  value: string | undefined,
  code: string,
  minimum: number,
): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(code)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(code)
  return parsed
}

function requirePositiveNumber(value: string | undefined, code: string): number {
  if (!value) throw new Error(code)
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(code)
  return parsed
}

function requireImageReference(value: string | undefined, immutable: boolean, localImageAttested = false): string {
  if (!value || value !== value.trim() || /\s/u.test(value)) {
    throw new Error('CODEX_RUNTIME_IMAGE_DIGEST_REQUIRED')
  }
  if (localImageAttested) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(value) || value === `sha256:${'0'.repeat(64)}`) {
      throw new Error('CODEX_RUNTIME_IMAGE_ATTESTATION_INVALID')
    }
    return value
  }
  if (!immutable) return value
  if (!/^.+@sha256:[a-f0-9]{64}$/u.test(value) || value.endsWith(`@sha256:${'0'.repeat(64)}`)) {
    throw new Error('CODEX_RUNTIME_IMAGE_DIGEST_REQUIRED')
  }
  return value
}

function requireNetworkName(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)) {
    throw new Error('CODEX_RUNTIME_NETWORK_INVALID')
  }
  return value
}
