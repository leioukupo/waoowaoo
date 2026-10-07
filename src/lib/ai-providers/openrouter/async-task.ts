import type { AsyncTaskProviderRegistration } from '@/lib/ai-providers/async-task-types'
import { normalizeAsyncPollResult } from '@/lib/ai-providers/async-task-types'
import { cancelOpenRouterVideoRequest } from './video-transport'
import { queryOpenRouterVideoStatus } from './video'
import {
  formatOpenRouterExternalId,
  parseOpenRouterExternalId,
} from './external-id'
import { getProviderKey } from '@/lib/ai-registry/selection'

export const openRouterAsyncTaskProvider: AsyncTaskProviderRegistration = {
  providerCode: 'OPENROUTER',
  providerKey: 'openrouter',
  canParseExternalId: (externalId) => externalId.startsWith('OPENROUTER:'),
  parseExternalId: parseOpenRouterExternalId,
  formatExternalId: (input) => {
    if (input.type !== 'VIDEO') {
      throw new Error(`OPENROUTER externalId type unsupported: ${input.type}`)
    }
    return formatOpenRouterExternalId({
      type: input.type,
      requestId: input.requestId,
      providerToken: input.providerToken,
    })
  },
  poll: async ({ parsed, context }) => {
    const providerId = parsed.providerToken?.trim() || 'openrouter'
    if (getProviderKey(providerId).toLowerCase() !== 'openrouter') {
      throw new Error(`OPENROUTER_PROVIDER_TOKEN_INVALID:${providerId}`)
    }
    const { apiKey, baseUrl } = await context.getProviderConfig(context.userId, providerId)
    if (!baseUrl) {
      throw new Error(`PROVIDER_BASE_URL_MISSING: ${providerId} (video)`)
    }
    const result = await queryOpenRouterVideoStatus({
      baseUrl,
      apiKey,
      requestId: parsed.requestId,
    })
    return normalizeAsyncPollResult({
      status: result.status,
      ...(result.status === 'failed' ? { failure: result.failure } : {}),
      videoUrl: result.videoUrl,
      resultUrl: result.resultUrl,
      downloadHeaders: result.downloadHeaders,
    })
  },
  cancel: async ({ parsed, context }) => {
    const providerId = parsed.providerToken?.trim() || 'openrouter'
    if (getProviderKey(providerId).toLowerCase() !== 'openrouter') {
      throw new Error(`OPENROUTER_PROVIDER_TOKEN_INVALID:${providerId}`)
    }
    const { apiKey, baseUrl } = await context.getProviderConfig(context.userId, providerId)
    if (!baseUrl) throw new Error(`PROVIDER_BASE_URL_MISSING: ${providerId} (video)`)
    await cancelOpenRouterVideoRequest({ baseUrl, apiKey, requestId: parsed.requestId })
  },
}
