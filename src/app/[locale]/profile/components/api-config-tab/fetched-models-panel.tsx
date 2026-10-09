'use client'

import { useCallback, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import type { UnifiedModelType } from '@/lib/ai-registry/types'
import type { ChannelModelDraft } from '../api-config/provider-card/types'

export interface FetchedModelRow extends ChannelModelDraft {
  checked: boolean
}

export interface FetchedModelsPanelLabels {
  fetch: string
  fetching: string
  hint: string
  searchPlaceholder: string
  modelType: string
  noFetchedModels: string
  noModelMatch: string
  selected: (count: number) => string
}

interface ErrorLabelSet {
  authFailed: string
  unreachable: string
  noEndpoint: string
  failed: string
}

interface ChannelModelFetcherOptions {
  baseUrl: string
  apiKey: string
  requireApiKey: boolean
  typeOptions: UnifiedModelType[]
  errorLabels: ErrorLabelSet
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Shared fetcher for the channel forms: pulls the channel's model list via
 * the preview-models endpoint and keeps the editable row state.
 */
export function useChannelModelFetcher(options: ChannelModelFetcherOptions) {
  const [rows, setRows] = useState<FetchedModelRow[]>([])
  const [fetchSucceeded, setFetchSucceeded] = useState(false)
  const [search, setSearch] = useState('')
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canFetch = Boolean(
    options.baseUrl.trim() && (!options.requireApiKey || options.apiKey.trim()),
  )

  const fetch = useCallback(async () => {
    const baseUrl = options.baseUrl.trim()
    const apiKey = options.apiKey.trim()
    if (!baseUrl || (options.requireApiKey && !apiKey)) return
    setFetching(true)
    setError(null)
    setFetchSucceeded(false)
    try {
      const response = await apiFetch('/api/user/api-config/preview-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
        }),
      })
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const errorRecord = isRecord(payload) && isRecord(payload.error) ? payload.error : null
        const details = errorRecord && isRecord(errorRecord.details) ? errorRecord.details : null
        const detailCode = typeof details?.code === 'string' ? details.code : ''
        if (detailCode === 'PREVIEW_MODELS_AUTH_FAILED') {
          setError(options.errorLabels.authFailed)
        } else if (detailCode === 'PREVIEW_MODELS_TIMEOUT' || detailCode === 'PREVIEW_MODELS_UNREACHABLE') {
          setError(options.errorLabels.unreachable)
        } else if (detailCode === 'PREVIEW_MODELS_ENDPOINT_NOT_FOUND') {
          setError(options.errorLabels.noEndpoint)
        } else {
          setError(options.errorLabels.failed)
        }
        return
      }
      const rawModels = isRecord(payload) ? payload.models : null
      const nextRows: FetchedModelRow[] = []
      if (Array.isArray(rawModels)) {
        for (const entry of rawModels) {
          if (!isRecord(entry)) continue
          const modelId = typeof entry.modelId === 'string' ? entry.modelId.trim() : ''
          if (!modelId) continue
          const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : modelId
          const suggested = typeof entry.suggestedType === 'string' ? entry.suggestedType : ''
          const type: UnifiedModelType = options.typeOptions.includes(suggested as UnifiedModelType)
            ? (suggested as UnifiedModelType)
            : (options.typeOptions.includes('llm') ? 'llm' : options.typeOptions[0])
          nextRows.push({ modelId, name, type, checked: true })
        }
      }
      setRows(nextRows)
      setFetchSucceeded(true)
      setSearch('')
    } catch {
      setError(options.errorLabels.failed)
    } finally {
      setFetching(false)
    }
  }, [options.baseUrl, options.apiKey, options.requireApiKey, options.typeOptions, options.errorLabels])

  const clear = useCallback(() => {
    setRows([])
    setFetchSucceeded(false)
    setSearch('')
    setError(null)
  }, [])

  const patchRow = (modelId: string, patch: Partial<Pick<FetchedModelRow, 'name' | 'type' | 'checked'>>) => {
    setRows((previous) => previous.map((row) => (row.modelId === modelId ? { ...row, ...patch } : row)))
  }

  const selectedModels: ChannelModelDraft[] = rows
    .filter((row) => row.checked && row.modelId)
    .map((row) => ({ modelId: row.modelId, name: row.name, type: row.type }))

  return {
    rows,
    fetchSucceeded,
    search,
    setModelSearch: setSearch,
    fetching,
    error,
    canFetch,
    fetch,
    clear,
    patchRow,
    selectedModels,
  }
}

interface FetchedModelsPanelProps {
  rows: FetchedModelRow[]
  fetchSucceeded: boolean
  fetching: boolean
  canFetch: boolean
  error: string | null
  onFetch: () => void
  search: string
  onSearchChange: (value: string) => void
  onRowPatch: (modelId: string, patch: Partial<Pick<FetchedModelRow, 'name' | 'type' | 'checked'>>) => void
  typeOptions: UnifiedModelType[]
  typeLabels: Partial<Record<UnifiedModelType, string>>
  labels: FetchedModelsPanelLabels
}

/** 拉取按钮 + 可搜索、可勾选、可改类型的模型列表。 */
export function FetchedModelsPanel(props: FetchedModelsPanelProps) {
  const { rows, fetchSucceeded, fetching, canFetch, error, labels, typeOptions, typeLabels } = props
  const query = props.search.trim().toLowerCase()
  const filtered = query
    ? rows.filter((row) => row.name.toLowerCase().includes(query) || row.modelId.toLowerCase().includes(query))
    : rows
  const checkedCount = rows.filter((row) => row.checked).length

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={fetching || !canFetch}
          onClick={() => { void props.onFetch() }}
          className="glass-btn-base glass-btn-soft px-3 py-2 text-xs disabled:opacity-50"
        >
          {fetching ? labels.fetching : labels.fetch}
        </button>
        {error && (
          <span className="text-xs text-red-500">{error}</span>
        )}
        {(fetchSucceeded || rows.length > 0) && (
          <span className="text-xs text-[var(--glass-text-secondary)]">{labels.selected(checkedCount)}</span>
        )}
      </div>
      {(rows.length > 0 || fetchSucceeded) && (
        <div className="space-y-2">
          {rows.length > 0 && (
            <input
              value={props.search}
              onChange={(event) => props.onSearchChange(event.target.value)}
              placeholder={labels.searchPlaceholder}
              className="glass-input-base w-full px-3 py-2 text-xs"
            />
          )}
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-[var(--glass-stroke-base)] p-2">
            <p className="px-1 py-1 text-[11px] text-[var(--glass-text-tertiary)]">{labels.hint}</p>
            {filtered.length === 0 ? (
              <p className="px-1 py-1 text-xs text-[var(--glass-text-tertiary)]">
                {query ? labels.noModelMatch : labels.noFetchedModels}
              </p>
            ) : (
              filtered.map((row) => (
                <div key={row.modelId} className="flex items-center gap-2 rounded-md px-1 py-1">
                  <input
                    type="checkbox"
                    checked={row.checked}
                    onChange={(event) => props.onRowPatch(row.modelId, { checked: event.target.checked })}
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
                      onChange={(event) => props.onRowPatch(row.modelId, { type: event.target.value as UnifiedModelType })}
                      className="glass-input-base px-2 py-1 text-xs"
                    >
                      {typeOptions.map((type) => (
                        <option key={type} value={type}>{typeLabels[type] ?? type}</option>
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
  )
}
