import { openAiCompatAdapter } from '@/lib/ai-providers/openai-compat/adapter'
import { defineAiProviderManifest } from '@/lib/ai-providers/manifest'

export const openAiCompatProviderManifest = defineAiProviderManifest({
  providerKey: 'openai-compat',
  adapter: openAiCompatAdapter,
  apiConfig: {
    visibility: 'visible',
    name: 'OpenAI Compatible',
    modelTypes: ['llm'],
  },
  platformCredentials: { envPrefix: 'PLATFORM_OPENAI_COMPAT' },
  catalogs: {
    capabilities: [],
    pricing: [],
    apiConfigModels: [],
    platformModels: [],
  },
})
