import type { AiLlmProtocol } from '@/lib/ai-registry/types'

/**
 * Provider-level fallback LLM protocol.
 *
 * User channels under these provider keys can expose arbitrary model IDs that
 * have no builtin capability-catalog entry; their LLM traffic uses the wire
 * protocol declared here instead of failing LLM_PROTOCOL_NOT_REGISTERED.
 */
export const PROVIDER_DEFAULT_LLM_PROTOCOL: Readonly<Record<string, AiLlmProtocol>> = {
  'openai-compat': 'openai-compatible-chat',
}
