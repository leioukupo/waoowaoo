/**
 * API 配置读取器（配置中心严格模式）
 *
 * 规则：
 * 1) 模型唯一键必须是 provider::modelId
 * 2) 禁止 provider 猜测、静态映射、默认降级
 * 3) 运行时只从配置中心读取 provider 与密钥
 */

import { prisma } from '@/lib/prisma'
import type { StoredProvider } from '@/lib/user-api/api-config-types'
import { parseStoredProviders } from '@/lib/user-api/api-config-provider-normalization'
import { decryptApiKey } from '@/lib/crypto-utils'
import { isApiConfigCatalogProviderId } from '@/lib/ai-registry/api-config-catalog'
import { getProviderKey, parseModelKeyStrict } from '@/lib/ai-registry/selection'
import type { AiLlmProviderConfig } from '@/lib/ai-registry/types'
import { getDeploymentConfig, isPlatformProviderCredentialMode } from '@/lib/deployment/config'
import { resolveAiProviderManifest } from '@/lib/ai-providers/manifests'
import { getPlatformEnabledModels } from '@/lib/platform-models/catalog'
import type { UnifiedModelType } from '@/lib/ai-registry/types'
import { isUnifiedModelType } from '@/lib/user-api/api-config-shared'
import { AppError } from '@/lib/errors/app-error'
import {
  findRuntimeModelByKey,
  normalizeProviderRuntimeBaseUrl,
  resolveRuntimeModelSelection,
  type RuntimeModelMediaType,
  type RuntimeModelSelection,
} from '@/lib/ai-registry/runtime-selection'
import {
  filterEffectiveModels,
  hasStoredProviderCredential,
  assertSingleMediaModelSelections,
} from '@/lib/user-api/effective-config'
import type { AiProviderRouteSet } from '@/lib/ai-registry/provider-route-set'

export interface CustomModel {
  modelId: string
  modelKey: string
  name: string
  type: UnifiedModelType
  provider: string
  // Non-authoritative display field; billing uses unified server pricing catalog.
  price: number
}

export type ModelMediaType = RuntimeModelMediaType
export type ModelSelection = RuntimeModelSelection

type PlatformProviderEnv = {
  apiKey: string
  baseUrl?: string
}

function isPlainObject(value: unknown): value is object {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readEnvString(name: string): string {
  return readTrimmedString(process.env[name])
}

function getProviderFamily(providerId: string): string {
  const trimmed = providerId.trim()
  const colonIndex = trimmed.indexOf(':')
  return colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex)
}

function resolvePlatformProviderEnv(providerId: string): PlatformProviderEnv {
  const providerFamily = getProviderFamily(providerId)
  const entry = resolveAiProviderManifest(providerFamily).platformCredentials
  if (!entry) {
    throw new Error(`PLATFORM_PROVIDER_UNSUPPORTED: ${providerId}`)
  }

  const apiKey = readEnvString(`${entry.envPrefix}_API_KEY`)
  if (!apiKey) {
    throw new Error(`PLATFORM_PROVIDER_API_KEY_MISSING: ${providerId}`)
  }

  const baseUrl = readEnvString(`${entry.envPrefix}_BASE_URL`)
  if (entry.requiresBaseUrl && !baseUrl) {
    throw new Error(`PLATFORM_PROVIDER_BASE_URL_MISSING: ${providerId}`)
  }
  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  }
}

function assertModelKey(value: string, field: string): { provider: string; modelId: string; modelKey: string } {
  const parsed = parseModelKeyStrict(value)
  if (!parsed) {
    throw new Error(`MODEL_KEY_INVALID: ${field} must be provider::modelId`)
  }
  return parsed
}

