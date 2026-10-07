import { describeUnknownError } from '@/lib/errors/normalize'
import { HTTPClient, OpenRouter } from '@openrouter/sdk'
import { fetchWithProviderProxy, shouldProxyProviderUrl } from '@/lib/http/outbound-proxy'
import { createScopedLogger } from '@/lib/logging/core'

const logger = createScopedLogger({
  module: 'ai-provider.openrouter.video-transport',
  provider: 'openrouter',
})

function readRequestLogTarget(rawUrl: string): { providerHost: string; providerPath: string } {
  try {
    const url = new URL(rawUrl)
    return {
      providerHost: url.host,
      providerPath: url.pathname,
    }
  } catch {
    return {
      providerHost: 'invalid',
      providerPath: 'invalid',
    }
  }
}

function readAbortReasonForLog(signal: AbortSignal): {
  abortReasonName: string | null
  abortReasonMessage: string | null
} {
  const reason = signal.reason
  if (reason instanceof Error) {
    return {
      abortReasonName: reason.name,
      abortReasonMessage: reason.message,
    }
  }
  return {
    abortReasonName: reason == null ? null : typeof reason,
    abortReasonMessage: reason == null ? null : describeUnknownError(reason),
  }
}

export function serializeErrorForLog(error: unknown): {
  name?: string
  message?: string
  code?: string
} {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
    }
  }
  return { message: describeUnknownError(error) }
}

async function fetchOpenRouterSdkRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  configuredTimeoutMs: number,
): Promise<Response> {
  if (!(input instanceof Request)) {
    return await fetchWithProviderProxy(input, init)
  }

  const startedAt = Date.now()
  const target = readRequestLogTarget(input.url)
  const proxyEnabled = shouldProxyProviderUrl(input.url)
  const isSubmit = input.method === 'POST'
  let phase: 'body_prepare' | 'provider_transport' = 'body_prepare'
  let requestBodyBytes = 0
  let bodyPreparationDurationMs = 0
  let transportStartedAt: number | null = null

  try {
    const bodyPreparationStartedAt = Date.now()
    const methodHasBody = input.method !== 'GET' && input.method !== 'HEAD'
    const body = methodHasBody ? await input.arrayBuffer() : undefined
    requestBodyBytes = body?.byteLength ?? 0
    bodyPreparationDurationMs = Date.now() - bodyPreparationStartedAt
    phase = 'provider_transport'

    if (isSubmit) {
      logger.info({
        action: 'openrouter.video.submit.request_prepared',
        message: 'OpenRouter video submit request prepared',
        details: {
          method: input.method,
          ...target,
          requestBodyBytes,
          bodyPreparationDurationMs,
          configuredTimeoutMs,
          proxyEnabled,
          signalAborted: input.signal.aborted,
        },
      })
    }

    transportStartedAt = Date.now()
    const response = await fetchWithProviderProxy(input.url, {
      method: input.method,
      headers: input.headers,
      ...(body && body.byteLength > 0 ? { body } : {}),
      signal: input.signal,
      cache: input.cache,
      ...init,
    })

    if (isSubmit) {
      logger.info({
        action: 'openrouter.video.submit.response_received',
        message: 'OpenRouter video submit response received',
        durationMs: Date.now() - startedAt,
        details: {
          method: input.method,
          ...target,
          status: response.status,
          statusText: response.statusText,
          requestBodyBytes,
          bodyPreparationDurationMs,
          configuredTimeoutMs,
          providerTransportDurationMs: Date.now() - transportStartedAt,
          proxyEnabled,
        },
      })
    }

    return response
  } catch (error) {
    logger.error({
      action: isSubmit
        ? 'openrouter.video.submit.transport_failed'
        : 'openrouter.video.status.transport_failed',
      message: isSubmit
        ? 'OpenRouter video submit transport failed'
        : 'OpenRouter video status transport failed',
      durationMs: Date.now() - startedAt,
      details: {
        method: input.method,
        ...target,
        phase,
        requestBodyBytes,
        bodyPreparationDurationMs,
        configuredTimeoutMs,
        providerTransportDurationMs: transportStartedAt === null
          ? null
          : Date.now() - transportStartedAt,
        proxyEnabled,
        signalAborted: input.signal.aborted,
        ...readAbortReasonForLog(input.signal),
      },
      error: serializeErrorForLog(error),
    })
    throw error
  }
}

export function createOpenRouterVideoClient(input: {
  baseUrl: string
  apiKey: string
  timeoutMs: number
}): OpenRouter {
  return new OpenRouter({
    apiKey: input.apiKey,
    serverURL: input.baseUrl,
    httpClient: new HTTPClient({
      fetcher: async (requestInput, requestInit) => await fetchOpenRouterSdkRequest(
        requestInput,
        requestInit,
        input.timeoutMs,
      ),
    }),
    retryConfig: { strategy: 'none' },
    timeoutMs: input.timeoutMs,
  })
}

/** Best-effort cancellation for providers exposing the OpenRouter video job API. */
export async function cancelOpenRouterVideoRequest(input: {
  baseUrl: string
  apiKey: string
  requestId: string
}): Promise<void> {
  const endpoint = `${input.baseUrl.replace(/\/+$/u, '')}/videos/${encodeURIComponent(input.requestId)}`
  const response = await fetchWithProviderProxy(endpoint, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(60_000),
  })
  if (response.ok || response.status === 404 || response.status === 409) return
  throw new Error(`OPENROUTER_VIDEO_CANCEL_FAILED:${response.status}`)
}
