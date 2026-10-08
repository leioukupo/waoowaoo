import type { UnifiedModelType } from '@/lib/ai-registry/types'
import { ApiError } from '@/lib/api-errors'

export interface PreviewModelEntry {
  modelId: string
  name: string
  suggestedType: UnifiedModelType
}

export interface PreviewModelsInput {
  baseUrl: string
  apiKey: string
}

const FETCH_TIMEOUT_MS = 15_000
const MAX_MODELS = 1000
const CLOUD_METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata'])

function normalizeBaseUrl(raw: string): URL {
  const value = raw.trim()
  if (!value) throw new ApiError('INVALID_PARAMS', { code: 'PREVIEW_BASE_URL_INVALID', field: 'baseUrl' })
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ApiError('INVALID_PARAMS', { code: 'PREVIEW_BASE_URL_INVALID', field: 'baseUrl' })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('INVALID_PARAMS', { code: 'PREVIEW_BASE_URL_PROTOCOL', field: 'baseUrl' })
  }
  if (CLOUD_METADATA_HOSTS.has(url.hostname)) {
    throw new ApiError('INVALID_PARAMS', { code: 'PREVIEW_BASE_URL_BLOCKED', field: 'baseUrl' })
  }
  return url
}

function buildEndpointCandidates(base: URL): string[] {
  const path = base.pathname.replace(/\/+$/, '')
  const root = `${base.protocol}//${base.host}${path}`
  const candidates = [`${root}/models`]
  if (!path.endsWith('/v1')) candidates.push(`${root}/v1/models`)
  return [...new Set(candidates)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function inferTypeFromArchitecture(entry: Record<string, unknown>): UnifiedModelType | null {
  const architecture = entry.architecture
  if (!isRecord(architecture)) return null
  // OpenRouter 使用蛇形命名 output_modalities，部分 OpenAI 兼容网关使用驼峰命名
  const output = readStringArray(architecture.outputModalities ?? architecture.output_modalities)
  if (output.length === 0) return null
  if (output.includes('video')) return 'video'
  if (output.includes('image')) return 'image'
  if (output.includes('audio')) return 'voice'
  return 'llm'
}

function inferTypeFromId(modelId: string): UnifiedModelType {
  const id = modelId.toLowerCase()
  if (/sora|veo3?|kling|runway|wan2?|seedance|cogvideo|hailuo|minimax-video|video/.test(id)) return 'video'
  if (/dall-e|gpt-image|-image\b|image-|seedream|imagen|flux|sd-?xl|stable-?diffusion|lumina/.test(id)) return 'image'
  if (/whisper|tts|speech|audio|elevenlabs|cosyvoice/.test(id)) return 'voice'
  return 'llm'
}

function parseModelsList(payload: unknown): PreviewModelEntry[] {
  if (!isRecord(payload)) {
    throw new ApiError('EXTERNAL_ERROR', { code: 'PREVIEW_MODELS_RESPONSE_INVALID' })
  }
  const entries = payload.data
  if (!Array.isArray(entries)) {
    throw new ApiError('EXTERNAL_ERROR', { code: 'PREVIEW_MODELS_RESPONSE_INVALID' })
  }
  const models: PreviewModelEntry[] = []
  for (const entry of entries.slice(0, MAX_MODELS)) {
    if (!isRecord(entry)) continue
    const modelId = readString(entry.id)
    if (!modelId) continue
    const name = readString(entry.name) ?? modelId
    const suggestedType = inferTypeFromArchitecture(entry) ?? inferTypeFromId(modelId)
    models.push({ modelId, name, suggestedType })
  }
  return models
}

async function fetchEndpoint(endpoint: string, apiKey: string): Promise<PreviewModelEntry[]> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ApiError('NETWORK_ERROR', { code: 'PREVIEW_MODELS_TIMEOUT', message: endpoint })
    }
    throw new ApiError('NETWORK_ERROR', { code: 'PREVIEW_MODELS_UNREACHABLE', message: endpoint })
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ApiError('PROVIDER_AUTH_INVALID', { code: 'PREVIEW_MODELS_AUTH_FAILED' })
    }
    if (response.status === 404 || response.status === 405) {
      throw new ApiError('EXTERNAL_ERROR', { code: 'PREVIEW_MODELS_ENDPOINT_NOT_FOUND', message: String(response.status) })
    }
    throw new ApiError('EXTERNAL_ERROR', { code: 'PREVIEW_MODELS_HTTP_ERROR', message: String(response.status) })
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiError('EXTERNAL_ERROR', { code: 'PREVIEW_MODELS_RESPONSE_INVALID' })
  }
  return parseModelsList(payload)
}

export async function previewChannelModels(input: PreviewModelsInput): Promise<{ models: PreviewModelEntry[] }> {
  const base = normalizeBaseUrl(input.baseUrl)
  const apiKey = input.apiKey.trim()
  if (!apiKey) {
    throw new ApiError('INVALID_PARAMS', { code: 'PREVIEW_API_KEY_REQUIRED', field: 'apiKey' })
  }
  let lastError: ApiError | null = null
  for (const endpoint of buildEndpointCandidates(base)) {
    try {
      return { models: await fetchEndpoint(endpoint, apiKey) }
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'EXTERNAL_ERROR' || error.details?.code !== 'PREVIEW_MODELS_ENDPOINT_NOT_FOUND') {
        throw error
      }
      lastError = error
    }
  }
  throw lastError ?? new ApiError('EXTERNAL_ERROR', { code: 'PREVIEW_MODELS_ENDPOINT_NOT_FOUND' })
}
