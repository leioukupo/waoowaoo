import { createHash } from 'node:crypto'
import { readRequestBufferWithLimit } from '@/lib/http/body-limits'
import { fetchWithProviderProxy } from '@/lib/http/outbound-proxy'
import { createScopedLogger } from '@/lib/logging/core'
import {
  CODEX_MODEL_GATEWAY_ASSISTANT_ID,
  CodexModelGatewayError,
  type CodexModelGatewayScope,
} from './contracts'
import { resolveCodexModelGatewayUpstream } from './selection'
import { requireCodexModelGatewayModelActiveTurn } from './active-turn-guard'
import { projectCodexProviderResponse } from './error-projection'
import { editionBilling } from '@/lib/edition/current/billing'
import { InsufficientBalanceError } from '@/lib/billing/errors'
import { attachOpenRouterRealtimeBilling } from './openrouter-realtime-billing'
import { resolveAiProviderAdapter } from '@/lib/ai-providers'
import { getDeploymentConfig } from '@/lib/deployment/config'
import { AppError } from '@/lib/errors/app-error'
import { projectProviderCredentialOwnership } from '@/lib/errors/failure'
import { EXTERNAL_OPERATION } from '@/lib/external-operation/registry'
import {
  cancelCodexProviderAttempt,
  claimCodexProviderAttempt,
  failCodexProviderAttempt,
} from './provider-attempt'
import { observeCodexProviderSuccessResponse } from './provider-response-observer'
import {
  ADAPTIVE_STRIP_PARAMS,
  createResponsesBridgeFromChatResponse,
  markChatParamIncompatible,
  translateResponsesToChatRequest,
} from './chat-bridge'
import { forgetWireProbe } from './wire-probe'
import {
  markResponsesAdjustments,
  normalizeResponsesRequestCompat,
  parseResponsesAdjustments,
} from './responses-compat'
import { isOpenAiCompatibleProvider } from './selection'

const CODEX_MODEL_REQUEST_MAX_BYTES = 16 * 1024 * 1024

const gatewayLogger = createScopedLogger({ module: 'codex-gateway.model' })

type ProviderRequestDiagnostics = {
  readonly bodyBytes: number
  readonly inputItems: number
  readonly inputTypeCounts: Readonly<Record<string, number>>
  readonly toolDefinitions: number
  readonly toolStructure: ReadonlyArray<{
    readonly type: string | null
    readonly name: string | null
    readonly fields: readonly string[]
    readonly formatType: string | null
    readonly formatFields: readonly string[]
    readonly formatBytes: number
    readonly grammarDefinitionCharacters: number
    readonly descriptionCharacters: number
    readonly parametersBytes: number
  }>
  readonly instructionCharacters: number
  readonly topLevelFields: readonly string[]
  readonly include: readonly string[]
  readonly parallelToolCalls: boolean | null
  readonly toolChoiceType: string | null
  readonly reasoningFields: readonly string[]
  readonly reasoningEffort: string | null
  readonly reasoningSummary: string | null
  readonly reasoningContextType: string
  readonly reasoningContextValue: string | null
  readonly reasoningContextFields: readonly string[]
  readonly reasoningContextBytes: number
  readonly textFields: readonly string[]
  readonly textVerbosity: string | null
  readonly clientMetadataFields: readonly string[]
  readonly promptCacheKeyCharacters: number
}

function providerToolStructure(toolValue: unknown): ProviderRequestDiagnostics['toolStructure'][number] {
  const tool = isRecord(toolValue) ? toolValue : {}
  const format = isRecord(tool.format) ? tool.format : {}
  return {
    type: typeof tool.type === 'string' ? tool.type : null,
    name: typeof tool.name === 'string' ? tool.name : null,
    fields: Object.keys(tool).sort(),
    formatType: typeof format.type === 'string' ? format.type : null,
    formatFields: Object.keys(format).sort(),
    formatBytes: tool.format === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(tool.format), 'utf8'),
    grammarDefinitionCharacters: typeof format.definition === 'string'
      ? format.definition.length
      : 0,
    descriptionCharacters: typeof tool.description === 'string'
      ? tool.description.length
      : 0,
    parametersBytes: tool.parameters === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(tool.parameters), 'utf8'),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function providerInputTypeCounts(values: readonly unknown[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const value of values) {
    const type = isRecord(value) && typeof value.type === 'string'
      ? value.type
      : 'unknown'
    counts[type] = (counts[type] ?? 0) + 1
  }
  return counts
}

