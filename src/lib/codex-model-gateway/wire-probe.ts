import { fetchWithProviderProxy } from '@/lib/http/outbound-proxy'
import { createScopedLogger } from '@/lib/logging/core'

export type ProviderWireKind = 'responses' | 'chat' | 'unknown'

const probeLogger = createScopedLogger({ module: 'codex-gateway.wire-probe' })
const PROBE_TIMEOUT_MS = 20_000
const CONFIRMED_TTL_MS = 30 * 24 * 60 * 60 * 1000
const UNCERTAIN_TTL_MS = 60 * 60 * 1000

type ProbeCacheEntry = {
  wire: ProviderWireKind
  at: number
}

const probeCache = new Map<string, ProbeCacheEntry>()

function cacheKey(baseUrl: string, model: string): string {
  return `${baseUrl}\u0000${model}`
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, '')
  if (!/^https?:\/\/[^\s]+$/u.test(trimmed)) {
    throw new Error(`PROVIDER_BASE_URL_INVALID: ${value}`)
  }
  return trimmed
}

async function probeRequest(params: {
  readonly baseUrl: string
  readonly path: string
  readonly apiKey: string
  readonly model: string
  readonly payload: Record<string, unknown>
}): Promise<{
  readonly status: number | null
  readonly bodyText: string
  readonly contentType: string
  readonly networkError: boolean
}> {
  try {
    const response = await fetchWithProviderProxy(`${params.baseUrl}${params.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
      },
      body: JSON.stringify(params.payload),
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const bodyText = (await response.text().catch(() => '')).slice(0, 8_192)
    return {
      status: response.status,
      bodyText,
      contentType: response.headers.get('content-type')?.toLowerCase() ?? '',
      networkError: false,
    }
  } catch (error) {
    return {
      status: null,
      bodyText: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
      contentType: '',
      networkError: true,
    }
  }
}

const RESPONSES_SHAPE_HINTS = /"object"\s*:\s*"response"|"type"\s*:\s*"response\./u
const NOT_FOUND_HINTS = /not\s+found|does\s+not\s+exist|unknown\s+(model|route|endpoint|api|url|path)|no\s+such\s+(route|endpoint|model)|unsupported\s+(route|endpoint)|route\s+not\s+found|404/u
const AUTH_STATUS = new Set([401, 403])

function classifyProbeResponse(params: {
  readonly status: number | null
  readonly bodyText: string
  readonly contentType: string
  readonly networkError: boolean
  readonly endpoint: 'responses' | 'chat'
}): ProviderWireKind | 'inconclusive' | 'auth' {
  if (params.networkError) return 'inconclusive'
  const { status, bodyText } = params
  if (status === null) return 'inconclusive'
  if (AUTH_STATUS.has(status)) return 'auth'
  if (status === 200 || status === 201) {
    if (params.endpoint === 'responses') {
      if (RESPONSES_SHAPE_HINTS.test(bodyText)) return 'responses'
      if (/"choices"\s*:/.test(bodyText)) return 'chat'
      return 'inconclusive'
    }
    return 'chat'
  }
  if (status === 404) {
    return params.endpoint === 'responses' ? 'chat' : 'inconclusive'
  }
  if (status === 400 || status === 405 || status === 406 || status === 415 || status === 422) {
    if (NOT_FOUND_HINTS.test(bodyText)) return 'chat'
    if (params.endpoint === 'chat') return 'chat'
    return 'inconclusive'
  }
  return 'inconclusive'
}

/**
 * Determines whether an OpenAI-style endpoint speaks the OpenAI Responses API
 * (`/responses`) or only Chat Completions (`/chat/completions`). The probe
 * costs a single one-token completion and is cached for 30 days per
 * (baseUrl, model) pair; uncertain outcomes re-probe hourly.
 */
export async function probeProviderWire(params: {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}): Promise<ProviderWireKind> {
  const baseUrl = normalizeBaseUrl(params.baseUrl)
  const key = cacheKey(baseUrl, params.model)
  const cached = probeCache.get(key)
  if (cached) {
    const ttl = cached.wire === 'unknown' ? UNCERTAIN_TTL_MS : CONFIRMED_TTL_MS
    if (Date.now() - cached.at < ttl) return cached.wire
  }

  const responsesProbe = await probeRequest({
    baseUrl,
    path: '/responses',
    apiKey: params.apiKey,
    model: params.model,
    payload: { model: params.model, input: 'hi', max_output_tokens: 1, stream: false },
  })
  const responsesVerdict = classifyProbeResponse({
    ...responsesProbe,
    endpoint: 'responses',
  })
  let wire: ProviderWireKind
  if (responsesVerdict === 'responses' || responsesVerdict === 'chat') {
    wire = responsesVerdict
  } else {
    const chatProbe = await probeRequest({
      baseUrl,
      path: '/chat/completions',
      apiKey: params.apiKey,
      model: params.model,
      payload: {
        model: params.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      },
    })
    const chatVerdict = classifyProbeResponse({
      ...chatProbe,
      endpoint: 'chat',
    })
    wire = chatVerdict === 'chat' ? 'chat' : 'unknown'
  }

  probeCache.set(key, {
    wire,
    at: Date.now(),
  })
  probeLogger.info({
    action: 'codex_gateway.wire_probe',
    message: `Provider wire probe for ${params.model} on ${baseUrl} resolved as ${wire}`,
    details: {
      model: params.model,
      baseUrl,
      wire,
      responsesStatus: responsesProbe.status,
      networkError: responsesProbe.networkError,
    },
  })
  if (wire === 'unknown' && responsesVerdict === 'auth') {
    probeLogger.warn({
      action: 'codex_gateway.wire_probe_auth',
      message: `Provider ${baseUrl} rejected the wire probe with an auth error; the real request will surface the same failure`,
      details: { model: params.model, baseUrl },
    })
  }
  return wire
}

/** Drop the cached verdict (for example after a real request 404s on the assumed wire). */
export function forgetWireProbe(baseUrl: string, model: string): void {
  const normalized = normalizeBaseUrl(baseUrl)
  probeCache.delete(cacheKey(normalized, model))
}
