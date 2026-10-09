import { resolveBuiltinCapabilitiesByModelKey } from '@/lib/ai-registry/capabilities-catalog'
import { getProviderKey, parseModelKeyStrict } from '@/lib/ai-registry/selection'
import { PROVIDER_DEFAULT_LLM_PROTOCOL } from '@/lib/ai-registry/llm-protocol-defaults'
import type { AiLlmProtocol, AiPublicReasoningMode } from '@/lib/ai-registry/types'

function resolveDefaultLlmProtocolForModelKey(modelKey: string): AiLlmProtocol | undefined {
  const parsed = parseModelKeyStrict(modelKey)
  if (!parsed) return undefined
  return PROVIDER_DEFAULT_LLM_PROTOCOL[getProviderKey(parsed.provider)]
}

export function resolveRegisteredLlmProtocol(modelKey: string): AiLlmProtocol {
  const protocol = resolveBuiltinCapabilitiesByModelKey('llm', modelKey)?.llm?.protocol
  if (protocol) return protocol
  // 用户自定义渠道（如 OpenAI 兼容）的任意模型 ID 没有内置目录条目，
  // 回退到 provider 级默认协议。
  const fallback = resolveDefaultLlmProtocolForModelKey(modelKey)
  if (!fallback) {
    throw new Error(`LLM_PROTOCOL_NOT_REGISTERED:${modelKey}`)
  }
  return fallback
}

export function resolveRegisteredPublicReasoningMode(modelKey: string): AiPublicReasoningMode {
  const llm = resolveBuiltinCapabilitiesByModelKey('llm', modelKey)?.llm
  if (llm?.protocol) {
    return llm.publicReasoningMode ?? 'none'
  }
  if (resolveDefaultLlmProtocolForModelKey(modelKey)) return 'none'
  throw new Error(`LLM_PROTOCOL_NOT_REGISTERED:${modelKey}`)
}
