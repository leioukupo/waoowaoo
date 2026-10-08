'use client'

import type { CSSProperties, FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AppIcon } from '@/components/ui/icons'
import { useTranslations } from 'next-intl'
import { apiFetch } from '@/lib/api-fetch'
import { MODEL_SLOT_TYPES } from '@/lib/ai-registry/media-model-selection'
import type { UnifiedModelType } from '@/lib/ai-registry/types'
import { MODEL_SLOT_PRESENTATION } from './model-slot-presentation'
import type { CustomModel, Provider } from '../api-config'
import type { ChannelModelDraft, OpenRouterChannelDraft } from '../api-config/provider-card/types'
import { ProviderCard } from '../api-config'

interface DefaultModels {
  assistantModel?: string
}

interface ApiConfigProviderListProps {
  modelProviders: Provider[]
  allModels: CustomModel[]
  defaultModels: DefaultModels
  getModelsForProvider: (providerId: string) => CustomModel[]
  onUpdateApiKey: (providerId: string, apiKey: string) => void
  onUpdateBaseUrl: (providerId: string, baseUrl: string) => void
  onAddOpenRouterChannel: (draft: OpenRouterChannelDraft) => boolean
  onReorderProviders: (activeProviderId: string, overProviderId: string) => void
  onDeleteModel: (modelKey: string, providerId: string) => void
  onUpdateModel: (modelKey: string, updates: Partial<CustomModel>, providerId: string) => void
  onDeleteProvider: (providerId: string) => void
  onAddModel: (model: Omit<CustomModel, 'enabled'>) => void
  labels: {
    providerPool: string
    providerPoolHint: string
    dragToSort: string
    moreProviders: string
    addOpenRouterChannel: string
    addOpenRouterChannelHint: string
    channelName: string
    channelSlug: string
    apiKeyLabel: string
    enterApiKey: string
    baseUrl: string
    save: string
    cancel: string
    fetchModels: string
    fetchingModels: string
    fetchModelsFailed: string
    fetchModelsUnreachable: string
    fetchModelsAuthFailed: string
    fetchModelsNoModelsEndpoint: string
    modelSearch: string
    modelType: string
    noFetchedModels: string
    noModelMatch: string
    fetchedModelsHint: string
  }
}

