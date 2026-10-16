import { resolveAiProviderAdapter } from '@/lib/ai-providers'
import { readProviderJsonResponse } from '@/lib/ai-providers/failure'
import { getDeploymentConfig } from '@/lib/deployment/config'
import {
  projectProviderCredentialOwnership,
  type FailureRecord,
} from '@/lib/errors/failure'
import {
  cancelCodexProviderAttempt,
  failCodexProviderAttempt,
  succeedCodexProviderAttempt,
  type CodexProviderAttemptIdentity,
} from './provider-attempt'
import { createScopedLogger } from '@/lib/logging/core'

const MAX_SSE_EVENT_CHARS = 20 * 1024 * 1024
const providerObserverLogger = createScopedLogger({ module: 'codex-gateway.model' })

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown, maxLength = 4_000): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function readSseData(block: string): unknown {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return null
  try {
    return JSON.parse(data) as unknown
  } catch {
    return null
  }
}

function providerFailure(
  source: unknown,
  phase: 'result' | 'stream',
  providerKey: string,
): FailureRecord {
  const failure = resolveAiProviderAdapter(providerKey).failure.normalize({
    error: source,
    phase,
  })
  return projectProviderCredentialOwnership(
    failure,
    getDeploymentConfig().providerCredentialMode,
  )
}

function streamFailureSource(payload: Record<string, unknown>): unknown {
  const response = isRecord(payload.response) ? payload.response : payload
  const error = isRecord(response.error) ? response.error : null
  const message = readString(error?.message)
    ?? 'OpenRouter stream reported response.failed'
  return {
    name: 'OpenRouterStreamFailure',
    message,
    code: readString(error?.code, 256),
    errorEnvelope: payload,
  }
}

function nonStreamFailureSource(payload: Record<string, unknown>): unknown {
  const error = isRecord(payload.error) ? payload.error : null
  return {
    name: 'OpenRouterResponseFailure',
    message: readString(error?.message)
      ?? `OpenRouter returned terminal response status ${readString(payload.status, 256) ?? 'unknown'}`,
    code: readString(error?.code, 256) ?? readString(payload.status, 256),
    errorEnvelope: payload,
  }
}

function streamDisconnectedSource(cause?: unknown): unknown {
  return {
    name: 'OpenRouterStreamDisconnected',
    message: 'OpenRouter stream ended without response.completed or response.failed',
    code: 'response_stream_disconnected',
    ...(cause === undefined ? {} : { cause }),
  }
}

function responseIdentity(
  payload: Record<string, unknown>,
  headerGenerationId: string | null,
): string | null {
  const response = isRecord(payload.response) ? payload.response : payload
  return readString(response.id, 256) ?? headerGenerationId
}