function validateResponsesEndpoint(request: Request): void {
  const url = new URL(request.url)
  if (
    !url.pathname.endsWith('/api/internal/codex-runtime/model/responses')
    || url.search
    || url.hash
  ) {
    throw new CodexModelGatewayError('REQUEST_ENDPOINT_INVALID', 404)
  }
}

function readInstructionMessage(item: Record<string, unknown>): string | null {
  if (item.type !== 'message') return null
  if (item.role !== 'developer' && item.role !== 'system') return null
  if (!Array.isArray(item.content) || item.content.length === 0) {
    throw new CodexModelGatewayError('REQUEST_INSTRUCTIONS_INVALID', 400)
  }
  const parts = item.content.map((part) => {
    if (
      !isRecord(part)
      || part.type !== 'input_text'
      || typeof part.text !== 'string'
      || !part.text.trim()
    ) {
      throw new CodexModelGatewayError('REQUEST_INSTRUCTIONS_INVALID', 400)
    }
    return part.text
  })
  return parts.join('\n\n')
}

function isUnreplayableReasoningItem(item: Record<string, unknown>): boolean {
  return item.type === 'reasoning'
    && (typeof item.encrypted_content !== 'string' || !item.encrypted_content.trim())
}

function readAdditionalTools(item: Record<string, unknown>): readonly unknown[] | null {
  if (item.type !== 'additional_tools') return null
  if (item.role !== 'developer' || !Array.isArray(item.tools)) {
    throw new CodexModelGatewayError('REQUEST_TOOLS_INVALID', 400)
  }
  return item.tools
}

/**
 * Codex may append current-Turn developer context after Product View history.
 * OpenRouter's Anthropic-compatible routes translate that item to a mid-history
 * system message and reject the otherwise valid Responses request. The gateway
 * is the single provider adaptation boundary, so it lifts every instruction
 * message into canonical top-level `instructions`. Codex 0.146 also emits its
 * tool registry as an `additional_tools` developer item; Responses Providers
 * require those definitions in the top-level `tools` field. All remaining
 * user, assistant, tool and replayable reasoning items preserve their order.
 */
export function normalizeCodexProviderRequest(body: Record<string, unknown>): void {
  const topLevel = body.instructions
  if (topLevel !== undefined && topLevel !== null && typeof topLevel !== 'string') {
    throw new CodexModelGatewayError('REQUEST_INSTRUCTIONS_INVALID', 400)
  }
  if (!Array.isArray(body.input)) return

  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new CodexModelGatewayError('REQUEST_TOOLS_INVALID', 400)
  }

  const instructions = typeof topLevel === 'string' && topLevel.trim()
    ? [topLevel]
    : []
  const tools = Array.isArray(body.tools) ? [...body.tools] : []
  const input: unknown[] = []
  for (const item of body.input) {
    if (!isRecord(item)) {
      input.push(item)
      continue
    }
    const additionalTools = readAdditionalTools(item)
    if (additionalTools) {
      tools.push(...additionalTools)
      continue
    }
    // With `store: false`, only encrypted reasoning output is a replayable
    // Provider input. An interrupted stream can persist a summary-only item;
    // replaying it next to the following encrypted item makes OpenAI reject the
    // request because the encrypted payload is bound to a different item id.
    if (isUnreplayableReasoningItem(item)) continue
    const instruction = readInstructionMessage(item)
    if (instruction === null) input.push(item)
    else instructions.push(instruction)
  }
  body.input = input
  if (instructions.length > 0) body.instructions = instructions.join('\n\n')
  if (tools.length > 0) body.tools = tools
}

