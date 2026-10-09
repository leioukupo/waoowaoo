import type { ReactNode } from 'react'
import type { CustomModel, Provider } from '../types'
import type { UnifiedModelType } from '@/lib/ai-registry/types'

export interface ProviderCardDefaultModels {
  assistantModel?: string
}

export interface ChannelModelDraft {
  modelId: string
  name: string
  type: UnifiedModelType
}

export interface OpenRouterChannelDraft {
  slug: string
  name: string
  baseUrl: string
  apiKey: string
  models?: ChannelModelDraft[]
}

/** OpenAI 兼容渠道：Base URL 必填，API Key 可选（本地 vLLM/LM Studio 等可留空）。 */
export interface OpenAiCompatChannelDraft {
  slug: string
  name: string
  baseUrl: string
  apiKey: string
  models?: ChannelModelDraft[]
}

export interface ProviderCardProps {
  provider: Provider
  dragHandle?: ReactNode
  models: CustomModel[]
  allModels?: CustomModel[]
  defaultModels: ProviderCardDefaultModels
  expanded: boolean
  onExpandChange: (expanded: boolean) => void
  onUpdateApiKey: (providerId: string, apiKey: string) => void
  onUpdateBaseUrl: (providerId: string, baseUrl: string) => void
  onDeleteModel: (modelKey: string) => void
  onUpdateModel?: (modelKey: string, updates: Partial<CustomModel>) => void
  onDeleteProvider?: (providerId: string) => void
  onAddModel: (model: Omit<CustomModel, 'enabled'>) => void
}

export interface ModelFormState {
  name: string
  modelId: string
}

export type ProviderCardModelType = UnifiedModelType

export type ProviderCardGroupedModels = Partial<Record<ProviderCardModelType, CustomModel[]>>

export type ProviderCardTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string
