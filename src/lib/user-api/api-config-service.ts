/**
 * 用户 API 配置管理接口
 *
 * GET  - 读取用户配置(解密)
 * PUT  - 保存/更新配置(加密)
 */

import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import { encryptApiKey } from '@/lib/crypto-utils'
import { ApiError } from '@/lib/api-errors'
import { buildApiConfigServerCatalog } from '@/lib/ai-registry/api-config-catalog'
import { getFixedParameterFieldsForModel, type FixedParameterFieldsByModel } from '@/lib/ai-registry/fixed-parameters'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { getBillingMode } from '@/lib/billing/mode'
import { getDeploymentConfig, toPublicDeploymentConfig } from '@/lib/deployment/config'
import { getDeploymentFeatures } from '@/lib/deployment/features'
import { normalizeWorkflowConcurrencyConfig } from '@/lib/workflow-concurrency'
import { getDefaultWorkflowConcurrencyConfig } from '@/lib/workflow-concurrency-env'
import type { ApiConfigPutBody, DefaultModelsPayload } from './api-config-types'
import { isRecord } from './api-config-shared'
import { parseStoredProviders, normalizeProvidersInput } from './api-config-provider-normalization'
import {
  normalizeModelList,
  parseStoredModels,
  validateBillableModelPricing,
  validateModelProviderConsistency,
  validateModelProviderTypeSupport,
} from './api-config-model-normalization'
import {
  buildPricingDisplayMap,
  resolveBuiltinCapabilities,
  withDisplayPricing,
} from './api-config-pricing-display'
import {
  normalizeDefaultModelsInput,
  normalizeWorkflowConcurrencyInput,
  sanitizeDefaultModelsAgainstModels,
  sanitizeDefaultModelsForBilling,
  sanitizeModelsForBilling,
  validateDefaultModelsAgainstModels,
  validateDefaultModelPricing,
} from './api-config-defaults'
import {
  parseStoredCapabilitySelections,
  serializeCapabilitySelections,
  validateCapabilitySelectionsAgainstModels,
} from './api-config-capability-defaults'
import {
  capabilitySelectionCommandSchema,
  capabilitySelectionCommandToSelections,
} from '@/lib/ai-registry/capability-selection-command'
import { assertUserProviderConfigurationAvailable } from './availability'
import { projectEffectiveMediaCapabilities } from '@/lib/ai-exec/media-input-transport'
import {
  filterEffectiveModels,
  hasStoredProviderCredential,
  assertSingleMediaModelSelections,
} from './effective-config'
import {
  backfillWorkspaceResourceModels,
  computeMediaModelBackfillTargets,
  hasMediaModelBackfillTargets,
} from './media-model-backfill'

function defaultModelsFromPreference(pref: { assistantModel?: string | null } | null): DefaultModelsPayload {
  return { assistantModel: pref?.assistantModel || '' }
}

