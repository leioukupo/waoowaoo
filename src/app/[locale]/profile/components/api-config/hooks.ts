'use client'
import { logError as _ulogError } from '@/lib/logging/core'
import { useLocale, useTranslations } from 'next-intl'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
    Provider,
    CustomModel,
    encodeModelKey,
    getProviderKey,
    isPresetComingSoonModelKey,
    resolvePresetProviderName,
} from './types'
import type { OpenRouterChannelDraft } from './provider-card/types'
import type { CapabilitySelections, UnifiedModelType } from '@/lib/ai-registry/types'
import type { WorkflowConcurrencyConfig } from '@/lib/workflow-concurrency'
import { useApiConfigSaver } from './editor'
import type { ApiConfigSaveError } from './editor'
import { useUserApiConfigQuery } from './query'
import { useToast } from '@/contexts/ToastContext'
import {
    clearMissingDefaultModels,
    createInitialModels,
    createInitialProviders,
    mergeModelsForDisplay,
    mergeProvidersForDisplay,
    composeOpenRouterChannelId,
    normalizeOpenRouterChannelSlug,
    parseWorkflowConcurrency,
    replaceDefaultModelKey,
    type DefaultModels,
} from './selectors'

export { mergeProvidersForDisplay } from './selectors'

interface UseProvidersReturn {
    fixedParameterFields: import('@/lib/ai-registry/fixed-parameters').FixedParameterFieldsByModel
    providers: Provider[]
    models: CustomModel[]
    defaultModels: DefaultModels
    workflowConcurrency: WorkflowConcurrencyConfig | null
    capabilityDefaults: CapabilitySelections
    loading: boolean
    saveStatus: 'idle' | 'saving' | 'saved' | 'error'
    saveError: ApiConfigSaveError | null
    flushConfig: () => Promise<void>
    addOpenRouterChannel: (draft: OpenRouterChannelDraft) => boolean
    updateProviderApiKey: (providerId: string, apiKey: string) => void
    updateProviderBaseUrl: (providerId: string, baseUrl: string) => void
    reorderProviders: (activeProviderId: string, overProviderId: string) => void
    deleteProvider: (providerId: string) => void
    selectSlotModel: (type: UnifiedModelType, modelKey: string) => void
    updateModel: (modelKey: string, updates: Partial<CustomModel>, providerId?: string) => void
    addModel: (model: Omit<CustomModel, 'enabled'>) => void
    deleteModel: (modelKey: string, providerId?: string) => void
    updateWorkflowConcurrency: (field: keyof WorkflowConcurrencyConfig, value: number) => void
    updateCapabilityDefault: (modelKey: string, field: string, value: string | number | boolean | null) => void
    getModelsByType: (type: CustomModel['type']) => CustomModel[]
}

