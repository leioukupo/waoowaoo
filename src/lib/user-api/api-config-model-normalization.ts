import { ApiError } from '@/lib/api-errors'
import { composeModelKey, parseModelKeyStrict } from '@/lib/ai-registry/selection'
import { findBuiltinPricingCatalogEntry, type PricingApiType } from '@/lib/ai-registry/pricing-catalog'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import type { StoredModel, StoredProvider } from './api-config-types'
import { getProviderKey, isRecord, isUnifiedModelType, readTrimmedString } from './api-config-shared'
import { resolveProviderByIdOrKey } from './api-config-provider-normalization'
import { resolveBuiltinCapabilities } from './api-config-pricing-display'
import { projectEffectiveMediaCapabilities } from '@/lib/ai-exec/media-input-transport'
import { listApiConfigCatalogProviders } from '@/lib/ai-registry/api-config-catalog'

const BILLABLE_MODEL_TYPE_TO_PRICING_API_TYPE: Readonly<Record<StoredModel['type'], PricingApiType | null>> = {
  llm: 'text',
  image: 'image',
  video: 'video',
  music: 'music',
  voice: 'voice',
}

export function withBuiltinCapabilities(model: StoredModel): StoredModel {
  ensureAiCatalogsRegistered()
  const capabilities = resolveBuiltinCapabilities(model.type, model.provider, model.modelId)
  if (!capabilities) {
    return {
      ...model,
      capabilities: undefined,
    }
  }

  return {
    ...model,
    capabilities: projectEffectiveMediaCapabilities(model.type, model.modelKey, capabilities),
  }
}

function normalizeStoredModel(raw: unknown, index: number): StoredModel {
  if (!isRecord(raw)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MODEL_PAYLOAD_INVALID',
      field: `models[${index}]`,
    })
  }

  const modelType = raw.type
  if (!isUnifiedModelType(modelType)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MODEL_TYPE_INVALID',
      field: `models[${index}].type`,
    })
  }

  const providerFromField = readTrimmedString(raw.provider)
  const modelIdFromField = readTrimmedString(raw.modelId)
  const modelKeyFromField = readTrimmedString(raw.modelKey)
  const parsedModelKey = parseModelKeyStrict(modelKeyFromField)

  const provider = (providerFromField || parsedModelKey?.provider || '').toLowerCase()
  const modelId = modelIdFromField || parsedModelKey?.modelId || ''
  const modelKey = composeModelKey(provider, modelId)

  if (!modelKey) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MODEL_KEY_INVALID',
      field: `models[${index}].modelKey`,
    })
  }
  if (modelKeyFromField && (!parsedModelKey || composeModelKey(parsedModelKey.provider.toLowerCase(), parsedModelKey.modelId) !== modelKey)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MODEL_KEY_MISMATCH',
      field: `models[${index}].modelKey`,
    })
  }

  if (raw.customPricing !== undefined) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MODEL_CUSTOM_PRICING_UNSUPPORTED',
      field: `models[${index}].customPricing`,
    })
  }

  const modelName = readTrimmedString(raw.name) || modelId

  return {
    modelId,
    modelKey,
    name: modelName,
    type: modelType,
    provider,
    price: 0,
  }
}

export function normalizeModelList(rawModels: unknown): StoredModel[] {
  if (rawModels === undefined) return []
  if (!Array.isArray(rawModels)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MODEL_PAYLOAD_INVALID',
      field: 'models',
    })
  }

  return rawModels.map((item, index) => normalizeStoredModel(item, index))
}

export function validateModelProviderConsistency(models: StoredModel[], providers: StoredProvider[]) {
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]
    const matchedProvider = resolveProviderByIdOrKey(providers, model.provider)
    if (!matchedProvider) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'MODEL_PROVIDER_NOT_FOUND',
        field: `models[${index}].provider`,
      })
    }
  }
}

export function validateModelProviderTypeSupport(models: StoredModel[], providers: StoredProvider[]) {
  const catalogProviders = listApiConfigCatalogProviders()
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]
    const configuredProvider = resolveProviderByIdOrKey(providers, model.provider)
    const providerKey = getProviderKey(configuredProvider?.id ?? model.provider)
    const catalogProvider = catalogProviders.find((provider) => provider.id === providerKey)
    if (catalogProvider?.modelTypes.includes(model.type)) continue
    throw new ApiError('INVALID_PARAMS', {
      code: 'MODEL_PROVIDER_TYPE_UNSUPPORTED',
      field: `models[${index}].type`,
      providerId: model.provider,
      modelType: model.type,
    })
  }
}

export function hasBuiltinPricingForModel(apiType: PricingApiType, provider: string, modelId: string): boolean {
  ensureAiCatalogsRegistered()
  // findBuiltinPricingCatalogEntry handles providerKey stripping and alias fallback internally
  return !!findBuiltinPricingCatalogEntry(apiType, provider, modelId)
}

export function validateBillableModelPricing(models: StoredModel[]) {
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]
    const apiType = BILLABLE_MODEL_TYPE_TO_PRICING_API_TYPE[model.type]
    if (!apiType) continue

    if (!hasBuiltinPricingForModel(apiType, model.provider, model.modelId)) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'MODEL_PRICING_NOT_CONFIGURED',
        field: `models[${index}].modelId`,
        modelKey: model.modelKey,
        apiType,
      })
    }
  }
}

export function parseStoredModels(rawModels: string | null | undefined): StoredModel[] {
  if (!rawModels) return []
  let parsedUnknown: unknown
  try {
    parsedUnknown = JSON.parse(rawModels)
  } catch {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MODEL_PAYLOAD_INVALID',
      field: 'customModels',
    })
  }
  if (!Array.isArray(parsedUnknown)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MODEL_PAYLOAD_INVALID',
      field: 'customModels',
    })
  }
  const normalized: StoredModel[] = []
  for (let index = 0; index < parsedUnknown.length; index += 1) {
    normalized.push(withBuiltinCapabilities(normalizeStoredModel(parsedUnknown[index], index)))
  }
  return normalized
}