function normalizeStoredModel(raw: unknown, index: number): CustomModel {
  if (!isPlainObject(raw)) {
    throw new Error(`MODEL_PAYLOAD_INVALID: customModels[${index}] must be object`)
  }

  const modelKeyRaw = readTrimmedString(Reflect.get(raw, 'modelKey'))
  const parsed = assertModelKey(modelKeyRaw, `customModels[${index}].modelKey`)

  const modelId = parsed.modelId
  const provider = parsed.provider.toLowerCase()
  if (!isApiConfigCatalogProviderId(provider)) {
    throw new Error(`MODEL_PROVIDER_UNSUPPORTED: customModels[${index}].provider`)
  }

  const typeRaw = Reflect.get(raw, 'type')
  if (!isUnifiedModelType(typeRaw)) {
    throw new Error(`MODEL_PAYLOAD_INVALID: customModels[${index}].type must be one of llm/image/video/music/voice`)
  }

  return {
    modelId,
    modelKey: `${provider}::${modelId}`,
    provider,
    type: typeRaw,
    name: readTrimmedString(Reflect.get(raw, 'name')) || modelId,
    price: 0,
  }
}

function parseCustomModels(rawModels: string | null | undefined): CustomModel[] {
  if (!rawModels) return []

  let parsedUnknown: unknown
  try {
    parsedUnknown = JSON.parse(rawModels)
  } catch {
    throw new Error('MODEL_PAYLOAD_INVALID: customModels is not valid JSON')
  }

  if (!Array.isArray(parsedUnknown)) {
    throw new Error('MODEL_PAYLOAD_INVALID: customModels must be an array')
  }

  const models: CustomModel[] = []
  for (let index = 0; index < parsedUnknown.length; index += 1) {
    models.push(normalizeStoredModel(parsedUnknown[index], index))
  }

  return models
}

function pickProviderStrict(providers: StoredProvider[], providerId: string): StoredProvider {
  const matched = providers.find((provider) => provider.id === providerId)
  if (matched) return matched

  throw new AppError('PROVIDER_AUTH_INVALID', `Provider is not configured: ${providerId}`, {
    provider: providerId,
  })
}

async function readStoredUserConfig(userId: string): Promise<{ models: CustomModel[]; providers: StoredProvider[] }> {
  const pref = await prisma.userPreference.findUnique({
    where: { userId },
    select: {
      customModels: true,
      customProviders: true,
    },
  })

  const providers = parseStoredProviders(pref?.customProviders)
  return {
    models: parseCustomModels(pref?.customModels),
    providers,
  }
}

async function readUserConfig(userId: string): Promise<{ models: CustomModel[]; providers: StoredProvider[] }> {
  const stored = await readStoredUserConfig(userId)
  assertSingleMediaModelSelections(stored.models)
  return {
    models: filterEffectiveModels(stored.models, stored.providers),
    providers: stored.providers.filter(hasStoredProviderCredential),
  }
}

async function getRuntimeModels(userId: string): Promise<CustomModel[]> {
  const deployment = getDeploymentConfig()
  if (isPlatformProviderCredentialMode(deployment)) {
    return getPlatformEnabledModels()
  }
  const { models } = await readUserConfig(userId)
  return models
}

function findModelByKey(models: CustomModel[], modelKey: string): CustomModel | null {
  return findRuntimeModelByKey(models, modelKey)
}

/**
 * 统一模型选择解析（严格模式）
 */
export async function resolveModelSelection(
  userId: string,
  model: string,
  mediaType: ModelMediaType,
): Promise<ModelSelection> {
  const models = await getRuntimeModels(userId)
  return resolveRuntimeModelSelection(models, model, mediaType)
}

/**
 * A persisted Task already owns its model identity, including custom model ids.
 * Do not resolve it through today's enabled list or substitute a catalog model.
 * The gateway still validates its provider descriptor/capabilities and current credentials.
 */
export function resolveFrozenModelSelection(
  modelKey: string,
  mediaType: ModelMediaType,
): ModelSelection {
  const identity = assertModelKey(modelKey, `${mediaType} frozen model`)
  if (!isApiConfigCatalogProviderId(identity.provider)) {
    throw new Error(`MODEL_PROVIDER_UNSUPPORTED: ${identity.provider}`)
  }
  return { ...identity, mediaType, variantSubKind: 'official' }
}

/**
 * Provider 配置
 *
 * 返回 provider 的完整连接信息（apiKey 已解密）。
 * baseUrl 为可选，不同 provider 需求不同，由调用方自行校验。
 *
 * ⚠️ 调用方必须先通过 resolveModelSelection 校验模型归属，
 * 再使用 selection.provider 调用本函数，禁止直接传入未校验的 providerId。
 */