export function useProviders(): UseProvidersReturn {
    const locale = useLocale()
    const t = useTranslations('apiConfig')
    const { showToast } = useToast()
    const [providers, setProviders] = useState<Provider[]>(createInitialProviders([]))
    const [models, setModels] = useState<CustomModel[]>(createInitialModels([]))
    const [defaultModels, setDefaultModels] = useState<DefaultModels>({})
    const [workflowConcurrency, setWorkflowConcurrency] = useState<WorkflowConcurrencyConfig | null>(null)
    const [capabilityDefaults, setCapabilityDefaults] = useState<CapabilitySelections>({})
    const { data, loading: queryLoading, error: queryError } = useUserApiConfigQuery()
    const catalogProviderIdsRef = useRef<Set<string>>(new Set())
    const catalogModelKeysRef = useRef<Set<string>>(new Set())

    // 始终持有最新值的 refs，用于避免异步保存时读到旧的闭包值
    const latestModelsRef = useRef(models)
    const latestProvidersRef = useRef(providers)
    const latestDefaultModelsRef = useRef(defaultModels)
    const latestWorkflowConcurrencyRef = useRef(workflowConcurrency)
    const latestCapabilityDefaultsRef = useRef(capabilityDefaults)
    useEffect(() => { latestModelsRef.current = models }, [models])
    useEffect(() => { latestProvidersRef.current = providers }, [providers])
    useEffect(() => { latestDefaultModelsRef.current = defaultModels }, [defaultModels])
    useEffect(() => { latestWorkflowConcurrencyRef.current = workflowConcurrency }, [workflowConcurrency])
    useEffect(() => { latestCapabilityDefaultsRef.current = capabilityDefaults }, [capabilityDefaults])

    const { saveStatus, saveError, performSave, flushConfig } = useApiConfigSaver({
        latestModelsRef,
        latestProvidersRef,
        latestDefaultModelsRef,
        latestWorkflowConcurrencyRef,
        latestCapabilityDefaultsRef,
    })

    useEffect(() => {
        if (queryError) {
            _ulogError('获取配置失败:', queryError)
            return
        }
        if (!data) return
        if (!data.catalog) {
            throw new Error('API_CONFIG_CATALOG_MISSING')
        }
        const catalogProviders = data.catalog.providers
        const catalogModels = data.catalog.models
        catalogProviderIdsRef.current = new Set(catalogProviders.map((provider) => provider.id))
        catalogModelKeysRef.current = new Set(catalogModels.map((model) => encodeModelKey(model.provider, model.modelId)))

        const serverCatalogProviders = catalogProviders.map((provider) => ({
            ...provider,
            name: resolvePresetProviderName(provider.id, provider.name, locale),
        }))

        const savedProviders: Provider[] = data.providers || []
        // eslint-disable-next-line react-hooks/set-state-in-effect -- Initialize editable drafts from the received server catalog snapshot.
        setProviders(mergeProvidersForDisplay(savedProviders, serverCatalogProviders))
        setModels(mergeModelsForDisplay(data.models || [], catalogModels))
        if (data.defaultModels) setDefaultModels(data.defaultModels)
        setWorkflowConcurrency(parseWorkflowConcurrency(data.workflowConcurrency))
        if (data.capabilityDefaults && typeof data.capabilityDefaults === 'object') {
            setCapabilityDefaults(data.capabilityDefaults as CapabilitySelections)
        }
    }, [data, queryError, locale])

    const updateCapabilityDefault = useCallback((modelKey: string, field: string, value: string | number | boolean | null) => {
        setCapabilityDefaults((previous) => {
            const next: CapabilitySelections = { ...previous }
            const current = { ...(next[modelKey] || {}) }
            if (value === null) {
                delete current[field]
            } else {
                current[field] = value
            }

            if (Object.keys(current).length === 0) {
                delete next[modelKey]
            } else {
                next[modelKey] = current
            }
            latestCapabilityDefaultsRef.current = next
            void performSave({ capabilityDefaults: next })
            return next
        })
    }, [performSave])

    const updateWorkflowConcurrency = useCallback((field: keyof WorkflowConcurrencyConfig, value: number) => {
        const previous = latestWorkflowConcurrencyRef.current
        if (previous === null) throw new Error('WORKFLOW_CONCURRENCY_MANAGED_BY_SYSTEM')
        if (!Number.isInteger(value) || value < 1) throw new Error('WORKFLOW_CONCURRENCY_VALUE_INVALID')
        const next = { ...previous, [field]: value }
        latestWorkflowConcurrencyRef.current = next
        setWorkflowConcurrency(next)
        void performSave({ workflowConcurrency: next })
    }, [performSave])

    // 提供商操作
    const addOpenRouterChannel = useCallback((draft: OpenRouterChannelDraft): boolean => {
        const catalogProvider = data?.catalog?.providers.find((provider) => provider.id === 'openrouter')
        if (!catalogProvider) return false

        const slug = normalizeOpenRouterChannelSlug(draft.slug)
        const providerId = composeOpenRouterChannelId(slug)
        if (!/^openrouter:[a-z0-9][a-z0-9_-]*$/.test(providerId)) {
            showToast(t('providerIdExists'), 'warning')
            return false
        }
        if (latestProvidersRef.current.some((provider) => provider.id.toLowerCase() === providerId)) {
            showToast(t('providerIdExists'), 'warning')
            return false
        }

        const name = draft.name.trim()
        const baseUrl = draft.baseUrl.trim()
        if (!name || !baseUrl) return false

        const nextProvider: Provider = {
            ...catalogProvider,
            id: providerId,
            name,
            baseUrl,
            featured: false,
            apiKey: draft.apiKey.trim(),
            hasApiKey: Boolean(draft.apiKey.trim()),
        }
        const next = [...latestProvidersRef.current, nextProvider]
        latestProvidersRef.current = next
        setProviders(next)

        const nextModels = [...latestModelsRef.current]
        for (const entry of draft.models ?? []) {
            const modelId = entry.modelId.trim()
            if (!modelId) continue
            const modelKey = encodeModelKey(providerId, modelId)
            const index = nextModels.findIndex((model) =>
                model.modelKey === modelKey || (model.provider === providerId && model.modelId === modelId))
            if (index >= 0) {
                nextModels[index] = { ...nextModels[index], name: entry.name, type: entry.type }
            } else {
                nextModels.push({
                    modelId,
                    name: entry.name,
                    type: entry.type,
                    provider: providerId,
                    modelKey,
                    enabled: false,
                })
            }
        }
        // 新导入的模型只在对应槽位当前没有启用模型时才占据该槽位
        for (const entry of draft.models ?? []) {
            if (nextModels.some((model) => model.type === entry.type && model.enabled)) continue
            const index = nextModels.findIndex((model) => model.type === entry.type && model.provider === providerId)
            if (index >= 0) {
                nextModels[index] = { ...nextModels[index], enabled: true }
            }
        }
        latestModelsRef.current = nextModels
        setModels(nextModels)

        void performSave().then((saved) => {
            if (saved) {
                const settled = latestProvidersRef.current.map((provider) => (
                    provider.id === providerId
                        ? { ...provider, apiKey: undefined, hasApiKey: Boolean(nextProvider.apiKey) }
                        : provider
                ))
                latestProvidersRef.current = settled
                setProviders(settled)
                return
            }
            const revertedProviders = latestProvidersRef.current.filter((provider) => provider.id !== providerId)
            const revertedModels = latestModelsRef.current.filter((model) => model.provider !== providerId)
            latestProvidersRef.current = revertedProviders
            latestModelsRef.current = revertedModels
            setProviders(revertedProviders)
            setModels(revertedModels)
        })
        return true
    }, [data?.catalog?.providers, performSave, showToast, t])

    const updateProviderApiKey = useCallback((providerId: string, apiKey: string) => {
        const previousProvider = latestProvidersRef.current.find((provider) => provider.id === providerId)
        if (!previousProvider) return
        const next = latestProvidersRef.current.map((provider) => (
            provider.id === providerId ? { ...provider, apiKey, hasApiKey: Boolean(apiKey) } : provider
        ))
        latestProvidersRef.current = next
        setProviders(next)
        void performSave().then((saved) => {
            const settled = latestProvidersRef.current.map((provider) => {
                if (provider.id !== providerId) return provider
                if (!saved) return previousProvider
                return { ...provider, apiKey: undefined, hasApiKey: Boolean(apiKey) }
            })
            latestProvidersRef.current = settled
            setProviders(settled)
        })
    }, [performSave])

    const updateProviderBaseUrl = useCallback((providerId: string, baseUrl: string) => {
        const previousProvider = latestProvidersRef.current.find((provider) => provider.id === providerId)
        if (!previousProvider) return
        const nextBaseUrl = baseUrl.trim()
        if (!nextBaseUrl) return
        const next = latestProvidersRef.current.map((provider) => (
            provider.id === providerId ? { ...provider, baseUrl: nextBaseUrl } : provider
        ))
        latestProvidersRef.current = next
        setProviders(next)
        void performSave().then((saved) => {
            if (saved) return
            const reverted = latestProvidersRef.current.map((provider) => (
                provider.id === providerId ? previousProvider : provider
            ))
            latestProvidersRef.current = reverted
            setProviders(reverted)
        })
    }, [performSave])

    const reorderProviders = useCallback((activeProviderId: string, overProviderId: string) => {
        if (activeProviderId === overProviderId) return
        setProviders((previous) => {
            const oldIndex = previous.findIndex((provider) => provider.id === activeProviderId)
            const newIndex = previous.findIndex((provider) => provider.id === overProviderId)
            if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
                return previous
            }

            const next = [...previous]
            const moved = next[oldIndex]
            if (!moved) return previous
            next.splice(oldIndex, 1)
            next.splice(newIndex, 0, moved)
            latestProvidersRef.current = next
            void performSave()
            return next
        })
    }, [performSave])

    const deleteProvider = useCallback((providerId: string) => {
        if (catalogProviderIdsRef.current.has(providerId)) {
            showToast(t('presetProviderCannotDelete'), 'warning')
            return
        }
        if (confirm(t('confirmDeleteProvider'))) {
            setProviders(prev => {
                const next = prev.filter(p => p.id !== providerId)
                latestProvidersRef.current = next
                return next
            })
            setModels(prev => {
                const nextModels = prev.filter(m => m.provider !== providerId)
                setDefaultModels(prevDefaults => {
                    const remainingModelKeys = new Set(nextModels.map(m => m.modelKey))
                    const updates = clearMissingDefaultModels(prevDefaults, remainingModelKeys)
                    latestDefaultModelsRef.current = updates
                    return updates
                })
                latestModelsRef.current = nextModels
                void performSave()
                return nextModels
            })
        }
    }, [t, performSave, showToast])

    /**
     * One action for every slot: the picked model becomes the only enabled model
     * of its type, and the text slot additionally owns the Assistant selection.
     */
    const selectSlotModel = useCallback((type: UnifiedModelType, modelKey: string) => {
        if (isPresetComingSoonModelKey(modelKey)) return
        if (modelKey && !latestModelsRef.current.some(model => model.modelKey === modelKey && model.type === type)) return
        const nextModels = latestModelsRef.current.map(model => model.type === type
            ? { ...model, enabled: model.modelKey === modelKey }
            : model)
        latestModelsRef.current = nextModels
        setModels(nextModels)
        if (type !== 'llm') {
            void performSave()
            return
        }
        setDefaultModels(prev => {
            const nextDefaults = { ...prev, assistantModel: modelKey }
            latestDefaultModelsRef.current = nextDefaults
            void performSave({ defaultModels: nextDefaults })
            return nextDefaults
        })
    }, [performSave])

    const updateModel = useCallback((modelKey: string, updates: Partial<CustomModel>, providerId?: string) => {
        let nextModelKey = ''
        setModels(prev => {
            const next = prev.map(m => {
                if (m.modelKey !== modelKey || (providerId ? m.provider !== providerId : false)) return m
                const mergedProvider = updates.provider ?? m.provider
                const mergedModelId = updates.modelId ?? m.modelId
                nextModelKey = encodeModelKey(mergedProvider, mergedModelId)
                return {
                    ...m,
                    ...updates,
                    provider: mergedProvider,
                    modelId: mergedModelId,
                    modelKey: nextModelKey,
                    name: updates.name ?? m.name,
                }
            })
            latestModelsRef.current = next
            return next
        })
        if (nextModelKey && nextModelKey !== modelKey) {
            setDefaultModels(prev => {
                const next = replaceDefaultModelKey(prev, modelKey, nextModelKey)
                latestDefaultModelsRef.current = next
                return next
            })
        }
        void performSave()
    }, [performSave])

    const addModel = useCallback((model: Omit<CustomModel, 'enabled'>) => {
        setModels(prev => {
            const next = [
                ...prev.map(existing => model.type !== 'llm' && existing.type === model.type
                    ? { ...existing, enabled: false }
                    : existing),
                {
                    ...model,
                    modelKey: model.modelKey || encodeModelKey(model.provider, model.modelId),
                    enabled: true,
                },
            ]
            latestModelsRef.current = next
            void performSave()
            return next
        })
    }, [performSave])

    const deleteModel = useCallback((modelKey: string, providerId?: string) => {
        if (catalogModelKeysRef.current.has(modelKey)) {
            showToast(t('presetModelCannotDelete'), 'warning')
            return
        }
        if (confirm(t('confirmDeleteModel'))) {
            setModels(prev => {
                const nextModels = prev.filter(m =>
                    !(m.modelKey === modelKey && (providerId ? m.provider === providerId : true))
                )
                setDefaultModels(prevDefaults => {
                    const remainingModelKeys = new Set(nextModels.map(m => m.modelKey))
                    const nextDefaults = clearMissingDefaultModels(prevDefaults, remainingModelKeys)
                    latestDefaultModelsRef.current = nextDefaults
                    return nextDefaults
                })
                latestModelsRef.current = nextModels
                void performSave()
                return nextModels
            })
        }
    }, [t, performSave, showToast])

    // Keep the complete editable snapshot for saves; only project discoverable
    // providers/models to controls so hiding a provider never deletes its config.
    const visibleProviderKeys = useMemo(
        () => new Set(data?.catalog?.providers.map((provider) => provider.id) ?? []),
        [data?.catalog?.providers],
    )
    const visibleProviders = useMemo(
        () => providers.filter((provider) => visibleProviderKeys.has(getProviderKey(provider.id))),
        [providers, visibleProviderKeys],
    )
    const visibleModels = useMemo(
        () => models.filter((model) => visibleProviderKeys.has(getProviderKey(model.provider))),
        [models, visibleProviderKeys],
    )

    // 过滤器
    const getModelsByType = useCallback((type: CustomModel['type']) => {
        return visibleModels.filter(m => m.type === type)
    }, [visibleModels])

    return {
        fixedParameterFields: data?.fixedParameterFields ?? {},
        providers: visibleProviders,
        models: visibleModels,
        defaultModels,
        workflowConcurrency,
        capabilityDefaults,
        loading: queryLoading,
        saveStatus,
        saveError,
        flushConfig,
        addOpenRouterChannel,
        updateProviderApiKey,
        updateProviderBaseUrl,
        reorderProviders,
        deleteProvider,
        selectSlotModel,
        updateModel,
        addModel,
        deleteModel,
        updateWorkflowConcurrency,
        updateCapabilityDefault,
        getModelsByType
    }
}
