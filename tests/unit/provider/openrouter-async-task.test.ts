import { describe, expect, it, vi } from 'vitest'

const queryOpenRouterVideoStatusMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ai-providers/openrouter/video', () => ({
  queryOpenRouterVideoStatus: queryOpenRouterVideoStatusMock,
}))

import { openRouterAsyncTaskProvider } from '@/lib/ai-providers/openrouter/async-task'

describe('OpenRouter async task provider channels', () => {
  it('loads the provider config for the persisted custom channel', async () => {
    queryOpenRouterVideoStatusMock.mockResolvedValueOnce({ status: 'pending' })
    let requestedProviderId = ''

    const result = await openRouterAsyncTaskProvider.poll({
      parsed: {
        provider: 'OPENROUTER',
        type: 'VIDEO',
        requestId: 'job_custom',
        providerToken: 'openrouter:third-party',
      },
      context: {
        userId: 'user-1',
        getProviderConfig: async (_userId, providerId) => {
          requestedProviderId = providerId
          return {
            id: providerId,
            name: providerId,
            apiKey: 'key',
            baseUrl: 'https://third-party.example/v1',
          }
        },
        getUserModels: async () => [],
      },
    })

    expect(requestedProviderId).toBe('openrouter:third-party')
    expect(queryOpenRouterVideoStatusMock).toHaveBeenCalledWith({
      baseUrl: 'https://third-party.example/v1',
      apiKey: 'key',
      requestId: 'job_custom',
    })
    expect(result).toEqual({ status: 'pending' })
  })

  it('rejects a provider token outside the OpenRouter family', async () => {
    await expect(openRouterAsyncTaskProvider.poll({
      parsed: {
        provider: 'OPENROUTER',
        type: 'VIDEO',
        requestId: 'job_invalid',
        providerToken: 'fal:other',
      },
      context: {
        userId: 'user-1',
        getProviderConfig: async () => {
          throw new Error('must not resolve a non-OpenRouter provider')
        },
        getUserModels: async () => [],
      },
    })).rejects.toThrow('OPENROUTER_PROVIDER_TOKEN_INVALID:fal:other')
  })
})
