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
import { MODEL_SLOT_TYPES } from '@/lib/ai-registry/media-model-selection'
import type { UnifiedModelType } from '@/lib/ai-registry/types'
import { MODEL_SLOT_PRESENTATION } from './model-slot-presentation'
import type { CustomModel, Provider } from '../api-config'
import type { OpenAiCompatChannelDraft, OpenRouterChannelDraft } from '../api-config/provider-card/types'
import { FetchedModelsPanel, useChannelModelFetcher } from './fetched-models-panel'
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
  onAddOpenAiCompatChannel: (draft: OpenAiCompatChannelDraft) => boolean
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
    addOpenAiCompatChannel: string
    addOpenAiCompatChannelHint: string
    channelName: string
    channelSlug: string
    apiKeyLabel: string
    apiKeyOptionalLabel: string
    enterApiKey: string
    enterApiKeyOptional: string
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

function buildPanelLabels(labels: ApiConfigProviderListProps['labels']) {
  return {
    fetch: labels.fetchModels,
    fetching: labels.fetchingModels,
    hint: labels.fetchedModelsHint,
    searchPlaceholder: labels.modelSearch,
    modelType: labels.modelType,
    noFetchedModels: labels.noFetchedModels,
    noModelMatch: labels.noModelMatch,
  }
}