export async function getUserApiConfig(userId: string) {
  ensureAiCatalogsRegistered()
  assertUserProviderConfigurationAvailable()
  const pref = await prisma.userPreference.findUnique({
    where: { userId },
    select: {
      customModels: true,
      customProviders: true,
      assistantModel: true,
      capabilityDefaults: true,
      analysisConcurrency: true,
      imageConcurrency: true,
      videoConcurrency: true,
    },
  })

  const storedProviders = parseStoredProviders(pref?.customProviders)
  const providers = storedProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    hasApiKey: hasStoredProviderCredential(provider),
  }))

  const billingMode = await getBillingMode()
  const deployment = getDeploymentConfig()
  const parsedModels = parseStoredModels(pref?.customModels)
  const models = billingMode === 'OFF' ? parsedModels : sanitizeModelsForBilling(parsedModels)
  const pricingDisplay = buildPricingDisplayMap()
  const pricedModels = models.map((model) => withDisplayPricing(model, pricingDisplay))

  const rawDefaults = defaultModelsFromPreference(pref)
  const defaultModels = billingMode === 'OFF'
    ? rawDefaults
    : sanitizeDefaultModelsForBilling(rawDefaults)
  const effectiveModels = filterEffectiveModels(models, storedProviders)
  const enabledDefaultModels = sanitizeDefaultModelsAgainstModels(defaultModels, effectiveModels)
  const capabilityDefaults = parseStoredCapabilitySelections(pref?.capabilityDefaults, 'capabilityDefaults')
  validateCapabilitySelectionsAgainstModels(capabilityDefaults, models)
  const workflowConcurrency = getDeploymentFeatures(deployment).showWorkflowConcurrency ? normalizeWorkflowConcurrencyConfig({
    analysis: pref?.analysisConcurrency,
    image: pref?.imageConcurrency,
    video: pref?.videoConcurrency,
  }, getDefaultWorkflowConcurrencyConfig()) : null

  const catalog = buildApiConfigServerCatalog({
    resolveCapabilities: (model) => projectEffectiveMediaCapabilities(
      model.type,
      `${model.provider}::${model.modelId}`,
      resolveBuiltinCapabilities(model.type, model.provider, model.modelId),
    ),
  })
  const fixedParameterFields: FixedParameterFieldsByModel = Object.fromEntries(
    [...catalog.models, ...pricedModels].map((model) => [
      `${model.provider}::${model.modelId}`,
      getFixedParameterFieldsForModel(model.type, model.provider, resolveBuiltinCapabilities(model.type, model.provider, model.modelId)),
    ]),
  )

  return {
    models: pricedModels,
    providers,
    catalog,
    fixedParameterFields,
    defaultModels: enabledDefaultModels,
    capabilityDefaults,
    workflowConcurrency,
    pricingDisplay,
    deployment: toPublicDeploymentConfig(deployment),
  }
}

