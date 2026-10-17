import { parseModelKeyStrict } from '@/lib/ai-registry/selection'
import type { CapabilityValue } from '@/lib/ai-registry/types'
import {
  findBuiltinPricingCatalogEntriesByModelId,
  findBuiltinPricingCatalogEntry,
  type BuiltinPricingCatalogEntry,
  type BuiltinPricingDefinition,
  type BuiltinPricingTier,
  type PricingApiType,
  type PricingFace,
} from './pricing-catalog'

export interface PricingResolutionResolved {
  status: 'resolved'
  entry: BuiltinPricingCatalogEntry
  /** Amount on the requested face: credits for `retail`, CNY for `cost`. */
  amount: number
  face: PricingFace
  mode: 'flat' | 'capability'
  unit?: BuiltinPricingDefinition['unit']
  tier?: BuiltinPricingTier
}

export interface PricingResolutionNotConfigured {
  status: 'not_configured'
}

export interface PricingResolutionAmbiguousModel {
  status: 'ambiguous_model'
  apiType: PricingApiType
  modelId: string
  candidates: BuiltinPricingCatalogEntry[]
}

export interface PricingResolutionMissingCapabilityMatch {
  status: 'missing_capability_match'
  entry: BuiltinPricingCatalogEntry
  selections: Record<string, CapabilityValue>
}

export type PricingResolution =
  | PricingResolutionResolved
  | PricingResolutionNotConfigured
  | PricingResolutionAmbiguousModel
  | PricingResolutionMissingCapabilityMatch

function cloneSelections(raw: Record<string, CapabilityValue> | undefined): Record<string, CapabilityValue> {
  if (!raw) return {}
  const next: Record<string, CapabilityValue> = {}
  for (const [field, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      next[field] = value
    }
  }
  return next
}

function matchTier(
  definition: BuiltinPricingDefinition,
  selections: Record<string, CapabilityValue>,
): BuiltinPricingTier | null {
  const tiers = definition.tiers || []
  for (const tier of tiers) {
    const matched = Object.entries(tier.when).every(([field, expectedValue]) => selections[field] === expectedValue)
    if (matched) return tier
  }
  return null
}

type EntryResolution =
  | { status: 'resolved'; entry: BuiltinPricingCatalogEntry }
  | PricingResolutionNotConfigured
  | PricingResolutionAmbiguousModel

function resolveEntryByModel(apiType: PricingApiType, model: string): EntryResolution {
  const parsed = parseModelKeyStrict(model)
  if (parsed) {
    const exact = findBuiltinPricingCatalogEntry(apiType, parsed.provider, parsed.modelId)
    if (exact) return { status: 'resolved', entry: exact }
    return { status: 'not_configured' }
  }

  const candidates = findBuiltinPricingCatalogEntriesByModelId(apiType, model)
  if (candidates.length === 0) return { status: 'not_configured' }
  if (candidates.length > 1) {
    return { status: 'ambiguous_model', apiType, modelId: model, candidates }
  }
  return { status: 'resolved', entry: candidates[0] }
}

/**
 * Resolve one model's price.
 *
 * `face` selects which side of the entry is wanted. Billing always asks for
 * `retail` (credits); margin reporting asks for `cost` (CNY). Both faces share
 * the same tier shape, so a selection that resolves on one resolves on the
 * other.
 */
export function resolveBuiltinPricing(input: {
  apiType: PricingApiType
  model: string
  face: PricingFace
  selections?: Record<string, CapabilityValue>
}): PricingResolution {
  const entryResolution = resolveEntryByModel(input.apiType, input.model)
  if (entryResolution.status !== 'resolved') return entryResolution

  const { entry } = entryResolution
  const definition = input.face === 'cost' ? entry.cost : entry.retail

  if (definition.mode === 'flat') {
    const amount = definition.flatAmount
    if (typeof amount !== 'number') {
      return { status: 'missing_capability_match', entry, selections: cloneSelections(input.selections) }
    }
    return { status: 'resolved', entry, amount, face: input.face, mode: 'flat', unit: definition.unit }
  }

  const selections = cloneSelections(input.selections)
  const tier = matchTier(definition, selections)
  if (tier === null) {
    return { status: 'missing_capability_match', entry, selections }
  }
  return {
    status: 'resolved',
    entry,
    amount: tier.amount,
    face: input.face,
    mode: 'capability',
    unit: definition.unit,
    tier,
  }
}

/**
 * Built-in pricing catalog version stamped onto billing records for
 * traceability. Bump it whenever a registered price changes semantically.
 */
export const BUILTIN_PRICING_VERSION = '2026-10-17'
