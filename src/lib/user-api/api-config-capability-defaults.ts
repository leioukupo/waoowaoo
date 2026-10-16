import { ApiError } from '@/lib/api-errors'
import { parseModelKeyStrict } from '@/lib/ai-registry/selection'
import { getProviderKey } from '@/lib/ai-registry/selection'
import { resolveBuiltinModelContext, validateCapabilitySelectionsPayload } from '@/lib/ai-registry/capabilities-catalog'
import { getFixedParameterFields } from '@/lib/ai-registry/fixed-parameters'
import { isReasoningEffort, REASONING_EFFORT_VALUES } from '@/lib/ai-registry/reasoning-effort'
import type { CapabilitySelections, CapabilityValue } from '@/lib/ai-registry/types'
import type { StoredModel } from './api-config-types'
import { CAPABILITY_MODEL_TYPES } from './api-config-types'
import { isRecord } from './api-config-shared'

export function normalizeCapabilitySelectionsInput(
  raw: unknown,
): CapabilitySelections {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'CAPABILITY_SELECTION_INVALID',
      field: 'capabilityDefaults',
    })
  }

  const normalized: CapabilitySelections = {}
  for (const [modelKey, rawSelection] of Object.entries(raw)) {
    if (!isRecord(rawSelection)) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'CAPABILITY_SELECTION_INVALID',
        field: `capabilityDefaults.${modelKey}`,
      })
    }

    const selection: Record<string, string | number | boolean> = {}
    for (const [field, value] of Object.entries(rawSelection)) {
      if (field === 'aspectRatio') {
        throw new ApiError('INVALID_PARAMS', {
          code: 'CAPABILITY_FIELD_INVALID',
          field: `capabilityDefaults.${modelKey}.${field}`,
        })
      }
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new ApiError('INVALID_PARAMS', {
          code: 'CAPABILITY_SELECTION_INVALID',
          field: `capabilityDefaults.${modelKey}.${field}`,
        })
      }
      selection[field] = value
    }

    if (Object.keys(selection).length > 0) {
      normalized[modelKey] = selection
    }
  }

  return normalized
}

export function parseStoredCapabilitySelections(raw: string | null | undefined, field: string): CapabilitySelections {
  if (!raw) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiError('INVALID_PARAMS', {
      code: 'CAPABILITY_SELECTION_INVALID',
      field,
    })
  }

  return normalizeCapabilitySelectionsInput(parsed)
}

export function serializeCapabilitySelections(selections: CapabilitySelections): string | null {
  if (Object.keys(selections).length === 0) return null
  return JSON.stringify(selections)
}

function buildStoredModelMap(models: StoredModel[]): Map<string, StoredModel> {
  const modelMap = new Map<string, StoredModel>()
  for (const model of models) {
    modelMap.set(model.modelKey, model)
  }
  return modelMap
}

function resolveCapabilityContextForModelKey(
  modelMap: Map<string, StoredModel>,
  modelKey: string,
) {
  const model = modelMap.get(modelKey)
  if (model) {
    return resolveBuiltinModelContext(model.type, model.modelKey) || null
  }

  if (!parseModelKeyStrict(modelKey)) return null
  for (const modelType of CAPABILITY_MODEL_TYPES) {
    const context = resolveBuiltinModelContext(modelType, modelKey)
    if (context) return context
  }
  return null
}

function isOpenAiCompatModelKey(modelKey: string): boolean {
  const parsed = parseModelKeyStrict(modelKey)
  return !!parsed && getProviderKey(parsed.provider).toLowerCase() === 'openai-compat'
}

// OpenAI-compatible LLM models are outside the builtin capability catalog, so
// they are validated against the single application-owned field instead of
// the catalog payload validator (which would report CAPABILITY_MODEL_UNSUPPORTED).
function validateOpenAiCompatLlmSelection(modelKey: string, selection: Record<string, CapabilityValue>) {
  for (const [field, value] of Object.entries(selection)) {
    if (field !== 'reasoningEffort') {
      throw new ApiError('INVALID_PARAMS', {
        code: 'CAPABILITY_FIELD_INVALID',
        field: `capabilityDefaults.${modelKey}.${field}`,
      })
    }
    if (!isReasoningEffort(value)) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'CAPABILITY_VALUE_NOT_ALLOWED',
        field: `capabilityDefaults.${modelKey}.${field}`,
        allowedValues: [...REASONING_EFFORT_VALUES],
      })
    }
  }
}

export function validateCapabilitySelectionsAgainstModels(
  selections: CapabilitySelections,
  models: StoredModel[],
) {
  const modelMap = buildStoredModelMap(models)
  for (const [modelKey, selection] of Object.entries(selections)) {
    if (isOpenAiCompatModelKey(modelKey)) {
      validateOpenAiCompatLlmSelection(modelKey, selection)
      continue
    }
    const context = resolveCapabilityContextForModelKey(modelMap, modelKey)
    if (!context) continue
    const fixedFields = new Set(getFixedParameterFields(context.modelType, context.capabilities).map(({ field }) => field))
    for (const field of Object.keys(selection)) {
      if (!fixedFields.has(field)) {
        throw new ApiError('INVALID_PARAMS', { code: 'CAPABILITY_FIELD_INVALID', field: `capabilityDefaults.${modelKey}.${field}` })
      }
    }
  }
  const catalogSelections: CapabilitySelections = {}
  for (const [modelKey, selection] of Object.entries(selections)) {
    if (!isOpenAiCompatModelKey(modelKey)) catalogSelections[modelKey] = selection
  }
  const issues = validateCapabilitySelectionsPayload(
    catalogSelections,
    (modelKey) => resolveCapabilityContextForModelKey(modelMap, modelKey),
  )

  if (issues.length > 0) {
    const firstIssue = issues[0]
    throw new ApiError('INVALID_PARAMS', {
      code: firstIssue.code,
      field: firstIssue.field,
      allowedValues: firstIssue.allowedValues,
    })
  }
}
