import { findBuiltinCapabilities } from '@/lib/ai-registry/capabilities-catalog'
import { getProviderKey } from '@/lib/ai-registry/selection'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { resolveLlmRuntimeModel } from '@/lib/ai-exec/llm-runtime'
import { getUserModelConfig } from '@/lib/config-service'
import { getProviderConfig } from '@/lib/user-api/runtime-config'
import { verifyWaoRuntimeToken } from '@/lib/wao-mcp/runtime-token'
import { probeProviderWire } from './wire-probe'
import {
  CODEX_MODEL_GATEWAY_ASSISTANT_ID,
  CODEX_MODEL_GATEWAY_PATH,
  CODEX_MODEL_GATEWAY_PROVIDER_ID,
  CODEX_RUNTIME_BEARER_ENV_KEY,
  CodexModelGatewayError,
  type CodexModelGatewayRuntimeConfig,
  type CodexModelGatewayScope,
} from './contracts'

function baseProviderKey(provider: string): string {
  return getProviderKey(provider).toLowerCase()
}

export function isOpenAiCompatibleProvider(provider: string): boolean {
  return baseProviderKey(provider) === 'openai-compat'
}

function requireIdentity(value: string): string {
  if (!value || value !== value.trim()) {
    throw new CodexModelGatewayError('SCOPE_INVALID', 403)
  }
  return value
}

export function normalizeCodexModelGatewayScope(
  scope: CodexModelGatewayScope,
): CodexModelGatewayScope {
  const userId = requireIdentity(scope.userId)
  const projectId = requireIdentity(scope.projectId)
  if (scope.assistantId !== CODEX_MODEL_GATEWAY_ASSISTANT_ID) {
    throw new CodexModelGatewayError('SCOPE_INVALID', 403)
  }
  return {
    userId,
    projectId,
    assistantId: CODEX_MODEL_GATEWAY_ASSISTANT_ID,
  }
}

function parseBaseUrl(
  value: string,
  errorCode: 'PROVIDER_BASE_URL_INVALID' | 'RUNTIME_BASE_URL_INVALID',
): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new CodexModelGatewayError(errorCode, 503)
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new CodexModelGatewayError(errorCode, 503)
  }
  return parsed
}

function buildResponsesEndpoint(baseUrl: string): string {
  const parsed = parseBaseUrl(baseUrl, 'PROVIDER_BASE_URL_INVALID')
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/responses`
  return parsed.toString()
}

function buildRuntimeGatewayBaseUrl(runtimeReachableWaoBaseUrl: string): string {
  const parsed = parseBaseUrl(
    runtimeReachableWaoBaseUrl,
    'RUNTIME_BASE_URL_INVALID',
  )
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}${CODEX_MODEL_GATEWAY_PATH}`
  return parsed.toString().replace(/\/$/u, '')
}

function resolveCodexRuntimeModelId(upstreamModelId: string): string {
  const openAiPrefix = 'openai/'
  if (upstreamModelId.startsWith(openAiPrefix)) {
    const modelId = upstreamModelId.slice(openAiPrefix.length)
    if (modelId) return modelId
  }
  return upstreamModelId
}

async function resolveSelectedAssistantModel(scope: CodexModelGatewayScope) {
  const config = await getUserModelConfig(scope.userId)
  const modelKey = config.assistantModel?.trim() || ''
  if (!modelKey) {
    throw new CodexModelGatewayError(
      'ASSISTANT_MODEL_NOT_CONFIGURED',
      422,
    )
  }

  let selection: Awaited<ReturnType<typeof resolveLlmRuntimeModel>>
  try {
    selection = await resolveLlmRuntimeModel(scope.userId, modelKey)
  } catch {
    throw new CodexModelGatewayError('ASSISTANT_MODEL_UNSUPPORTED', 422)
  }
  let wire: 'responses' | 'chat'
  if (baseProviderKey(selection.provider) === 'openrouter') {
    // OpenRouter routes the Responses wire natively for the curated
    // catalog models; the capability entry is the source of truth.
    ensureAiCatalogsRegistered()
    const codexRuntimeWireApi = findBuiltinCapabilities(
      'llm',
      selection.provider,
      selection.modelId,
    )?.llm?.codexRuntimeWireApi
    if (codexRuntimeWireApi !== 'responses') {
      throw new CodexModelGatewayError(
        'PROVIDER_RESPONSES_UNSUPPORTED',
        422,
      )
    }
    wire = 'responses'
  } else if (isOpenAiCompatibleProvider(selection.provider)) {
    // OpenAI-compatible channels may only implement Chat Completions; the
    // wire is probed (cached) after the provider config is resolved.
    wire = 'chat'
  } else {
    throw new CodexModelGatewayError(
      'PROVIDER_RESPONSES_UNSUPPORTED',
      422,
    )
  }

  let providerConfig: Awaited<ReturnType<typeof getProviderConfig>>
  try {
    providerConfig = await getProviderConfig(
      scope.userId,
      selection.provider,
    )
  } catch {
    throw new CodexModelGatewayError(
      'PROVIDER_CONFIG_UNAVAILABLE',
      503,
    )
  }
  const providerBaseUrl = providerConfig.baseUrl?.trim() || ''
  if (!providerBaseUrl) {
    throw new CodexModelGatewayError('PROVIDER_BASE_URL_INVALID', 503)
  }
  if (isOpenAiCompatibleProvider(selection.provider)) {
    wire = await resolveOpenAiCompatibleWire({
      baseUrl: providerBaseUrl,
      apiKey: providerConfig.apiKey,
      modelId: selection.modelId,
    })
  }
  return {
    selection,
    providerApiKey: providerConfig.apiKey,
    providerBaseUrl,
    wire,
  }
}

