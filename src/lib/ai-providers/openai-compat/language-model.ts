import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { AiProviderLanguageModelContext } from '@/lib/ai-providers/runtime-types'
import { fetchWithProviderProxy } from '@/lib/http/outbound-proxy'

export function createOpenAiCompatLanguageModel(input: AiProviderLanguageModelContext) {
  if (input.protocol !== 'openai-compatible-chat') {
    throw new Error(`LLM_PROTOCOL_PROVIDER_MISMATCH:openai-compat:${input.protocol}`)
  }
  const baseURL = input.providerConfig.baseUrl?.trim()
  if (!baseURL) throw new Error('PROVIDER_BASE_URL_MISSING: openai-compat (language-model)')
  const apiKey = input.providerConfig.apiKey?.trim()
  const provider = createOpenAICompatible({
    baseURL,
    ...(apiKey ? { apiKey } : {}),
    name: input.providerKey,
    fetch: fetchWithProviderProxy,
    includeUsage: true,
  })
  return provider.chatModel(input.selection.modelId)
}