interface FetchedModelRow extends ChannelModelDraft {
  checked: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Credentials and the custom model catalog; model choice happens in the slots above. */
export function ApiConfigProviderList(props: ApiConfigProviderListProps) {
  const { modelProviders, allModels, getModelsForProvider, labels } = props
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null)
  const [showMoreProviders, setShowMoreProviders] = useState(false)
  const [showAddOpenRouterChannel, setShowAddOpenRouterChannel] = useState(false)
  const openRouterProvider = modelProviders.find((provider) => provider.id === 'openrouter')
  const [channelDraft, setChannelDraft] = useState<OpenRouterChannelDraft>({
    slug: '',
    name: '',
    baseUrl: openRouterProvider?.baseUrl ?? '',
    apiKey: '',
  })
  const [fetchedModels, setFetchedModels] = useState<FetchedModelRow[]>([])
  const [fetchSucceeded, setFetchSucceeded] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null)
  const t = useTranslations('apiConfig')

  useEffect(() => {
    if (!channelDraft.baseUrl && openRouterProvider?.baseUrl) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Fill the
      // channel form default after the catalog provider arrives asynchronously.
      setChannelDraft((previous) => ({ ...previous, baseUrl: openRouterProvider.baseUrl ?? '' }))
    }
  }, [channelDraft.baseUrl, openRouterProvider?.baseUrl])

  const modelTypeOptions: UnifiedModelType[] = openRouterProvider?.modelTypes ?? [...MODEL_SLOT_TYPES]
  const modelTypeLabels = useMemo(() => {
    const labelMap: Partial<Record<UnifiedModelType, string>> = {}
    for (const type of MODEL_SLOT_TYPES) {
      labelMap[type] = t(MODEL_SLOT_PRESENTATION[type].typeLabel)
    }
    return labelMap
  }, [t])

  const clearFetchedModels = useCallback(() => {
    setFetchedModels([])
    setFetchSucceeded(false)
    setModelSearch('')
    setFetchModelsError(null)
  }, [])

  const handleFetchModels = useCallback(async () => {
    const baseUrl = channelDraft.baseUrl.trim()
    const apiKey = channelDraft.apiKey.trim()
    if (!baseUrl || !apiKey) return
    setFetchingModels(true)
    setFetchModelsError(null)
    setFetchSucceeded(false)
    try {
      const response = await apiFetch('/api/user/api-config/preview-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey }),
      })
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
        const details = error && isRecord(error.details) ? error.details : null
        const detailCode = typeof details?.code === 'string' ? details.code : ''
        if (detailCode === 'PREVIEW_MODELS_AUTH_FAILED') {
          setFetchModelsError(labels.fetchModelsAuthFailed)
        } else if (detailCode === 'PREVIEW_MODELS_TIMEOUT' || detailCode === 'PREVIEW_MODELS_UNREACHABLE') {
          setFetchModelsError(labels.fetchModelsUnreachable)
        } else if (detailCode === 'PREVIEW_MODELS_ENDPOINT_NOT_FOUND') {
          setFetchModelsError(labels.fetchModelsNoModelsEndpoint)
        } else {
          setFetchModelsError(labels.fetchModelsFailed)
        }
        return
      }
      const rawModels = isRecord(payload) ? payload.models : null
      const rows: FetchedModelRow[] = []
      if (Array.isArray(rawModels)) {
        for (const entry of rawModels) {
          if (!isRecord(entry)) continue
          const modelId = typeof entry.modelId === 'string' ? entry.modelId.trim() : ''
          if (!modelId) continue
          const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : modelId
          const suggested = typeof entry.suggestedType === 'string' ? entry.suggestedType : ''
          const type: UnifiedModelType = modelTypeOptions.includes(suggested as UnifiedModelType)
            ? (suggested as UnifiedModelType)
            : (modelTypeOptions.includes('llm') ? 'llm' : modelTypeOptions[0])
          rows.push({ modelId, name, type, checked: true })
        }
      }
      setFetchedModels(rows)
      setFetchSucceeded(true)
      setModelSearch('')
    } catch {
      setFetchModelsError(labels.fetchModelsFailed)
    } finally {
      setFetchingModels(false)
    }
  }, [channelDraft.baseUrl, channelDraft.apiKey, labels, modelTypeOptions])

  const updateFetchedModel = (modelId: string, patch: Partial<Pick<FetchedModelRow, 'name' | 'type' | 'checked'>>) => {
    setFetchedModels((previous) => previous.map((row) => (row.modelId === modelId ? { ...row, ...patch } : row)))
  }

  const filteredFetchedModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase()
    if (!query) return fetchedModels
    return fetchedModels.filter((row) =>
      row.name.toLowerCase().includes(query) || row.modelId.toLowerCase().includes(query))
  }, [fetchedModels, modelSearch])

  const checkedModelCount = useMemo(
    () => fetchedModels.filter((row) => row.checked).length,
    [fetchedModels],
  )

  const handleAddOpenRouterChannel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const models = fetchedModels
      .filter((row) => row.checked && row.modelId)
      .map((row) => ({ modelId: row.modelId, name: row.name, type: row.type }))
    if (!props.onAddOpenRouterChannel({ ...channelDraft, models })) return
    setChannelDraft({
      slug: '',
      name: '',
      baseUrl: openRouterProvider?.baseUrl ?? '',
      apiKey: '',
    })
    clearFetchedModels()
    setShowAddOpenRouterChannel(false)
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    props.onReorderProviders(String(active.id), String(over.id))
  }, [props])

  const extensionProviders = useMemo(
    () => modelProviders.filter((provider) => (
      provider.featured !== true
      && !provider.hasApiKey
      && !provider.id.startsWith('openrouter:')
    )),
    [modelProviders],
  )
  const primaryProviders = useMemo(() => {
    const extensionIds = new Set(extensionProviders.map((provider) => provider.id))
    return modelProviders.filter((provider) => !extensionIds.has(provider.id))
  }, [extensionProviders, modelProviders])

  const renderCard = (provider: Provider, dragHandle?: ReactNode) => (
    <ProviderCard
      provider={provider}
      dragHandle={dragHandle}
      models={getModelsForProvider(provider.id)}
      allModels={allModels}
      defaultModels={props.defaultModels}
      expanded={expandedProviderId === provider.id}
      onExpandChange={(expanded) => setExpandedProviderId(expanded ? provider.id : null)}
      onUpdateApiKey={props.onUpdateApiKey}
      onUpdateBaseUrl={props.onUpdateBaseUrl}
      onDeleteModel={(modelKey) => props.onDeleteModel(modelKey, provider.id)}
      onUpdateModel={(modelKey, updates) => props.onUpdateModel(modelKey, updates, provider.id)}
      onDeleteProvider={props.onDeleteProvider}
      onAddModel={props.onAddModel}
    />
  )

  return (
    <div id="provider-pool-section" className="space-y-4 scroll-mt-6">
      <div className="flex items-center gap-2.5">
        <span className="glass-surface-soft inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--glass-text-secondary)]">
          <AppIcon name="cube" className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-xl font-bold text-[var(--glass-text-primary)]">{labels.providerPool}</h2>
          <p className="mt-1 text-[13px] text-[var(--glass-text-secondary)]">{labels.providerPoolHint}</p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddOpenRouterChannel((previous) => !previous)}
          className="glass-btn-base glass-btn-soft ml-auto shrink-0 px-2.5 py-1.5 text-xs"
        >
          <AppIcon name="plus" className="h-3.5 w-3.5" />
          {labels.addOpenRouterChannel}
        </button>
      </div>
      {showAddOpenRouterChannel && (
        <form
          onSubmit={handleAddOpenRouterChannel}
          className="glass-surface-soft grid grid-cols-1 gap-3 rounded-2xl p-4 md:grid-cols-2"
        >
          <p className="text-xs text-[var(--glass-text-secondary)] md:col-span-2">
            {labels.addOpenRouterChannelHint}
          </p>
          <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
            <span>{labels.channelName}</span>
            <input
              required
              value={channelDraft.name}
              onChange={(event) => setChannelDraft((previous) => ({ ...previous, name: event.target.value }))}
              className="glass-input-base w-full px-3 py-2 text-xs"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
            <span>{labels.channelSlug}</span>
            <input
              required
              value={channelDraft.slug}
              onChange={(event) => setChannelDraft((previous) => ({ ...previous, slug: event.target.value }))}
              placeholder="cn-proxy"
              className="glass-input-base w-full px-3 py-2 font-mono text-xs"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--glass-text-secondary)] md:col-span-2">
            <span>{labels.baseUrl}</span>
            <input
              required
              type="url"
              value={channelDraft.baseUrl}
              onChange={(event) => setChannelDraft((previous) => ({ ...previous, baseUrl: event.target.value }))}
              className="glass-input-base w-full px-3 py-2 font-mono text-xs"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--glass-text-secondary)] md:col-span-2">
            <span>{labels.apiKeyLabel}</span>
            <input
              type="password"
              autoComplete="off"
              value={channelDraft.apiKey}
              onChange={(event) => setChannelDraft((previous) => ({ ...previous, apiKey: event.target.value }))}
              placeholder={labels.enterApiKey}
              className="glass-input-base w-full px-3 py-2 text-xs"
            />
          </label>
          <div className="space-y-2 md:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={fetchingModels || !channelDraft.baseUrl.trim() || !channelDraft.apiKey.trim()}
                onClick={() => { void handleFetchModels() }}
                className="glass-btn-base glass-btn-soft px-3 py-2 text-xs disabled:opacity-50"
              >
                {fetchingModels ? labels.fetchingModels : labels.fetchModels}
              </button>
              {fetchModelsError && (
                <span className="text-xs text-red-500">{fetchModelsError}</span>
              )}
              {(fetchSucceeded || fetchedModels.length > 0) && (
                <span className="text-xs text-[var(--glass-text-secondary)]">
                  {t('modelsSelected', { count: checkedModelCount })}
                </span>
              )}
            </div>
            {(fetchedModels.length > 0 || fetchSucceeded) && (
              <div className="space-y-2">
                {fetchedModels.length > 0 && (
                  <input
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                    placeholder={labels.modelSearch}
                    className="glass-input-base w-full px-3 py-2 text-xs"
                  />
                )}
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-[var(--glass-stroke-base)] p-2">
                  <p className="px-1 py-1 text-[11px] text-[var(--glass-text-tertiary)]">{labels.fetchedModelsHint}</p>
                  {filteredFetchedModels.length === 0 ? (
                    <p className="px-1 py-1 text-xs text-[var(--glass-text-tertiary)]">
                      {modelSearch ? labels.noModelMatch : labels.noFetchedModels}
                    </p>
                  ) : (
                    filteredFetchedModels.map((row) => (
                      <div key={row.modelId} className="flex items-center gap-2 rounded-md px-1 py-1">
                        <input
                          type="checkbox"
                          checked={row.checked}
                          onChange={(event) => updateFetchedModel(row.modelId, { checked: event.target.checked })}
                          className="h-3.5 w-3.5 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs text-[var(--glass-text-primary)]">{row.name}</p>
                          <p className="truncate font-mono text-[10px] text-[var(--glass-text-tertiary)]">{row.modelId}</p>
                        </div>
                        <label className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--glass-text-tertiary)]">
                          {labels.modelType}
                          <select
                            value={row.type}
                            onChange={(event) => updateFetchedModel(row.modelId, { type: event.target.value as UnifiedModelType })}
                            className="glass-input-base px-2 py-1 text-xs"
                          >
                            {modelTypeOptions.map((type) => (
                              <option key={type} value={type}>{modelTypeLabels[type]}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 md:col-span-2">
            <button
              type="button"
              onClick={() => {
                clearFetchedModels()
                setShowAddOpenRouterChannel(false)
              }}
              className="glass-btn-base glass-btn-soft px-3 py-2 text-xs"
            >
              {labels.cancel}
            </button>
            <button type="submit" className="glass-btn-base glass-btn-primary px-3 py-2 text-xs">
              {labels.save}
            </button>
          </div>
        </form>
      )}
      <div className="glass-surface glass-card-shadow-soft overflow-hidden rounded-2xl">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={primaryProviders.map((provider) => provider.id)} strategy={verticalListSortingStrategy}>
            {primaryProviders.map((provider) => (
              <SortableProviderRow key={provider.id} providerId={provider.id} dragLabel={labels.dragToSort}>
                {({ dragHandle }) => renderCard(provider, dragHandle)}
              </SortableProviderRow>
            ))}
          </SortableContext>
        </DndContext>
        {extensionProviders.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={showMoreProviders}
              onClick={() => setShowMoreProviders((prev) => !prev)}
              className="flex w-full items-center justify-between border-t border-[var(--glass-stroke-base)] px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--glass-text-tertiary)] transition-colors hover:text-[var(--glass-text-secondary)]"
            >
              <span>{labels.moreProviders} · {extensionProviders.length}</span>
              <AppIcon name={showMoreProviders ? 'chevronUp' : 'chevronDown'} className="h-3.5 w-3.5" />
            </button>
            {showMoreProviders && extensionProviders.map((provider) => (
              <div key={provider.id} className="border-t border-[var(--glass-stroke-base)]">
                {renderCard(provider)}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

interface SortableProviderRowProps {
  providerId: string
  dragLabel: string
  children: (props: { dragHandle: ReactNode }) => ReactNode
}

function SortableProviderRow({ providerId, dragLabel, children }: SortableProviderRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: providerId })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.9 : 1,
    zIndex: isDragging ? 20 : 1,
    position: 'relative',
    background: isDragging ? 'var(--glass-bg-surface-strong)' : undefined,
  }

  return (
    <div ref={setNodeRef} style={style}>
      {children({
        dragHandle: (
          <button
            type="button"
            aria-label={dragLabel}
            title={dragLabel}
            className="inline-flex shrink-0 cursor-grab items-center justify-center rounded-md p-1 text-[var(--glass-text-tertiary)] touch-none transition-colors hover:text-[var(--glass-text-secondary)] active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <AppIcon name="gripVertical" className="h-3.5 w-3.5" />
          </button>
        ),
      })}
    </div>
  )
}
