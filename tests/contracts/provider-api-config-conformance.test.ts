import { describe, expect, it } from 'vitest'
import { tryResolveAiProviderAdapter } from '@/lib/ai-providers'
import {
  isApiConfigCatalogProviderId,
  listApiConfigCatalogProviders,
  listApiConfigCatalogModels,
} from '@/lib/ai-registry/api-config-catalog'
import { AI_PROVIDER_MANIFESTS } from '@/lib/ai-providers/manifests'
import { ApiError } from '@/lib/api-errors'
import { normalizeProvidersInput } from '@/lib/user-api/api-config-provider-normalization'
import { normalizeProviderRuntimeBaseUrl } from '@/lib/ai-registry/runtime-selection'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { getDeploymentConfig } from '@/lib/deployment/config'
import {
  listProviderMediaInputContracts,
} from '@/lib/ai-exec/media-input-transport'

ensureAiCatalogsRegistered()

describe('API config provider registry conformance', () => {
  it('keeps every catalog provider executable, configurable, and platform-declared', () => {
    const catalogProviders = listApiConfigCatalogProviders()
    const catalogProviderIds = catalogProviders.map((provider) => provider.id)
    expect(new Set(catalogProviderIds).size).toBe(catalogProviderIds.length)

    const modelProviderIds = Array.from(new Set(
      listApiConfigCatalogModels().map((model) => model.provider),
    )).sort()
    expect(modelProviderIds).toEqual([...catalogProviderIds].sort())
    expect(AI_PROVIDER_MANIFESTS
      .filter((manifest) => manifest.apiConfig)
      .every((manifest) => Boolean(manifest.platformCredentials)))
      .toBe(true)
    expect(new Set(AI_PROVIDER_MANIFESTS.map((manifest) => manifest.providerKey)).size)
      .toBe(AI_PROVIDER_MANIFESTS.length)
    expect(AI_PROVIDER_MANIFESTS.every((manifest) => (
      manifest.adapter.providerKey === manifest.providerKey
    ))).toBe(true)
    expect(listProviderMediaInputContracts().every((contract) => (
      AI_PROVIDER_MANIFESTS.some((manifest) => manifest.providerKey === contract.provider)
    ))).toBe(true)
    if (getDeploymentConfig().edition === 'self-hosted') {
      expect(catalogProviders
        .filter((provider) => provider.featured)
        .map((provider) => provider.id)
        .sort())
        .toEqual(['ark', 'openrouter'])
    }

    for (const provider of catalogProviders) {
      expect(isApiConfigCatalogProviderId(provider.id)).toBe(true)
      expect(tryResolveAiProviderAdapter(provider.id)).not.toBeNull()
      expect(normalizeProviderRuntimeBaseUrl(provider.id)).toBe(provider.baseUrl)
      expect(() => normalizeProvidersInput([provider])).not.toThrow()
    }
  })

  it('continues to reject identities outside the production catalog', () => {
    try {
      normalizeProvidersInput([{ id: 'unknown-provider', name: 'Unknown' }])
      throw new Error('EXPECTED_PROVIDER_NOT_SUPPORTED')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApiError)
      const apiError = error as ApiError
      expect(apiError.code).toBe('INVALID_PARAMS')
      expect(apiError.details).toMatchObject({
        code: 'PROVIDER_NOT_SUPPORTED',
        field: 'providers[0].id',
      })
    }
  })

  it('accepts a custom OpenRouter channel while retaining its full identity', () => {
    expect(normalizeProvidersInput([{
      id: 'openrouter:third-party',
      name: 'Third-party OpenRouter',
      baseUrl: 'https://router.example/v1',
    }])).toEqual([{
      id: 'openrouter:third-party',
      name: 'Third-party OpenRouter',
      baseUrl: 'https://router.example/v1',
      apiKey: undefined,
    }])
  })
})