async function readCodexModelRequest(request: Request): Promise<{
  readonly parsed: Record<string, unknown>
  readonly runtimeTurnId: string
}> {
  const contentType = request.headers.get('content-type')?.toLowerCase()
    || ''
  if (!contentType.startsWith('application/json')) {
    throw new CodexModelGatewayError('REQUEST_CONTENT_TYPE_INVALID', 415)
  }
  let body: Buffer
  try {
    body = await readRequestBufferWithLimit(
      request,
      CODEX_MODEL_REQUEST_MAX_BYTES,
      'Codex Responses request',
    )
  } catch (error) {
    throw new CodexModelGatewayError('REQUEST_BODY_READ_FAILED', 400, error)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown
  } catch (error) {
    throw new CodexModelGatewayError('REQUEST_BODY_JSON_INVALID', 400, error)
  }
  if (!isRecord(parsed)) {
    throw new CodexModelGatewayError('REQUEST_BODY_JSON_INVALID', 400)
  }
  const clientMetadata = isRecord(parsed.client_metadata) ? parsed.client_metadata : null
  const runtimeTurnId = clientMetadata?.turn_id
  if (
    typeof runtimeTurnId !== 'string'
    || runtimeTurnId !== runtimeTurnId.trim()
    || runtimeTurnId.length === 0
    || runtimeTurnId.length > 191
  ) {
    throw new CodexModelGatewayError('REQUEST_TURN_IDENTITY_INVALID', 400)
  }
  return { parsed, runtimeTurnId }
}

function normalizeAndValidateBody(params: {
  readonly parsed: Record<string, unknown>
  readonly runtimeModelId: string
  readonly upstreamModelId: string
}): {
  readonly body: Buffer
  readonly parsed: Record<string, unknown>
  readonly diagnostics: ProviderRequestDiagnostics
} {
  const { parsed } = params
  if (parsed.model !== params.runtimeModelId) {
    throw new CodexModelGatewayError('REQUEST_MODEL_MISMATCH', 403)
  }
  normalizeCodexProviderRequest(parsed)
  parsed.model = params.upstreamModelId
  const normalizedBody = Buffer.from(JSON.stringify(parsed), 'utf8')
  return {
    body: normalizedBody,
    parsed,
    diagnostics: {
      bodyBytes: normalizedBody.byteLength,
      inputItems: Array.isArray(parsed.input) ? parsed.input.length : 0,
      inputTypeCounts: Array.isArray(parsed.input)
        ? providerInputTypeCounts(parsed.input)
        : {},
      toolDefinitions: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      toolStructure: Array.isArray(parsed.tools)
        ? parsed.tools.map(providerToolStructure)
        : [],
      instructionCharacters: typeof parsed.instructions === 'string'
        ? parsed.instructions.length
        : 0,
      topLevelFields: Object.keys(parsed).sort(),
      include: Array.isArray(parsed.include)
        ? parsed.include.filter((entry): entry is string => typeof entry === 'string')
        : [],
      parallelToolCalls: typeof parsed.parallel_tool_calls === 'boolean'
        ? parsed.parallel_tool_calls
        : null,
      toolChoiceType: typeof parsed.tool_choice === 'string'
        ? parsed.tool_choice
        : isRecord(parsed.tool_choice) && typeof parsed.tool_choice.type === 'string'
          ? parsed.tool_choice.type
          : null,
      reasoningFields: isRecord(parsed.reasoning) ? Object.keys(parsed.reasoning).sort() : [],
      reasoningEffort: isRecord(parsed.reasoning) && typeof parsed.reasoning.effort === 'string'
        ? parsed.reasoning.effort
        : null,
      reasoningSummary: isRecord(parsed.reasoning) && typeof parsed.reasoning.summary === 'string'
        ? parsed.reasoning.summary
        : null,
      reasoningContextType: isRecord(parsed.reasoning)
        ? Array.isArray(parsed.reasoning.context)
          ? 'array'
          : parsed.reasoning.context === null
            ? 'null'
            : typeof parsed.reasoning.context
        : 'missing',
      reasoningContextValue: isRecord(parsed.reasoning) && typeof parsed.reasoning.context === 'string'
        ? parsed.reasoning.context
        : null,
      reasoningContextFields: isRecord(parsed.reasoning) && isRecord(parsed.reasoning.context)
        ? Object.keys(parsed.reasoning.context).sort()
        : [],
      reasoningContextBytes: isRecord(parsed.reasoning) && parsed.reasoning.context !== undefined
        ? Buffer.byteLength(JSON.stringify(parsed.reasoning.context), 'utf8')
        : 0,
      textFields: isRecord(parsed.text) ? Object.keys(parsed.text).sort() : [],
      textVerbosity: isRecord(parsed.text) && typeof parsed.text.verbosity === 'string'
        ? parsed.text.verbosity
        : null,
      clientMetadataFields: isRecord(parsed.client_metadata)
        ? Object.keys(parsed.client_metadata).sort()
        : [],
      promptCacheKeyCharacters: typeof parsed.prompt_cache_key === 'string'
        ? parsed.prompt_cache_key.length
        : 0,
    },
  }
}

