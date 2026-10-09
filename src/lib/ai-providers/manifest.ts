import type { AiProviderAdapter } from '@/lib/ai-providers/runtime-types'
import type { AsyncTaskProviderRegistration } from '@/lib/ai-providers/async-task-types'
import type { ProviderMediaInputTransport } from '@/lib/deployment/config'
import type { PlatformModelPreset } from '@/lib/platform-models/types'
import type { ApiConfigCatalogModel } from '@/lib/ai-registry/api-config-catalog'
import type { UnifiedModelType } from '@/lib/ai-registry/types'
import type { PricingApiType } from '@/lib/ai-registry/pricing-catalog'

export type ProviderMediaInputKind = 'image' | 'audio' | 'video'
export type ProviderMediaInputModality = 'vision' | 'image' | 'video'

export interface ProviderMediaInputDeclaration {
  readonly modality: ProviderMediaInputModality
  readonly transports: Readonly<Partial<Record<ProviderMediaInputKind, readonly ProviderMediaInputTransport[]>>>
}

// Catalog declarations are deliberately narrower than their normalized runtime
// values. Each catalog owns validation of its nested schema; the Manifest owns
// the shared provider/model identity and the complete set of declarations.
export interface ProviderCapabilityCatalogDeclaration {
  readonly provider: string
  readonly modelType: UnifiedModelType
  readonly modelId: string
  readonly capabilities?: unknown
  readonly providerRoute?: unknown
}

export interface ProviderPricingCatalogDeclaration {
  readonly provider: string
  readonly apiType: PricingApiType
  readonly modelId: string
  readonly cost: unknown
  readonly retail?: unknown
}

export interface AiProviderManifest {
  readonly providerKey: string
  readonly adapter: AiProviderAdapter
  readonly apiConfig?: {
    /** Controls discovery UI only; retained configurations and tasks remain executable. */
    readonly visibility: 'visible' | 'hidden'
    readonly name: string
    readonly baseUrl?: string
    /**
     * Model modalities user channels under this provider may store. Defaults
     * to the union of the apiConfigModels catalog when omitted.
     */
    readonly modelTypes?: readonly UnifiedModelType[]
  }
  readonly platformCredentials?: {
    readonly envPrefix: string
    readonly requiresBaseUrl?: boolean
  }
  readonly asyncTasks?: readonly AsyncTaskProviderRegistration[]
  readonly catalogs: {
    readonly capabilities: readonly ProviderCapabilityCatalogDeclaration[]
    readonly pricing: readonly ProviderPricingCatalogDeclaration[]
    readonly apiConfigModels: readonly ApiConfigCatalogModel[]
    readonly platformModels: readonly PlatformModelPreset[]
  }
  readonly mediaInputs?: readonly ProviderMediaInputDeclaration[]
}

export interface AiProviderManifestExtension {
  readonly providerKey: string
  readonly catalogs: {
    readonly capabilities?: readonly ProviderCapabilityCatalogDeclaration[]
    readonly pricing?: readonly ProviderPricingCatalogDeclaration[]
    readonly apiConfigModels?: readonly ApiConfigCatalogModel[]
    readonly platformModels?: readonly PlatformModelPreset[]
  }
}

export function defineAiProviderManifest<const T extends AiProviderManifest>(manifest: T): T {
  return manifest
}