/** Credentials and the custom model catalog; model choice happens in the slots above. */
export function ApiConfigProviderList(props: ApiConfigProviderListProps) {
  const { modelProviders, allModels, getModelsForProvider, labels } = props
  const t = useTranslations('apiConfig')
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null)
  const [showMoreProviders, setShowMoreProviders] = useState(false)
  const [showAddOpenRouterChannel, setShowAddOpenRouterChannel] = useState(false)
  const [showAddOpenAiCompatChannel, setShowAddOpenAiCompatChannel] = useState(false)
  const openRouterProvider = modelProviders.find((provider) => provider.id === 'openrouter')
  const openAiCompatProvider = modelProviders.find((provider) => provider.id === 'openai-compat')
  const [channelDraft, setChannelDraft] = useState<OpenRouterChannelDraft>({
    slug: '',
    name: '',
    baseUrl: openRouterProvider?.baseUrl ?? '',
    apiKey: '',
  })
  const [aiCompatDraft, setAiCompatDraft] = useState<OpenAiCompatChannelDraft>({
    slug: '',
    name: '',
    baseUrl: '',
    apiKey: '',
  })

  useEffect(() => {
    if (!channelDraft.baseUrl && openRouterProvider?.baseUrl) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Fill the
      // channel form default after the catalog provider arrives asynchronously.
      setChannelDraft((previous) => ({ ...previous, baseUrl: openRouterProvider.baseUrl ?? '' }))
    }
  }, [channelDraft.baseUrl, openRouterProvider?.baseUrl])

  const openRouterTypeOptions: UnifiedModelType[] = useMemo(
    () => (openRouterProvider?.modelTypes?.length
      ? [...openRouterProvider.modelTypes]
      : [...MODEL_SLOT_TYPES]),
    [openRouterProvider?.modelTypes],
  )
  const aiCompatTypeOptions: UnifiedModelType[] = useMemo(
    () => (openAiCompatProvider?.modelTypes?.length
      ? [...openAiCompatProvider.modelTypes]
      : ['llm']),
    [openAiCompatProvider?.modelTypes],
  )
  const modelTypeLabels = useMemo(() => {
    const labelMap: Partial<Record<UnifiedModelType, string>> = {}
    for (const type of MODEL_SLOT_TYPES) {
      labelMap[type] = t(MODEL_SLOT_PRESENTATION[type].typeLabel)
    }
    return labelMap
  }, [t])
  const panelLabels = useMemo(() => buildPanelLabels(labels), [labels])
  const errorLabelSet = useMemo(() => ({
    authFailed: labels.fetchModelsAuthFailed,
    unreachable: labels.fetchModelsUnreachable,
    noEndpoint: labels.fetchModelsNoModelsEndpoint,
    failed: labels.fetchModelsFailed,
  }), [labels])

  const openRouterFetcher = useChannelModelFetcher({
    baseUrl: channelDraft.baseUrl,
    apiKey: channelDraft.apiKey,
    requireApiKey: true,
    typeOptions: openRouterTypeOptions,
    errorLabels: errorLabelSet,
  })
  const aiCompatFetcher = useChannelModelFetcher({
    baseUrl: aiCompatDraft.baseUrl,
    apiKey: aiCompatDraft.apiKey,
    requireApiKey: false,
    typeOptions: aiCompatTypeOptions,
    errorLabels: errorLabelSet,
  })

  const handleAddOpenRouterChannel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!props.onAddOpenRouterChannel({ ...channelDraft, models: openRouterFetcher.selectedModels })) return
    setChannelDraft({
      slug: '',
      name: '',
      baseUrl: openRouterProvider?.baseUrl ?? '',
      apiKey: '',
    })
    openRouterFetcher.clear()
    setShowAddOpenRouterChannel(false)
  }

  const handleAddOpenAiCompatChannel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!props.onAddOpenAiCompatChannel({ ...aiCompatDraft, models: aiCompatFetcher.selectedModels })) return
    setAiCompatDraft({
      slug: '',
      name: '',
      baseUrl: '',
      apiKey: '',
    })
    aiCompatFetcher.clear()
    setShowAddOpenAiCompatChannel(false)
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
      && !provider.id.startsWith('openai-compat:')
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
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-[var(--glass-text-primary)]">{labels.providerPool}</h2>
        <p className="mt-1 text-[13px] text-[var(--glass-text-secondary)]">{labels.providerPoolHint}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setShowAddOpenAiCompatChannel(false)
            setShowAddOpenRouterChannel((previous) => !previous)
          }}
          className="glass-btn-base glass-btn-soft px-3 py-2 text-xs"
        >
          {labels.addOpenRouterChannel}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowAddOpenRouterChannel(false)
            setShowAddOpenAiCompatChannel((previous) => !previous)
          }}
          className="glass-btn-base glass-btn-soft px-3 py-2 text-xs"
        >
          {labels.addOpenAiCompatChannel}
        </button>
      </div>
      {showAddOpenRouterChannel && (
        <form
          onSubmit={handleAddOpenRouterChannel}
          className="glass-surface glass-card-shadow-soft space-y-3 rounded-2xl p-4"
        >
          <p className="text-xs text-[var(--glass-text-secondary)]">{labels.addOpenRouterChannelHint}</p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
          </div>
          <div className="md:col-span-2">
            <FetchedModelsPanel
              rows={openRouterFetcher.rows}
              fetchSucceeded={openRouterFetcher.fetchSucceeded}
              fetching={openRouterFetcher.fetching}
              canFetch={openRouterFetcher.canFetch}
              error={openRouterFetcher.error}
              onFetch={() => { void openRouterFetcher.fetch() }}
              search={openRouterFetcher.search}
              onSearchChange={openRouterFetcher.setModelSearch}
              onRowPatch={openRouterFetcher.patchRow}
              typeOptions={openRouterTypeOptions}
              typeLabels={modelTypeLabels}
              labels={{ ...panelLabels, selected: (count) => t('modelsSelected', { count }) }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                openRouterFetcher.clear()
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
      {showAddOpenAiCompatChannel && (
        <form
          onSubmit={handleAddOpenAiCompatChannel}
          className="glass-surface glass-card-shadow-soft space-y-3 rounded-2xl p-4"
        >
          <p className="text-xs text-[var(--glass-text-secondary)]">{labels.addOpenAiCompatChannelHint}</p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
              <span>{labels.channelName}</span>
              <input
                required
                value={aiCompatDraft.name}
                onChange={(event) => setAiCompatDraft((previous) => ({ ...previous, name: event.target.value }))}
                className="glass-input-base w-full px-3 py-2 text-xs"
              />
            </label>
            <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
              <span>{labels.channelSlug}</span>
              <input
                required
                value={aiCompatDraft.slug}
                onChange={(event) => setAiCompatDraft((previous) => ({ ...previous, slug: event.target.value }))}
                placeholder="vllm"
                className="glass-input-base w-full px-3 py-2 font-mono text-xs"
              />
            </label>
            <label className="space-y-1 text-xs text-[var(--glass-text-secondary)] md:col-span-2">
              <span>{labels.baseUrl}</span>
              <input
                required
                type="url"
                value={aiCompatDraft.baseUrl}
                onChange={(event) => setAiCompatDraft((previous) => ({ ...previous, baseUrl: event.target.value }))}
                placeholder="http://192.168.31.9:8000/v1"
                className="glass-input-base w-full px-3 py-2 font-mono text-xs"
              />
            </label>
            <label className="space-y-1 text-xs text-[var(--glass-text-secondary)] md:col-span-2">
              <span>{labels.apiKeyOptionalLabel}</span>
              <input
                type="password"
                autoComplete="off"
                value={aiCompatDraft.apiKey}
                onChange={(event) => setAiCompatDraft((previous) => ({ ...previous, apiKey: event.target.value }))}
                placeholder={labels.enterApiKeyOptional}
                className="glass-input-base w-full px-3 py-2 text-xs"
              />
            </label>
          </div>
          <div className="md:col-span-2">
            <FetchedModelsPanel
              rows={aiCompatFetcher.rows}
              fetchSucceeded={aiCompatFetcher.fetchSucceeded}
              fetching={aiCompatFetcher.fetching}
              canFetch={aiCompatFetcher.canFetch}
              error={aiCompatFetcher.error}
              onFetch={() => { void aiCompatFetcher.fetch() }}
              search={aiCompatFetcher.search}
              onSearchChange={aiCompatFetcher.setModelSearch}
              onRowPatch={aiCompatFetcher.patchRow}
              typeOptions={aiCompatTypeOptions}
              typeLabels={modelTypeLabels}
              labels={{ ...panelLabels, selected: (count) => t('modelsSelected', { count }) }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                aiCompatFetcher.clear()
                setShowAddOpenAiCompatChannel(false)
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