function readProviderRequestId(response: Response): string | null {
  for (const name of ['x-request-id', 'x-oai-request-id', 'cf-ray']) {
    const value = response.headers.get(name)?.trim()
    if (value && value.length <= 256) return value
  }
  return null
}

/**
 * One Responses API POST. Successful streams stay transparent; failures are
 * normalized once into Codex's official error vocabulary. Usage events remain
 * in the Provider body and this bridge never creates a second usage, billing,
 * or terminal writer.
 */
export async function proxyCodexResponsesRequest(params: {
  readonly request: Request
  readonly scope: {
    readonly userId: string
    readonly projectId: string
    readonly assistantId: string
    readonly nonce: string
  }
}): Promise<Response> {
  validateResponsesEndpoint(params.request)
  if (params.scope.assistantId !== CODEX_MODEL_GATEWAY_ASSISTANT_ID) {
    throw new CodexModelGatewayError('SCOPE_INVALID', 403)
  }
  const scope: CodexModelGatewayScope = {
    userId: params.scope.userId,
    projectId: params.scope.projectId,
    assistantId: CODEX_MODEL_GATEWAY_ASSISTANT_ID,
  }
  const modelRequest = await readCodexModelRequest(params.request)
  const activeTurn = await requireCodexModelGatewayModelActiveTurn(
    scope,
    params.scope.nonce,
    modelRequest.runtimeTurnId,
  )
  try {
    await editionBilling.assertLlmSpendableBalance(scope.userId)
  } catch (error) {
    if (error instanceof InsufficientBalanceError) {
      throw new CodexModelGatewayError('BILLING_BALANCE_INSUFFICIENT', 429, error)
    }
    throw error
  }
  const upstream = await resolveCodexModelGatewayUpstream(scope)
  const providerRequest = normalizeAndValidateBody({
    parsed: modelRequest.parsed,
    runtimeModelId: upstream.runtimeModelId,
    upstreamModelId: upstream.modelId,
  })
  let body = providerRequest.body
  const parsed: Record<string, unknown> = providerRequest.parsed
  // Providers whose /responses implementation deviates from the OpenAI API
  // surface (OpenAI-compatible channels, e.g. DeepSeek native) get a
  // deterministic pre-normalization; other providers only get the
  // adjustments they previously proved through an error.
  const compatChanges: string[] = []
  normalizeResponsesRequestCompat({
    parsed,
    baseUrl: upstream.providerBaseUrl,
    proactive: isOpenAiCompatibleProvider(upstream.providerKey),
    changes: compatChanges,
  })
  if (compatChanges.length > 0) {
    body = Buffer.from(JSON.stringify(parsed), 'utf8')
  }
  const requestedAccept = params.request.headers.get('accept')?.toLowerCase()
    || ''
  const accept = requestedAccept.includes('text/event-stream')
    ? 'text/event-stream'
    : 'application/json'
  const providerAttempt = await claimCodexProviderAttempt({
    projectId: scope.projectId,
    userId: scope.userId,
    turnId: activeTurn.turnId,
    runtimeAttempt: activeTurn.attempt,
    providerKey: upstream.providerKey,
    modelKey: upstream.modelKey,
    requestHash: createHash('sha256')
      .update(body)
      .update('\0', 'utf8')
      .update(accept, 'utf8')
      .digest('hex'),
  })
  const providerRequestStartedAt = Date.now()
  gatewayLogger.info({
    action: 'codex_gateway.provider_request_started',
    message: 'Codex model request is being sent to the Provider',
    projectId: scope.projectId,
    userId: scope.userId,
    details: {
      turnId: activeTurn.turnId,
      providerAttemptId: providerAttempt.id,
      modelKey: upstream.modelKey,
      accept,
      ...(compatChanges.length > 0 ? { compatChanges } : {}),
      ...providerRequest.diagnostics,
    },
  })

  if (upstream.wire === 'chat' && upstream.chatEndpoint) {
    return await executeCodexChatBridgeRequest({
      request: params.request,
      scope,
      activeTurn,
      providerAttempt,
      upstream,
      parsed,
      providerRequestStartedAt,
    })
  }

  const responsesEndpoint = upstream.responsesEndpoint
  if (!responsesEndpoint) {
    throw new CodexModelGatewayError('PROVIDER_BASE_URL_INVALID', 503)
  }
  let currentBody = body
  let response: Response
  let headerGenerationId: string | null = null
  let providerRequestId: string | null = null
  for (let compatRetry = 0; ; compatRetry += 1) {
    try {
      response = await fetchWithProviderProxy(responsesEndpoint, {
        method: 'POST',
        headers: {
          Accept: accept,
          Authorization: `Bearer ${upstream.providerApiKey}`,
          'Content-Type': 'application/json',
        },
        body: new Uint8Array(currentBody),
        redirect: 'error',
        signal: params.request.signal,
      })
    } catch (error: unknown) {
      if (params.request.signal.aborted) {
        await cancelCodexProviderAttempt(providerAttempt)
        params.request.signal.throwIfAborted()
      }
      const sourceFailure = projectProviderCredentialOwnership(
        resolveAiProviderAdapter(upstream.providerKey).failure.normalize({
          error,
          phase: 'submit',
          operation: EXTERNAL_OPERATION.PROVIDER_SUBMIT,
        }),
        getDeploymentConfig().providerCredentialMode,
      )
      await failCodexProviderAttempt(providerAttempt, { failure: sourceFailure })
      gatewayLogger.warn({
        action: 'codex_gateway.provider_request_failed',
        message: 'Codex model Provider request failed before receiving a response',
        projectId: scope.projectId,
        userId: scope.userId,
        details: {
          turnId: activeTurn.turnId,
          modelKey: upstream.modelKey,
        },
      })
      throw new CodexModelGatewayError(
        'PROVIDER_REQUEST_FAILED',
        500,
        AppError.fromFailure(sourceFailure, error),
      )
    }
    headerGenerationId = response.headers.get('x-generation-id')
    providerRequestId = readProviderRequestId(response)
    gatewayLogger.info({
      action: 'codex_gateway.provider_response_headers',
      message: 'Codex model Provider response headers received',
      projectId: scope.projectId,
      userId: scope.userId,
      details: {
        turnId: activeTurn.turnId,
        providerAttemptId: providerAttempt.id,
        modelKey: upstream.modelKey,
        compatRetry,
        elapsedMs: Date.now() - providerRequestStartedAt,
        providerStatus: response.status,
        providerRequestId,
        providerGenerationId: headerGenerationId,
        contentType: response.headers.get('content-type'),
        contentEncoding: response.headers.get('content-encoding'),
        contentLength: response.headers.get('content-length'),
      },
    })
    if (!response.ok) {
      // A 400/422 whose body names a rejected part of the request shape
      // (custom tool, tool_choice variant, reasoning.summary variant,
      // tools[i] variant) is answered by adjusting the body and retrying,
      // mirroring the chat bridge's parameter stripping.
      const rawText = (await response.text().catch(() => '')).slice(0, 16_384)
      let retried = false
      if (compatRetry < 2) {
        const adjustments = parseResponsesAdjustments(rawText)
        if (adjustments.length > 0) {
          markResponsesAdjustments(upstream.providerBaseUrl, adjustments)
          const retryChanges: string[] = []
          normalizeResponsesRequestCompat({
            parsed,
            baseUrl: upstream.providerBaseUrl,
            proactive: false,
            changes: retryChanges,
          })
          if (retryChanges.length > 0) {
            currentBody = Buffer.from(JSON.stringify(parsed), 'utf8')
            gatewayLogger.info({
              action: 'codex_gateway.responses_compat_retry',
              message: 'Provider rejected the Responses request shape; retrying with the adjusted body',
              projectId: scope.projectId,
              userId: scope.userId,
              details: {
                turnId: activeTurn.turnId,
                providerAttemptId: providerAttempt.id,
                modelKey: upstream.modelKey,
                providerStatus: response.status,
                providerRequestId,
                changes: retryChanges,
              },
            })
            retried = true
          }
        }
        if (retried) continue
      }
      if (!retried) {
        const rebuiltHeaders = new Headers()
        const contentType = response.headers.get('content-type')?.trim()
        if (contentType) rebuiltHeaders.set('Content-Type', contentType)
        const retryAfter = response.headers.get('retry-after')?.trim()
        if (retryAfter) rebuiltHeaders.set('Retry-After', retryAfter)
        rebuiltHeaders.set('Cache-Control', 'no-store')
        response = new Response(rawText, {
          status: response.status,
          statusText: response.statusText,
          headers: rebuiltHeaders,
        })
      }
    }
    if (!response.ok) {
      // No parseable adjustment (or retry budget exhausted): surface it.
      break
    }
    // Success: stop retrying.
    break
  }
  let projection: Awaited<ReturnType<typeof projectCodexProviderResponse>>
  try {
    projection = await projectCodexProviderResponse(response, upstream.providerKey)
  } catch (error: unknown) {
    const sourceFailure = projectProviderCredentialOwnership(
      resolveAiProviderAdapter(upstream.providerKey).failure.normalize({
        error,
        phase: 'result',
        operation: EXTERNAL_OPERATION.PROVIDER_SUBMIT,
      }),
      getDeploymentConfig().providerCredentialMode,
    )
    await failCodexProviderAttempt(providerAttempt, {
      failure: sourceFailure,
      providerStatus: response.status,
      providerRequestId,
      providerGenerationId: headerGenerationId,
    })
    throw new CodexModelGatewayError(
      'PROVIDER_REQUEST_FAILED',
      500,
      AppError.fromFailure(sourceFailure, error),
    )
  }
  if (projection.failureKind) {
    if (!projection.failure) throw new Error('CODEX_PROVIDER_PROJECTED_FAILURE_MISSING')
    await failCodexProviderAttempt(providerAttempt, {
      failure: projection.failure,
      providerStatus: projection.providerStatus,
      providerRequestId,
      providerGenerationId: headerGenerationId,
    })
    gatewayLogger.warn({
      action: 'codex_gateway.provider_response_failed',
      message: 'Codex model Provider returned a non-success response',
      projectId: scope.projectId,
      userId: scope.userId,
      details: {
        turnId: activeTurn.turnId,
        modelKey: upstream.modelKey,
        providerStatus: projection.providerStatus,
        providerCode: projection.providerCode,
        providerErrorType: projection.providerErrorType,
        providerRequestId,
        providerGenerationId: headerGenerationId,
        failureKind: projection.failureKind,
      },
    })
  }
  if (projection.failureKind) return projection.response
  const observedResponse = await observeCodexProviderSuccessResponse({
    response: projection.response,
    attempt: providerAttempt,
    requestSignal: params.request.signal,
    providerKey: upstream.providerKey,
    providerRequestId,
    headerGenerationId,
    projectId: scope.projectId,
    userId: scope.userId,
    turnId: activeTurn.turnId,
    modelKey: upstream.modelKey,
    responseStartedAt: providerRequestStartedAt,
  })
  if (upstream.providerKey !== 'openrouter') return observedResponse
  return attachOpenRouterRealtimeBilling({
    response: observedResponse,
    headerGenerationId,
    userId: scope.userId,
    projectId: scope.projectId,
    turnId: activeTurn.turnId,
    modelKey: upstream.modelKey,
  })
}