export async function getProviderConfig(userId: string, providerId: string): Promise<AiLlmProviderConfig> {
  const deployment = getDeploymentConfig()
  if (isPlatformProviderCredentialMode(deployment)) {
    const platform = resolvePlatformProviderEnv(providerId)
    return {
      id: providerId,
      name: providerId,
      apiKey: platform.apiKey,
      baseUrl: normalizeProviderRuntimeBaseUrl(providerId, platform.baseUrl),
    }
  }

  const pref = await prisma.userPreference.findUnique({
    where: { userId },
    select: { customProviders: true },
  })
  const provider = pickProviderStrict(parseStoredProviders(pref?.customProviders), providerId)

  // OpenAI 兼容渠道（本地 vLLM/LM Studio 等）允许不带 API Key
  const isOpenAiCompat = getProviderKey(provider.id) === 'openai-compat'
  if (!provider.apiKey && !isOpenAiCompat) {
    throw new AppError('PROVIDER_AUTH_INVALID', 'Provider API key is missing', {
      provider: provider.id,
    })
  }

  return {
    id: provider.id,
    name: provider.name,
    apiKey: provider.apiKey ? decryptApiKey(provider.apiKey) : '',
    baseUrl: normalizeProviderRuntimeBaseUrl(provider.id, provider.baseUrl),
  }
}

export async function getUserModelsForExistingExecution(userId: string): Promise<CustomModel[]> {
  if (isPlatformProviderCredentialMode()) return getPlatformEnabledModels()
  return (await readStoredUserConfig(userId)).models
}

/**
 * Build a durable pre-accept failover set for equivalent OpenRouter channels.
 * The saved provider order is the channel priority; the selected channel stays
 * primary so a frozen model selection remains authoritative for the task.
 */
export async function resolveOpenRouterChannelRouteSet(
  userId: string,
  modelType: ModelMediaType,
  selected: { provider: string; modelId: string; modelKey: string },
): Promise<AiProviderRouteSet | null> {
  if (isPlatformProviderCredentialMode()) return null
  const stored = await readUserConfig(userId)
  const channelIds = stored.providers
    .filter((provider) => getProviderFamily(provider.id).toLowerCase() === 'openrouter')
    .map((provider) => provider.id)
  const candidates = channelIds.filter((providerId) => stored.models.some((model) => (
    model.type === modelType && model.modelId === selected.modelId && model.provider === providerId
  )))
  if (!candidates.includes(selected.provider) || candidates.length < 2) return null
  const ordered = [selected.provider, ...candidates.filter((providerId) => providerId !== selected.provider)]
  return {
    logicalCapabilityId: `openrouter:${modelType}:${selected.modelId}`,
    primaryModelKey: selected.modelKey,
    failoverPolicy: 'pre_accept_only',
    routes: ordered.map((provider, priority) => ({
      provider,
      modelId: selected.modelId,
      modelKey: `${provider}::${selected.modelId}`,
      priority,
    })),
  }
}

export async function getUserModels(userId: string): Promise<CustomModel[]> {
  return await getRuntimeModels(userId)
}

export async function getModelProvider(userId: string, model: string): Promise<string | null> {
  const models = await getRuntimeModels(userId)
  const matched = findModelByKey(models, model)
  return matched?.provider || null
}

export async function getModelsByType(userId: string, type: ModelMediaType): Promise<CustomModel[]> {
  const models = await getUserModels(userId)
  return models.filter((model) => model.type === type)
}

export async function resolveModelId(userId: string, model: string): Promise<string> {
  const selection = await resolveModelSelection(userId, model, 'llm')
  return selection.modelId
}

export async function getModelPrice(userId: string, model: string): Promise<number> {
  const models = await getRuntimeModels(userId)
  const matched = findModelByKey(models, model)
  if (!matched) {
    throw new Error(`MODEL_NOT_FOUND: ${model}`)
  }
  return matched.price
}

export async function hasApiConfig(userId: string): Promise<boolean> {
  if (isPlatformProviderCredentialMode()) return true

  const pref = await prisma.userPreference.findUnique({
    where: { userId },
    select: { customProviders: true },
  })

  const providers = parseStoredProviders(pref?.customProviders)
  return providers.some(hasStoredProviderCredential)
}