export async function observeCodexProviderSuccessResponse(input: {
  readonly response: Response
  readonly attempt: CodexProviderAttemptIdentity
  readonly requestSignal: AbortSignal
  readonly providerKey?: string
  readonly providerRequestId: string | null
  readonly headerGenerationId: string | null
  readonly projectId?: string
  readonly userId?: string
  readonly turnId?: string
  readonly modelKey?: string
  readonly responseStartedAt?: number
}): Promise<Response> {
  const providerKey = input.providerKey ?? 'openrouter'
  const turnId = input.turnId ?? input.attempt.turnId
  const modelKey = input.modelKey ?? input.attempt.modelKey
  const responseStartedAt = input.responseStartedAt ?? Date.now()
  const contentType = input.response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('text/event-stream')) {
    let payload: unknown
    try {
      payload = await readProviderJsonResponse({
        response: input.response,
        provider: providerKey,
        phase: 'result',
      })
    } catch (error: unknown) {
      await failCodexProviderAttempt(input.attempt, {
        failure: providerFailure(error, 'result', providerKey),
        providerStatus: input.response.status,
        providerRequestId: input.providerRequestId,
        providerGenerationId: input.headerGenerationId,
      })
      throw error
    }
    const record = isRecord(payload) ? payload : null
    const status = readString(record?.status, 256)
    const type = readString(record?.type, 256)
    const generationId = readString(record?.id, 256) ?? input.headerGenerationId
    if (record && (status === 'completed' || status === 'incomplete' || type === 'response.completed')) {
      await succeedCodexProviderAttempt(input.attempt, {
        providerStatus: input.response.status,
        providerRequestId: input.providerRequestId,
        providerGenerationId: generationId,
      })
      return new Response(JSON.stringify(payload), {
        status: input.response.status,
        statusText: input.response.statusText,
        headers: input.response.headers,
      })
    }
    const source = nonStreamFailureSource(record ?? {
      status: 'invalid_response_envelope',
      payload,
    })
    await failCodexProviderAttempt(input.attempt, {
      failure: providerFailure(source, 'result', providerKey),
      providerStatus: input.response.status,
      providerRequestId: input.providerRequestId,
      providerGenerationId: generationId,
    })
    return new Response(JSON.stringify(payload), {
      status: input.response.status,
      statusText: input.response.statusText,
      headers: input.response.headers,
    })
  }
  if (!input.response.body) {
    const source = streamDisconnectedSource()
    await failCodexProviderAttempt(input.attempt, {
      failure: providerFailure(source, 'stream', providerKey),
      providerStatus: input.response.status,
      providerRequestId: input.providerRequestId,
      providerGenerationId: input.headerGenerationId,
    })
    throw new Error('CODEX_PROVIDER_STREAM_BODY_MISSING', { cause: source })
  }

  const reader = input.response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let terminalObserved = false
  let settlementStarted = false
  let firstProviderEventObserved = false
  let firstPullObserved = false
  let firstChunkObserved = false

  const consumeBlock = async (block: string): Promise<void> => {
    const payload = readSseData(block)
    if (!isRecord(payload)) return
    if (!firstProviderEventObserved) {
      firstProviderEventObserved = true
      providerObserverLogger.info({
        action: 'codex_gateway.provider_first_event',
        message: 'Codex model Provider first SSE event received',
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        details: {
          turnId,
          providerAttemptId: input.attempt.id,
          modelKey,
          elapsedMs: Date.now() - responseStartedAt,
          eventType: readString(payload.type, 256),
          providerRequestId: input.providerRequestId,
          providerGenerationId: responseIdentity(payload, input.headerGenerationId),
        },
      })
    }
    if (payload.type === 'response.failed') {
      const source = streamFailureSource(payload)
      settlementStarted = true
      await failCodexProviderAttempt(input.attempt, {
        failure: providerFailure(source, 'stream', providerKey),
        providerStatus: input.response.status,
        providerRequestId: input.providerRequestId,
        providerGenerationId: responseIdentity(payload, input.headerGenerationId),
      })
      terminalObserved = true
      return
    }
    if (payload.type === 'response.completed') {
      settlementStarted = true
      await succeedCodexProviderAttempt(input.attempt, {
        providerStatus: input.response.status,
        providerRequestId: input.providerRequestId,
        providerGenerationId: responseIdentity(payload, input.headerGenerationId),
      })
      terminalObserved = true
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!firstPullObserved) {
          firstPullObserved = true
          providerObserverLogger.info({
            action: 'codex_gateway.provider_stream_pull_started',
            message: 'Codex model Provider response stream consumption started',
            ...(input.projectId ? { projectId: input.projectId } : {}),
            ...(input.userId ? { userId: input.userId } : {}),
            details: {
              turnId,
              providerAttemptId: input.attempt.id,
              modelKey,
              elapsedMs: Date.now() - responseStartedAt,
              providerRequestId: input.providerRequestId,
              providerGenerationId: input.headerGenerationId,
            },
          })
        }
        const next = await reader.read()
        if (!firstChunkObserved) {
          firstChunkObserved = true
          providerObserverLogger.info({
            action: 'codex_gateway.provider_first_chunk',
            message: 'Codex model Provider first response stream chunk received',
            ...(input.projectId ? { projectId: input.projectId } : {}),
            ...(input.userId ? { userId: input.userId } : {}),
            details: {
              turnId,
              providerAttemptId: input.attempt.id,
              modelKey,
              elapsedMs: Date.now() - responseStartedAt,
              done: next.done,
              chunkBytes: next.done ? 0 : next.value.byteLength,
              providerRequestId: input.providerRequestId,
              providerGenerationId: input.headerGenerationId,
            },
          })
        }
        if (next.done) {
          buffer += decoder.decode()
          if (buffer) {
            await consumeBlock(buffer)
            buffer = ''
          }
          if (!terminalObserved) {
            const source = streamDisconnectedSource()
            settlementStarted = true
            await failCodexProviderAttempt(input.attempt, {
              failure: providerFailure(source, 'stream', providerKey),
              providerStatus: input.response.status,
              providerRequestId: input.providerRequestId,
              providerGenerationId: input.headerGenerationId,
            })
          }
          controller.close()
          return
        }
        buffer += decoder.decode(next.value, { stream: true })
        while (true) {
          const delimiter = /\r?\n\r?\n/u.exec(buffer)
          if (!delimiter || delimiter.index === undefined) break
          const end = delimiter.index + delimiter[0].length
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end)
          await consumeBlock(frame.slice(0, -delimiter[0].length))
        }
        if (buffer.length > MAX_SSE_EVENT_CHARS) {
          const source = {
            name: 'OpenRouterStreamEventTooLarge',
            message: `OpenRouter SSE event exceeded ${String(MAX_SSE_EVENT_CHARS)} characters`,
            code: 'response_stream_event_too_large',
          }
          settlementStarted = true
          await failCodexProviderAttempt(input.attempt, {
            failure: providerFailure(source, 'stream', providerKey),
            providerStatus: input.response.status,
            providerRequestId: input.providerRequestId,
            providerGenerationId: input.headerGenerationId,
          })
          terminalObserved = true
          await reader.cancel(source)
          controller.error(new Error('CODEX_PROVIDER_STREAM_EVENT_TOO_LARGE', { cause: source }))
          return
        }
        // Successful Provider streams are byte-transparent. Observation keeps
        // its own parsing buffer but must never wait for a complete SSE frame
        // before forwarding a network chunk: large events routinely span
        // multiple chunks, and withholding a partial frame creates a
        // backpressure deadlock between the Runtime and the Provider.
        controller.enqueue(next.value)
      } catch (error: unknown) {
        if (!terminalObserved && !settlementStarted) {
          settlementStarted = true
          if (input.requestSignal.aborted) {
            await cancelCodexProviderAttempt(input.attempt, {
              providerStatus: input.response.status,
              providerRequestId: input.providerRequestId,
              providerGenerationId: input.headerGenerationId,
            })
          } else {
            const source = streamDisconnectedSource(error)
            await failCodexProviderAttempt(input.attempt, {
              failure: providerFailure(source, 'stream', providerKey),
              providerStatus: input.response.status,
              providerRequestId: input.providerRequestId,
              providerGenerationId: input.headerGenerationId,
            })
          }
          terminalObserved = true
        }
        controller.error(error)
      }
    },
    async cancel(reason) {
      if (!terminalObserved && !settlementStarted) {
        settlementStarted = true
        await cancelCodexProviderAttempt(input.attempt, {
          providerStatus: input.response.status,
          providerRequestId: input.providerRequestId,
          providerGenerationId: input.headerGenerationId,
        })
        terminalObserved = true
      }
      await reader.cancel(reason)
    },
  })
  return new Response(stream, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: input.response.headers,
  })
}
