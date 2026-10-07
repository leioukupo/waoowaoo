import type { ParsedAsyncExternalId } from '@/lib/ai-providers/async-task-types'

const OPENROUTER_EXTERNAL_ID_PREFIX = 'OPENROUTER:'
const PROVIDER_TOKEN_MARKER = ':provider='

function decodeProviderToken(value: string, externalId: string): string {
  try {
    const decoded = decodeURIComponent(value).trim()
    if (!decoded) throw new Error('EMPTY')
    return decoded
  } catch {
    throw new Error(`无效 OPENROUTER externalId: "${externalId}"，provider channel 无法解析`)
  }
}

/**
 * OpenRouter video jobs historically used OPENROUTER:VIDEO:<requestId>.
 * Keep that wire shape for the default provider and append an encoded provider
 * identity only for custom channels. The provider identity is part of the
 * durable external id because polling may happen after the user's active
 * provider list has changed.
 */
export function parseOpenRouterExternalId(externalId: string): ParsedAsyncExternalId {
  if (!externalId.startsWith(OPENROUTER_EXTERNAL_ID_PREFIX)) {
    throw new Error(`无效 OPENROUTER externalId: "${externalId}"`)
  }

  const typeMarker = externalId.indexOf(':', OPENROUTER_EXTERNAL_ID_PREFIX.length)
  const type = typeMarker === -1
    ? ''
    : externalId.slice(OPENROUTER_EXTERNAL_ID_PREFIX.length, typeMarker)
  if (type !== 'VIDEO') {
    throw new Error(`无效 OPENROUTER externalId: "${externalId}"，TYPE 仅支持 VIDEO`)
  }

  const payloadStart = typeMarker + 1
  const providerMarker = externalId.lastIndexOf(PROVIDER_TOKEN_MARKER)
  const hasProviderToken = providerMarker >= payloadStart
  const requestId = externalId.slice(
    payloadStart,
    hasProviderToken ? providerMarker : externalId.length,
  )
  if (!requestId) {
    throw new Error(`无效 OPENROUTER externalId: "${externalId}"，缺少 requestId`)
  }

  return {
    provider: 'OPENROUTER',
    type: 'VIDEO',
    requestId,
    ...(hasProviderToken
      ? { providerToken: decodeProviderToken(externalId.slice(providerMarker + PROVIDER_TOKEN_MARKER.length), externalId) }
      : {}),
  }
}

export function formatOpenRouterExternalId(input: {
  type: 'VIDEO'
  requestId: string
  providerToken?: string
}): string {
  const requestId = input.requestId.trim()
  if (!requestId) throw new Error('OPENROUTER externalId requires requestId')

  const providerToken = input.providerToken?.trim()
  if (!providerToken || providerToken.toLowerCase() === 'openrouter') {
    return `${OPENROUTER_EXTERNAL_ID_PREFIX}${input.type}:${requestId}`
  }

  return `${OPENROUTER_EXTERNAL_ID_PREFIX}${input.type}:${requestId}${PROVIDER_TOKEN_MARKER}${encodeURIComponent(providerToken)}`
}
