import { CORE_AI_PROVIDER_MANIFESTS } from '@/lib/ai-providers/core-manifests'
import { MODEL_SLOT_TYPES } from '@/lib/ai-registry/media-model-selection'
import type {
  AiProviderManifest,
  AiProviderManifestExtension,
} from '@/lib/ai-providers/manifest'
import { editionAi } from '@/lib/edition/current/ai'

function validateProviderManifests(manifests: readonly AiProviderManifest[]): void {
  const providerKeys = new Set<string>()
  const asyncProviderCodes = new Set<string>()
  manifests.forEach((manifest, index) => {
    if (manifest) return
    throw new Error(
      `AI_PROVIDER_MANIFEST_UNINITIALIZED:${index}: a provider module was evaluated before the registry finished composing; provider implementations must not import registry consumers`,
    )
  })
  for (const manifest of manifests) {
    const providerKey = manifest.providerKey.trim()
    if (!providerKey || providerKey !== providerKey.toLowerCase() || providerKey.includes(':')) {
      throw new Error(`AI_PROVIDER_MANIFEST_KEY_INVALID:${manifest.providerKey}`)
    }
    if (providerKeys.has(providerKey)) {
      throw new Error(`AI_PROVIDER_MANIFEST_DUPLICATE:${providerKey}`)
    }
    providerKeys.add(providerKey)
    if (manifest.adapter.providerKey !== providerKey) {
      throw new Error(`AI_PROVIDER_MANIFEST_ADAPTER_MISMATCH:${providerKey}:${manifest.adapter.providerKey}`)
    }
    for (const task of manifest.asyncTasks ?? []) {
      if (task.providerKey !== providerKey) {
        throw new Error(`AI_PROVIDER_MANIFEST_ASYNC_MISMATCH:${providerKey}:${task.providerKey}`)
      }
      if (!task.providerCode || task.providerCode !== task.providerCode.toUpperCase()) {
        throw new Error(`AI_PROVIDER_MANIFEST_ASYNC_CODE_INVALID:${providerKey}:${task.providerCode}`)
      }
      if (asyncProviderCodes.has(task.providerCode)) {
        throw new Error(`AI_PROVIDER_MANIFEST_ASYNC_CODE_DUPLICATE:${task.providerCode}`)
      }
      asyncProviderCodes.add(task.providerCode)
    }
    if (manifest.apiConfig && !manifest.platformCredentials) {
      throw new Error(`AI_PROVIDER_MANIFEST_PLATFORM_CREDENTIALS_MISSING:${providerKey}`)
    }
    if (manifest.apiConfig?.modelTypes !== undefined) {
      if (manifest.apiConfig.modelTypes.length === 0) {
        throw new Error(`AI_PROVIDER_MANIFEST_API_CONFIG_MODEL_TYPES_EMPTY:${providerKey}`)
      }
      for (const modelType of manifest.apiConfig.modelTypes) {
        if (!MODEL_SLOT_TYPES.includes(modelType)) {
          throw new Error(`AI_PROVIDER_MANIFEST_API_CONFIG_MODEL_TYPE_INVALID:${providerKey}:${modelType}`)
        }
      }
    }
    const catalogGroups: readonly (readonly { readonly provider: string }[])[] = [
      manifest.catalogs.capabilities,
      manifest.catalogs.pricing,
      manifest.catalogs.apiConfigModels,
      manifest.catalogs.platformModels,
    ]
    for (const entries of catalogGroups) {
      for (const entry of entries) {
        if (entry.provider.split(':', 1)[0] !== providerKey) {
          throw new Error(`AI_PROVIDER_MANIFEST_CATALOG_PROVIDER_MISMATCH:${providerKey}:${entry.provider}`)
        }
      }
    }
    const mediaModalities = new Set<string>()
    for (const mediaInput of manifest.mediaInputs ?? []) {
      if (mediaModalities.has(mediaInput.modality)) {
        throw new Error(`AI_PROVIDER_MANIFEST_MEDIA_INPUT_DUPLICATE:${providerKey}:${mediaInput.modality}`)
      }
      mediaModalities.add(mediaInput.modality)
    }
  }

  for (const providerKey of editionAi.apiConfig.featuredProviderKeys) {
    const manifest = manifests.find((candidate) => candidate.providerKey === providerKey)
    if (!manifest?.apiConfig) {
      throw new Error(`AI_PROVIDER_FEATURED_MANIFEST_MISSING:${providerKey}`)
    }
  }
}

function applyManifestExtensions(
  baseManifests: readonly AiProviderManifest[],
  extensions: readonly AiProviderManifestExtension[],
): readonly AiProviderManifest[] {
  const extensionProviderKeys = new Set<string>()
  for (const extension of extensions) {
    if (extensionProviderKeys.has(extension.providerKey)) {
      throw new Error(`AI_PROVIDER_MANIFEST_EXTENSION_DUPLICATE:${extension.providerKey}`)
    }
    extensionProviderKeys.add(extension.providerKey)
    if (!baseManifests.some((manifest) => manifest.providerKey === extension.providerKey)) {
      throw new Error(`AI_PROVIDER_MANIFEST_EXTENSION_TARGET_MISSING:${extension.providerKey}`)
    }
  }
  return baseManifests.map((manifest) => {
    const extension = extensions.find((candidate) => candidate.providerKey === manifest.providerKey)
    if (!extension) return manifest
    return {
      ...manifest,
      catalogs: {
        capabilities: [
          ...manifest.catalogs.capabilities,
          ...(extension.catalogs.capabilities ?? []),
        ],
        pricing: [
          ...manifest.catalogs.pricing,
          ...(extension.catalogs.pricing ?? []),
        ],
        apiConfigModels: [
          ...manifest.catalogs.apiConfigModels,
          ...(extension.catalogs.apiConfigModels ?? []),
        ],
        platformModels: [
          ...manifest.catalogs.platformModels,
          ...(extension.catalogs.platformModels ?? []),
        ],
      },
    }
  })
}

const baseManifests = [
  ...CORE_AI_PROVIDER_MANIFESTS,
  ...editionAi.providerManifests,
] as const satisfies readonly AiProviderManifest[]

const manifests = applyManifestExtensions(
  baseManifests,
  editionAi.providerManifestExtensions,
)

validateProviderManifests(manifests)

export const AI_PROVIDER_MANIFESTS: readonly AiProviderManifest[] = manifests

export function listAiProviderManifests(): readonly AiProviderManifest[] {
  return AI_PROVIDER_MANIFESTS
}

export function resolveAiProviderManifest(providerId: string): AiProviderManifest {
  const providerKey = providerId.trim().toLowerCase().split(':', 1)[0]
  const manifest = AI_PROVIDER_MANIFESTS.find((candidate) => candidate.providerKey === providerKey)
  if (!manifest) throw new Error(`AI_PROVIDER_MANIFEST_NOT_FOUND:${providerId}`)
  return manifest
}

export function isFeaturedApiConfigProvider(providerKey: string): boolean {
  return editionAi.apiConfig.featuredProviderKeys.includes(providerKey)
}
