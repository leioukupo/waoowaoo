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
  // The OpenAI-compatible chat protocol carries image parts as image_url
  // (remote URL or base64 data URL), so vision inputs bind to both transports.
  mediaInputs: [
    { modality: 'vision', transports: { image: ['public-https', 'inline-data-url'] } },
  ],
  catalogs: {
    capabilities: [],
    pricing: [],
    apiConfigModels: [],
    platformModels: [],
  },
})