/**
 * Chat Completions fallback for OpenAI-compatible providers without a
 * Responses endpoint. The translated request is retried at most twice when
 * the provider rejects an optional parameter (400 naming it); every other
 * failure settles the provider attempt and surfaces Codex's error vocabulary.
 */
async function executeCodexChatBridgeRequest(params: {
  readonly request: Request
  readonly scope: CodexModelGatewayScope
  readonly activeTurn: Awaited<ReturnType<typeof requireCodexModelGatewayModelActiveTurn>>
  readonly providerAttempt: Awaited<ReturnType<typeof claimCodexProviderAttempt>>
  readonly upstream: Awaited<ReturnType<typeof resolveCodexModelGatewayUpstream>>
  readonly parsed: Record<string, unknown>
  readonly providerRequestStartedAt: number
}): Promise<Response> {
  const { scope, activeTurn, providerAttempt, upstream } = params
  const parsed = params.parsed
  const buildChatBody = () => translateResponsesToChatRequest({
    body: parsed,
    modelId: upstream.modelId,
    baseUrl: upstream.providerBaseUrl,
  })

  for (let loop = 0; ; loop += 1) {
    let response: Response
    try {
      response = await fetchWithProviderProxy(upstream.chatEndpoint as string, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          ...(upstream.providerApiKey
            ? { Authorization: `Bearer ${upstream.providerApiKey}` }
            : {}),
          'Content-Type': 'application/json',
        },
        body: new TextEncoder().encode(buildChatBody()),
        redirect: 'error',
        signal: params.request.signal,
      })
    } catch (error: unknown) {
      if (params.request.signal.aborted) {
        await cancelCodexProviderAttempt(providerAttempt)
        params.request.signal.throwIfAborted()
      }
      const sourceFailure = projectProviderCredentialOwnership(
        resolveAiProviderAdapter(upstream.providerKey).failure.normalize({
          error,
          phase: 'submit',
          operation: EXTERNAL_OPERATION.PROVIDER_SUBMIT,
        }),
        getDeploymentConfig().providerCredentialMode,
      )
      await failCodexProviderAttempt(providerAttempt, { failure: sourceFailure })
      gatewayLogger.warn({
        action: 'codex_gateway.chat_bridge_request_failed',
        message: 'Codex chat-bridge request failed before receiving a response',
        projectId: scope.projectId,
        userId: scope.userId,
        details: {
          turnId: activeTurn.turnId,
          providerAttemptId: providerAttempt.id,
          modelKey: upstream.modelKey,
          chatEndpoint: upstream.chatEndpoint,
        },
      })
      throw new CodexModelGatewayError(
        'PROVIDER_REQUEST_FAILED',
        500,
        AppError.fromFailure(sourceFailure, error),
      )
    }

    const providerRequestId = readProviderRequestId(response)
    const headerGenerationId = response.headers.get('x-generation-id')
    gatewayLogger.info({
      action: 'codex_gateway.chat_bridge_response_headers',
      message: 'Codex chat-bridge Provider response received',
      projectId: scope.projectId,
      userId: scope.userId,
      details: {
        turnId: activeTurn.turnId,
        providerAttemptId: providerAttempt.id,
        modelKey: upstream.modelKey,
        chatEndpoint: upstream.chatEndpoint,
        elapsedMs: Date.now() - params.providerRequestStartedAt,
        providerStatus: response.status,
        providerRequestId,
      },
    })
    if (!response.ok) {
      const errorText = (await response.text().catch(() => '')).slice(0, 4_096)
      if (response.status === 404) {
        // The Chat endpoint does not exist: the probe verdict was wrong or the
        // base URL is misconfigured. Drop the cached verdict so the next
        // request re-probes, and surface a configuration error.
        forgetWireProbe(upstream.providerBaseUrl, upstream.modelId)
        const sourceFailure = projectProviderCredentialOwnership(
          resolveAiProviderAdapter(upstream.providerKey).failure.normalize({
            error: {
              name: 'ProviderEndpointMissing',
              message: `Chat Completions endpoint not found: ${upstream.chatEndpoint}. ${errorText.slice(0, 512)}`.trim(),
              statusCode: 404,
            },
            phase: 'submit',
            operation: EXTERNAL_OPERATION.PROVIDER_SUBMIT,
          }),
          getDeploymentConfig().providerCredentialMode,
        )
        await failCodexProviderAttempt(providerAttempt, {
          failure: sourceFailure,
          providerStatus: 404,
          providerRequestId,
        })
        gatewayLogger.warn({
          action: 'codex_gateway.chat_bridge_endpoint_missing',
          message: 'Codex chat-bridge endpoint not found; the base URL may be misconfigured',
          projectId: scope.projectId,
          userId: scope.userId,
          details: {
            turnId: activeTurn.turnId,
            providerAttemptId: providerAttempt.id,
            modelKey: upstream.modelKey,
            chatEndpoint: upstream.chatEndpoint,
            providerError: errorText.slice(0, 512),
          },
        })
        throw new CodexModelGatewayError(
          'PROVIDER_BASE_URL_INVALID',
          503,
          AppError.fromFailure(sourceFailure),
        )
      }
      if (response.status === 400 && loop < 2) {
        const rejectedParam = (ADAPTIVE_STRIP_PARAMS as readonly string[])
          .find((param) => errorText.toLowerCase().includes(param))
        if (rejectedParam) {
          markChatParamIncompatible(upstream.providerBaseUrl, rejectedParam)
          gatewayLogger.info({
            action: 'codex_gateway.chat_bridge_param_stripped',
            message: `Provider rejected the ${rejectedParam} parameter; retrying the chat request without it`,
            projectId: scope.projectId,
            userId: scope.userId,
            details: {
              turnId: activeTurn.turnId,
              providerAttemptId: providerAttempt.id,
              modelKey: upstream.modelKey,
              chatEndpoint: upstream.chatEndpoint,
              rejectedParam,
            },
          })
          continue
        }
      }
      const sourceFailure = projectProviderCredentialOwnership(
        resolveAiProviderAdapter(upstream.providerKey).failure.normalize({
          error: {
            name: 'ProviderRequestRejected',
            message: errorText.slice(0, 2_000)
              || `Provider returned HTTP ${String(response.status)}`,
            statusCode: response.status,
          },
          phase: 'submit',
          operation: EXTERNAL_OPERATION.PROVIDER_SUBMIT,
        }),
        getDeploymentConfig().providerCredentialMode,
      )
      await failCodexProviderAttempt(providerAttempt, {
        failure: sourceFailure,
        providerStatus: response.status,
        providerRequestId,
        providerGenerationId: headerGenerationId,
      })
      gatewayLogger.warn({
        action: 'codex_gateway.chat_bridge_request_rejected',
        message: 'Codex chat-bridge request was rejected by the Provider',
        projectId: scope.projectId,
        userId: scope.userId,
        details: {
          turnId: activeTurn.turnId,
          providerAttemptId: providerAttempt.id,
          modelKey: upstream.modelKey,
          chatEndpoint: upstream.chatEndpoint,
          providerStatus: response.status,
          providerError: errorText.slice(0, 512),
        },
      })
      throw new CodexModelGatewayError(
        'PROVIDER_REQUEST_FAILED',
        500,
        AppError.fromFailure(sourceFailure),
      )
    }

    const bridge = createResponsesBridgeFromChatResponse(
      {
        response,
        modelId: upstream.runtimeModelId,
        instructions: typeof parsed.instructions === 'string'
          ? parsed.instructions
          : undefined,
        tools: Array.isArray(parsed.tools) ? parsed.tools : undefined,
        temperature: typeof parsed.temperature === 'number'
          ? parsed.temperature
          : undefined,
        maxOutputTokens: typeof parsed.max_output_tokens === 'number'
          ? parsed.max_output_tokens
          : undefined,
      },
      params.request.signal,
    )
    const bridged = new Response(bridge.stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
    gatewayLogger.info({
      action: 'codex_gateway.chat_bridge_stream_started',
      message: 'Codex chat-bridge is translating the Provider stream into the Responses wire',
      projectId: scope.projectId,
      userId: scope.userId,
      details: {
        turnId: activeTurn.turnId,
        providerAttemptId: providerAttempt.id,
        modelKey: upstream.modelKey,
        chatEndpoint: upstream.chatEndpoint,
        providerRequestId,
      },
    })
    return await observeCodexProviderSuccessResponse({
      response: bridged,
      attempt: providerAttempt,
      requestSignal: params.request.signal,
      providerKey: upstream.providerKey,
      providerRequestId,
      headerGenerationId,
      projectId: scope.projectId,
      userId: scope.userId,
      turnId: activeTurn.turnId,
      modelKey: upstream.modelKey,
      responseStartedAt: params.providerRequestStartedAt,
    })
  }
}
