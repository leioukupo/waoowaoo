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
import type { CustomModel, Provider } from '../api-config'
import type { OpenRouterChannelDraft } from '../api-config/provider-card/types'
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
  }
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

  useEffect(() => {
    if (!channelDraft.baseUrl && openRouterProvider?.baseUrl) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Fill the
      // channel form default after the catalog provider arrives asynchronously.
      setChannelDraft((previous) => ({ ...previous, baseUrl: openRouterProvider.baseUrl ?? '' }))
    }
  }, [channelDraft.baseUrl, openRouterProvider?.baseUrl])

  const handleAddOpenRouterChannel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!props.onAddOpenRouterChannel(channelDraft)) return
    setChannelDraft({
      slug: '',
      name: '',
      baseUrl: openRouterProvider?.baseUrl ?? '',
      apiKey: '',
    })
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
          <div className="flex justify-end gap-2 md:col-span-2">
            <button
              type="button"
              onClick={() => setShowAddOpenRouterChannel(false)}
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
