import type { AiProviderAdapter } from '@/lib/ai-providers/runtime-types'
import { createAiProviderFailureAdapter } from '@/lib/ai-providers/failure'
import { createOpenAiCompatLanguageModel } from './language-model'

export const openAiCompatAdapter: AiProviderAdapter = {
  providerKey: 'openai-compat',
  failure: createAiProviderFailureAdapter('openai-compat'),
  languageModel: {
    create: createOpenAiCompatLanguageModel,
  },
}