export async function putUserApiConfig(
  userId: string,
  body: unknown,
  client: Pick<Prisma.TransactionClient, 'userPreference' | 'workspaceResource'> = prisma,
) {
  ensureAiCatalogsRegistered()
  assertUserProviderConfigurationAvailable()
  if (!isRecord(body)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'BODY_PARSE_FAILED',
      field: 'body',
    })
  }
  const payload = body as ApiConfigPutBody
  if (payload.workflowConcurrency !== undefined && !getDeploymentFeatures(getDeploymentConfig()).showWorkflowConcurrency) {
    throw new ApiError('FORBIDDEN', {
      code: 'WORKFLOW_CONCURRENCY_MANAGED_BY_SYSTEM',
      field: 'workflowConcurrency',
    })
  }

  const normalizedModelsInput = payload.models === undefined ? undefined : normalizeModelList(payload.models)
  const normalizedProviders = payload.providers === undefined ? undefined : normalizeProvidersInput(payload.providers)
  const normalizedDefaults = payload.defaultModels === undefined ? undefined : normalizeDefaultModelsInput(payload.defaultModels)
  const parsedCapabilityDefaults = payload.capabilityDefaults === undefined
    ? undefined
    : capabilitySelectionCommandSchema.safeParse(payload.capabilityDefaults)
  if (parsedCapabilityDefaults && !parsedCapabilityDefaults.success) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'CAPABILITY_DEFAULTS_PARSE_FAILED',
      field: 'capabilityDefaults',
      issues: parsedCapabilityDefaults.error.issues,
    })
  }
  const normalizedCapabilityDefaults = parsedCapabilityDefaults?.success
    ? capabilitySelectionCommandToSelections(parsedCapabilityDefaults.data)
    : undefined
  const normalizedWorkflowConcurrency = payload.workflowConcurrency === undefined
    ? undefined
    : normalizeWorkflowConcurrencyInput(payload.workflowConcurrency)
  const billingMode = await getBillingMode()
  const updateData: Record<string, unknown> = {}
  const existingPref = await client.userPreference.findUnique({
    where: { userId },
    select: {
      customProviders: true,
      customModels: true,
      assistantModel: true,
    },
  })
  const existingProviders = parseStoredProviders(existingPref?.customProviders)
  const existingModels = parseStoredModels(existingPref?.customModels)
  const normalizedModels = normalizedModelsInput

  const providersToSave = normalizedProviders?.map((provider) => {
    const existing = existingProviders.find((candidate) => candidate.id === provider.id)
    let finalApiKey: string | undefined
    if (provider.apiKey === undefined) {
      finalApiKey = existing?.apiKey
    } else if (provider.apiKey === '') {
      finalApiKey = undefined
    } else {
      finalApiKey = encryptApiKey(provider.apiKey)
    }

    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: finalApiKey,
    }
  })
  const nextProviders = providersToSave ?? existingProviders

  const providerSourceForValidation = nextProviders
  if (normalizedModels !== undefined) {
    assertSingleMediaModelSelections(normalizedModels)
    validateModelProviderConsistency(normalizedModels, providerSourceForValidation)
    validateModelProviderTypeSupport(normalizedModels, providerSourceForValidation)
    if (billingMode !== 'OFF') {
      validateBillableModelPricing(normalizedModels)
    }
  }

  if (normalizedModels !== undefined) {
    updateData.customModels = JSON.stringify(normalizedModels)
  }

  if (providersToSave !== undefined) {
    updateData.customProviders = JSON.stringify(providersToSave)
  }

  const existingDefaults = defaultModelsFromPreference(existingPref)
  const nextDefaults = {
    ...existingDefaults,
    ...(normalizedDefaults ?? {}),
  }
  const configuredModelSource = billingMode === 'OFF'
    ? (normalizedModels ?? existingModels)
    : sanitizeModelsForBilling(normalizedModels ?? existingModels)
  const effectiveModelSource = filterEffectiveModels(configuredModelSource, nextProviders)

  if (normalizedDefaults !== undefined) {
    validateDefaultModelsAgainstModels(normalizedDefaults, effectiveModelSource)
    if (billingMode !== 'OFF') {
      validateDefaultModelPricing(normalizedDefaults)
    }
    if (normalizedDefaults.assistantModel !== undefined) {
      updateData.assistantModel = normalizedDefaults.assistantModel || null
    }
  }

  if (normalizedModels !== undefined) {
    const cleanedDefaults = sanitizeDefaultModelsAgainstModels(nextDefaults, effectiveModelSource)
    for (const field of Object.keys(cleanedDefaults) as Array<keyof DefaultModelsPayload>) {
      const cleanedValue = cleanedDefaults[field]
      if (cleanedValue === undefined) continue
      if (nextDefaults[field] === cleanedValue) continue
      updateData[field] = cleanedValue || null
    }
  }

  if (normalizedWorkflowConcurrency !== undefined) {
    if (normalizedWorkflowConcurrency.analysis !== undefined) {
      updateData.analysisConcurrency = normalizedWorkflowConcurrency.analysis
    }
    if (normalizedWorkflowConcurrency.image !== undefined) {
      updateData.imageConcurrency = normalizedWorkflowConcurrency.image
    }
    if (normalizedWorkflowConcurrency.video !== undefined) {
      updateData.videoConcurrency = normalizedWorkflowConcurrency.video
    }
  }

  if (normalizedCapabilityDefaults !== undefined) {
    validateCapabilitySelectionsAgainstModels(normalizedCapabilityDefaults, configuredModelSource)
    updateData.capabilityDefaults = serializeCapabilitySelections(normalizedCapabilityDefaults)
  }

  await client.userPreference.upsert({
    where: { userId },
    update: updateData,
    create: { userId, ...updateData },
  })

  if (normalizedModels !== undefined) {
    const backfillTargets = computeMediaModelBackfillTargets(normalizedModels, nextProviders)
    if (hasMediaModelBackfillTargets(backfillTargets)) {
      const modelBackfill = await backfillWorkspaceResourceModels(userId, backfillTargets, client)
      return { success: true, modelBackfill }
    }
  }

  return { success: true }
}
