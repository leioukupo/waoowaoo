/**
 * API 配置类型定义和预设常量
 */
import {
    type CapabilitySelections,
    type ModelCapabilities,
    type UnifiedModelType,
} from '@/lib/ai-registry/types'
import { composeModelKey, parseModelKeyStrict } from '@/lib/ai-registry/selection'
import type { FixedParameterFieldsByModel } from '@/lib/ai-registry/fixed-parameters'
import type { WorkflowConcurrencyConfig } from '@/lib/workflow-concurrency'

export interface ApiConfigCatalogProvider {
    id: string
    name: string
    baseUrl?: string
    featured: boolean
    connectionTest: boolean
    modelTypes: UnifiedModelType[]
}

export interface ApiConfigCatalogModel {
    modelId: string
    name: string
    type: UnifiedModelType
    provider: string
    capabilities?: ModelCapabilities
}

export interface ApiConfigServerCatalog {
    providers: ApiConfigCatalogProvider[]
    models: ApiConfigCatalogModel[]
}

// 统一提供商接口
export interface Provider {
    id: string
    name: string
    baseUrl?: string
    apiKey?: string
    hasApiKey?: boolean
    featured?: boolean
    connectionTest?: boolean
    modelTypes?: UnifiedModelType[]
}

// 模型接口
export interface CustomModel {
    modelId: string       // 唯一标识符
    modelKey: string      // 唯一主键（provider::modelId）
    name: string          // 显示名称
    type: UnifiedModelType
    provider: string
    enabled: boolean
    capabilities?: ModelCapabilities
}

// API 配置响应
export interface ApiConfig {
    fixedParameterFields: FixedParameterFieldsByModel
    models: CustomModel[]
    providers: Provider[]
    catalog?: ApiConfigServerCatalog
    defaultModels?: {
        assistantModel?: string
    }
    capabilityDefaults?: CapabilitySelections
    workflowConcurrency: WorkflowConcurrencyConfig | null
    deployment?: {
        edition: 'self-hosted' | 'cloud'
        providerCredentialMode: 'user-key' | 'platform-key'
        isCloud: boolean
        usesPlatformProviderKeys: boolean
    }
}

export const API_CONFIG_PRESET_COMING_SOON_MODEL_KEYS = new Set<string>([])

export function getProviderKey(providerId?: string): string {
    if (!providerId) return ''
    const colonIndex = providerId.indexOf(':')
    return colonIndex === -1 ? providerId : providerId.slice(0, colonIndex)
}

export function encodeModelKey(provider: string, modelId: string): string {
    const modelKey = composeModelKey(provider, modelId)
    if (!modelKey) {
        throw new Error(`MODEL_KEY_INVALID: ${provider}::${modelId}`)
    }
    return modelKey
}

export function parseModelKey(key: string | undefined | null): { provider: string; modelId: string } | null {
    const parsed = parseModelKeyStrict(key)
    if (!parsed) return null
    return { provider: parsed.provider, modelId: parsed.modelId }
}

export function matchesModelKey(key: string | undefined | null, provider: string, modelId: string): boolean {
    const parsed = parseModelKeyStrict(key)
    if (!parsed) return false
    return parsed.provider === provider && parsed.modelId === modelId
}

export function isPresetComingSoonModel(provider: string, modelId: string): boolean {
    return API_CONFIG_PRESET_COMING_SOON_MODEL_KEYS.has(encodeModelKey(provider, modelId))
}

export function isPresetComingSoonModelKey(modelKey: string): boolean {
    return API_CONFIG_PRESET_COMING_SOON_MODEL_KEYS.has(modelKey)
}

const ZH_PROVIDER_NAME_MAP: Record<string, string> = {
    ark: '火山引擎 Ark',
    google: 'Google',
    fal: 'FAL',
    openrouter: 'OpenRouter',
    'openai-compat': 'OpenAI 兼容',
}

function isZhLocale(locale?: string): boolean {
    return typeof locale === 'string' && locale.toLowerCase().startsWith('zh')
}

export function resolvePresetProviderName(providerId: string, fallbackName: string, locale?: string): string {
    if (!isZhLocale(locale)) return fallbackName
    return ZH_PROVIDER_NAME_MAP[providerId] ?? fallbackName
}

export function getProviderDisplayName(providerId?: string, locale?: string): string {
    if (!providerId) return ''
    const providerKey = getProviderKey(providerId)
    if (!isZhLocale(locale)) return providerKey || providerId
    return ZH_PROVIDER_NAME_MAP[providerKey] ?? (providerKey || providerId)
}

// 教程步骤接口
export interface TutorialStep {
    text: string           // 步骤描述 (i18n key)
    url?: string           // 可选的链接地址
}

// 厂商教程接口
export interface ProviderTutorial {
    providerId: string
    steps: TutorialStep[]
}

// 厂商开通教程配置
// 注意: text 字段使用 i18n key, 翻译在 apiConfig.tutorials 下
export const PROVIDER_TUTORIALS: ProviderTutorial[] = [
    {
        providerId: 'ark',
        steps: [
            {
                text: 'ark_step1',
                url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey?apikey=%7B%7D'
            },
            {
                text: 'ark_step2',
                url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=model'
            }
        ]
    },
    {
        providerId: 'openrouter',
        steps: [
            {
                text: 'openrouter_step1',
                url: 'https://openrouter.ai/settings/keys'
            }
        ]
    },
    {
        providerId: 'fal',
        steps: [
            {
                text: 'fal_step1',
                url: 'https://fal.ai/dashboard/keys'
            }
        ]
    },
    {
        providerId: 'google',
        steps: [
            {
                text: 'google_step1',
                url: 'https://aistudio.google.com/api-keys'
            }
        ]
    },
]

/**
 * 根据厂商ID获取教程配置
 * @param providerId - 厂商ID
 * @returns 教程配置，如果不存在则返回 undefined
 */
export function getProviderTutorial(providerId: string): ProviderTutorial | undefined {
    const providerKey = getProviderKey(providerId)
    return PROVIDER_TUTORIALS.find(t => t.providerId === providerKey)
}