/**
 * Determines which wire an OpenAI-compatible endpoint actually speaks. The
 * probe is best-effort and cached per (baseUrl, model); an inconclusive
 * result falls back to the Chat Completions bridge, which every
 * OpenAI-compatible server implements.
 */
async function resolveOpenAiCompatibleWire(params: {
  readonly baseUrl: string
  readonly apiKey: string
  readonly modelId: string
}): Promise<'responses' | 'chat'> {
  try {
    const wire = await probeProviderWire({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      model: params.modelId,
    })
    return wire === 'responses' ? 'responses' : 'chat'
  } catch {
    return 'chat'
  }
}

export async function resolveCodexModelGatewayUpstream(
  scopeValue: CodexModelGatewayScope,
): Promise<{
  readonly runtimeModelId: string
  readonly modelId: string
  readonly modelKey: string
  readonly providerKey: string
  readonly providerBaseUrl: string
  readonly wire: 'responses' | 'chat'
  readonly responsesEndpoint: string | null
  readonly chatEndpoint: string | null
  readonly providerApiKey: string
}> {
  const scope = normalizeCodexModelGatewayScope(scopeValue)
  const resolved = await resolveSelectedAssistantModel(scope)
  const base = resolved.providerBaseUrl.replace(/\/+$/u, '')
  return {
    runtimeModelId: resolveCodexRuntimeModelId(resolved.selection.modelId),
    modelId: resolved.selection.modelId,
    modelKey: resolved.selection.modelKey,
    providerKey: resolved.selection.provider,
    providerBaseUrl: resolved.providerBaseUrl,
    wire: resolved.wire,
    responsesEndpoint: resolved.wire === 'responses'
      ? buildResponsesEndpoint(resolved.providerBaseUrl)
      : null,
    chatEndpoint: resolved.wire === 'chat'
      ? `${base}/chat/completions`
      : null,
    providerApiKey: resolved.providerApiKey,
  }
}

/**
 * Produces the complete custom-provider projection consumed by the assistant
 * runtime. Provider credentials never cross this boundary; the returned token
 * is the exact Wao project capability already used by MCP.
 */
export async function resolveCodexModelGatewayRuntimeConfig(params: {
  readonly scope: CodexModelGatewayScope
  readonly runtimeReachableWaoBaseUrl: string
  readonly runtimeBearerToken: string
}): Promise<CodexModelGatewayRuntimeConfig> {
  const scope = normalizeCodexModelGatewayScope(params.scope)
  const tokenScope = verifyWaoRuntimeToken(params.runtimeBearerToken)
  if (
    tokenScope.userId !== scope.userId
    || tokenScope.projectId !== scope.projectId
    || tokenScope.assistantId !== scope.assistantId
  ) {
    throw new CodexModelGatewayError(
      'RUNTIME_TOKEN_SCOPE_MISMATCH',
      403,
    )
  }
  const resolved = await resolveSelectedAssistantModel(scope)
  return {
    runtimeModelId: resolveCodexRuntimeModelId(resolved.selection.modelId),
    modelId: resolved.selection.modelId,
    modelKey: resolved.selection.modelKey,
    modelProviderId: CODEX_MODEL_GATEWAY_PROVIDER_ID,
    baseUrl: buildRuntimeGatewayBaseUrl(
      params.runtimeReachableWaoBaseUrl,
    ),
    wireApi: 'responses',
    bearerTokenEnvironmentKey: CODEX_RUNTIME_BEARER_ENV_KEY,
    bearerToken: params.runtimeBearerToken,
    requestMaxRetries: 1,
    streamMaxRetries: 2,
  }
}
