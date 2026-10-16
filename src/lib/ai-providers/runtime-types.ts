import type { LanguageModel, ModelMessage } from 'ai'
import type {
  AiLlmExecutionResult,
  AiLlmMessage,
  AiLlmProtocol,
  AiPublicReasoningMode,
  AiResolvedSelection,
  AiVariantDescriptor,
  AiLlmProviderConfig,
} from '@/lib/ai-registry/types'
import type { ReasoningEffort } from '@/lib/ai-registry/reasoning-effort'
import type { ExternalOperationId } from '@/lib/external-operation/registry'
import type { FailureRecord } from '@/lib/errors/failure'
import type { MusicCompositionPlan } from '@/lib/music/composition-plan'

export type GenerateResult = {
  readonly success: true
  imageUrl?: string
  imageUrls?: string[]
  imageBase64?: string
  videoUrl?: string
  audioUrl?: string
  audioBase64?: string
  audioMimeType?: string
  metadata?: Record<string, unknown>
  requestId?: string
  async?: boolean
  endpoint?: string
  externalId?: string
}

export type AiProviderFailurePhase =
  | 'submit'
  | 'poll'
  | 'cancel'
  | 'result'
  | 'stream'
  | 'connection'
  | 'search'

export type AiProviderFailureNormalizationInput = {
  readonly error: unknown
  readonly phase: AiProviderFailurePhase
  readonly operation?: ExternalOperationId
  readonly attempts?: number
}

export type AiProviderFailureAdapter = {
  readonly providerKey: string
  readonly normalize: (input: AiProviderFailureNormalizationInput) => FailureRecord
}

export type AiProviderLanguageModelContext = {
  providerKey: string
  selection: {
    provider: string
    modelId: string
    modelKey: string
  }
  providerConfig: AiLlmProviderConfig
  protocol: AiLlmProtocol
  publicReasoningMode: AiPublicReasoningMode
  executionMode: 'sync' | 'stream' | 'vision'
  reasoning: boolean
  reasoningEffort: ReasoningEffort
  messages?: AiLlmMessage[]
  openRouterSessionId?: string
}

export type AiProviderLanguageModelRequestContext = Omit<
  AiProviderLanguageModelContext,
  'protocol' | 'publicReasoningMode'
>
export type AiProviderLanguageModelValidationContext = Pick<
  AiProviderLanguageModelContext,
  'executionMode'
>

export type AiProviderImageExecutionContext = {
  userId: string
  providerConfig: AiLlmProviderConfig
  selection: AiResolvedSelection & {
    provider: string
    modelId: string
    modelKey: string
  }
  prompt: string
  options?: {
    referenceImages?: string[]
    aspectRatio?: string
    resolution?: string
    outputFormat?: string
    keepOriginalAspectRatio?: boolean
    size?: string
    quality?: string
    responseFormat?: string
    background?: string
    outputCompression?: number
    moderation?: string
    [key: string]: unknown
  }
}

export type AiProviderVideoExecutionContext = {
  userId: string
  providerConfig: AiLlmProviderConfig
  selection: AiResolvedSelection & {
    provider: string
    modelId: string
    modelKey: string
  }
  imageUrl: string
  options?: {
    prompt?: string
    duration?: number
    resolution?: string
    aspectRatio?: string
    generateAudio?: boolean
    lastFrameImageUrl?: string
    referenceImages?: string[]
    referenceAudios?: string[]
    referenceVideos?: string[]
    [key: string]: unknown
  }
}

export type AiProviderMusicExecutionContext = {
  userId: string
  providerConfig: AiLlmProviderConfig
  selection: AiResolvedSelection & {
    provider: string
    modelId: string
    modelKey: string
  }
  generation:
    | { readonly kind: 'prompt'; readonly prompt: string }
    | { readonly kind: 'composition_plan'; readonly compositionPlan: MusicCompositionPlan }
  options?: {
    negativePrompt?: string
    durationSeconds?: number
    vocalMode?: 'instrumental' | 'vocal'
    genre?: string
    mood?: string
    bpm?: number
    outputFormat?: 'mp3' | 'wav'
    [key: string]: unknown
  }
}

export type AiProviderVoiceExecutionContext = {
  userId: string
  providerConfig: AiLlmProviderConfig
  selection: AiResolvedSelection & {
    provider: string
    modelId: string
    modelKey: string
  }
  description: string
  text: string
  options?: {
    language?: string
    [key: string]: unknown
  }
}

export type AiProviderMediaModalityAdapter<M extends 'image' | 'video' | 'music' | 'voice'> = {
  describe: (selection: AiResolvedSelection) => AiVariantDescriptor
  execute: (
    input: M extends 'image'
      ? AiProviderImageExecutionContext
      : M extends 'video'
        ? AiProviderVideoExecutionContext
        : M extends 'music'
          ? AiProviderMusicExecutionContext
          : AiProviderVoiceExecutionContext,
  ) => Promise<GenerateResult>
}

export type AiProviderLanguageModelAdapter = {
  create: (input: AiProviderLanguageModelContext) => LanguageModel
  prepareTextMessages?: (messages: AiLlmMessage[]) => ModelMessage[]
  validateResult?: (
    result: AiLlmExecutionResult,
    context: AiProviderLanguageModelValidationContext,
  ) => void
}

export type AiProviderLlmSessionContext = {
  kind: 'llm' | 'vision'
  userId: string
  projectId?: string
  action?: string
  modelKey: string
  explicitSessionId?: string
}

export type AiProviderConnectionTestStepName = 'models' | 'textGen' | 'imageGen' | 'musicGen' | 'credits' | 'wire'

export type AiProviderConnectionTestMessageKey =
  | 'connectionTest.authInvalid'
  | 'connectionTest.emptyResponse'
  | 'connectionTest.modelsOk'
  | 'connectionTest.networkError'
  | 'connectionTest.providerError'
  | 'connectionTest.rateLimited'
  | 'connectionTest.skippedModelsFailure'
  | 'connectionTest.responsesSupported'
  | 'connectionTest.skippedSpend'
  | 'connectionTest.chatOnly'
  | 'connectionTest.textGenerationOk'
  | 'connectionTest.wireUnknown'
  | 'connectionTest.timeout'

export type AiProviderConnectionTestStep = {
  name: AiProviderConnectionTestStepName
  status: 'pass' | 'fail' | 'skip'
  messageKey: AiProviderConnectionTestMessageKey
  model?: string
  diagnostic?: string
}

export type AiProviderConnectionTestReport = {
  success: boolean
  steps: AiProviderConnectionTestStep[]
}

export type AiProviderLlmConnectionInput = {
  apiKey: string
  baseUrl?: string
  model?: string
}

export type AiProviderLlmConnectionResult = {
  model?: string
  answer?: string
}

export type AiProviderConnectionTester = {
  testLlm?: (input: AiProviderLlmConnectionInput) => Promise<AiProviderLlmConnectionResult>
  diagnose: (input: { apiKey: string; baseUrl?: string; llmModel?: string }) => Promise<AiProviderConnectionTestReport>
}

export interface AiProviderAdapter {
  readonly providerKey: string
  readonly failure: AiProviderFailureAdapter
  image?: AiProviderMediaModalityAdapter<'image'>
  video?: AiProviderMediaModalityAdapter<'video'>
  music?: AiProviderMediaModalityAdapter<'music'>
  voice?: AiProviderMediaModalityAdapter<'voice'>
  languageModel?: AiProviderLanguageModelAdapter
  resolveLlmSessionId?: (input: AiProviderLlmSessionContext) => string | undefined
  connectionTest?: AiProviderConnectionTester
}
