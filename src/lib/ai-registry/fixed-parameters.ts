import { getCapabilityOptionFields } from './capabilities-catalog'
import { REASONING_EFFORT_VALUES } from './reasoning-effort'
import { getProviderKey } from './selection'
import type { CapabilityValue, ModelCapabilities, UnifiedModelType } from './types'

/** Application-owned parameter policy; providers supply the allowed values. */
export const FIXABLE_CAPABILITY_FIELDS = {
  llm: ['reasoningEffort'],
  image: ['resolution', 'quality'],
  video: ['resolution', 'generateAudio'],
  music: [],
  voice: [],
} as const satisfies Record<UnifiedModelType, readonly string[]>

export interface FixedParameterField {
  readonly field: string
  readonly options: readonly CapabilityValue[]
  readonly allowUnset: boolean
  readonly defaultValue?: CapabilityValue
}

export type FixedParameterFieldsByModel = Record<string, readonly FixedParameterField[]>

/**
 * Per-model variant that accounts for the declaring provider. User-defined
 * OpenAI-compatible channels declare no capability catalog entries, yet their
 * LLM models generally accept the standard reasoning parameter, so they get
 * a single application-owned field (pinned from the API config page).
 */
export function getFixedParameterFieldsForModel(
  modelType: UnifiedModelType,
  provider: string,
  capabilities: ModelCapabilities | undefined,
): FixedParameterField[] {
  if (
    modelType === 'llm'
    && getProviderKey(provider).toLowerCase() === 'openai-compat'
    && !getCapabilityOptionFields(modelType, capabilities)['reasoningEffort']?.length
  ) {
    return [{
      field: 'reasoningEffort',
      options: REASONING_EFFORT_VALUES,
      allowUnset: true,
      defaultValue: 'low',
    }]
  }
  return getFixedParameterFields(modelType, capabilities)
}

export function getFixedParameterFields(
  modelType: UnifiedModelType,
  capabilities: ModelCapabilities | undefined,
): FixedParameterField[] {
  const options = getCapabilityOptionFields(modelType, capabilities)
  return FIXABLE_CAPABILITY_FIELDS[modelType].flatMap((field): FixedParameterField[] => {
    if (!options[field]?.length) return []
    if (modelType === 'llm') {
      const defaultValue = capabilities?.llm?.defaultReasoningEffort
      if (defaultValue === undefined || !options[field].includes(defaultValue)) {
        throw new Error('LLM_DEFAULT_REASONING_EFFORT_REQUIRED')
      }
      return [{ field, options: options[field], allowUnset: false, defaultValue }]
    }
    return [{ field, options: options[field], allowUnset: true }]
  })
}
