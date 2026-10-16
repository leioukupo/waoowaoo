import { z } from 'zod'
import { testLlmConnection } from '@/lib/ai-exec/llm-test-connection'
import { testProviderConnection } from '@/lib/ai-exec/provider-test'
import { probeProviderWire } from '@/lib/codex-model-gateway/wire-probe'
import { getProviderKey } from '@/lib/ai-registry/selection'
import type { ProjectAgentOperationRegistryDraft } from '@/lib/operations/types'
import { getProviderConfig } from '@/lib/user-api/runtime-config'
import { assertUserProviderConfigurationAvailable } from '@/lib/user-api/availability'

const providerDiagnosticInputSchema = z.object({
  providerId: z.string().trim().min(1),
  apiType: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  llmModel: z.string().trim().min(1).optional(),
}).strict()

export function createUserApiConfigConnectionDiagnosticOperations(): ProjectAgentOperationRegistryDraft {
  return {
    api_user_api_config_test_connection: {
      id: 'api_user_api_config_test_connection',
      summary: 'API-only: Test LLM connection with user-provided provider/baseUrl/apiKey.',
      intent: 'act',
      effects: {
        writes: false,
        billable: false,
        destructive: false,
        overwrite: false,
        bulk: false,
        externalSideEffects: true,
        longRunning: true,
      },
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async (_ctx, input) => {
        assertUserProviderConfigurationAvailable()
        const startedAt = Date.now()
        const payload = input as Parameters<typeof testLlmConnection>[0]
        const result = await testLlmConnection(payload)
        const wire = await probeOpenAiCompatWire(payload)
        return {
          success: true,
          ...(wire ? { wire } : {}),
          latencyMs: Date.now() - startedAt,
          ...result,
        }
      },
    },

    api_user_api_config_test_provider: {
      id: 'api_user_api_config_test_provider',
      summary: 'API-only: Run provider multi-step connection diagnostics.',
      intent: 'act',
      effects: {
        writes: false,
        billable: false,
        destructive: false,
        overwrite: false,
        bulk: false,
        externalSideEffects: true,
        longRunning: true,
      },
      inputSchema: providerDiagnosticInputSchema,
      outputSchema: z.unknown(),
      execute: async (ctx, input) => {
        assertUserProviderConfigurationAvailable()
        const startedAt = Date.now()
        const parsed = providerDiagnosticInputSchema.parse(input)
        const storedProvider = parsed.apiKey
          ? null
          : await getProviderConfig(ctx.userId, parsed.providerId)
        const payload: Parameters<typeof testProviderConnection>[0] = {
          apiType: parsed.apiType,
          apiKey: parsed.apiKey ?? storedProvider?.apiKey ?? '',
          baseUrl: parsed.baseUrl ?? storedProvider?.baseUrl,
          llmModel: parsed.llmModel,
        }
        const result = await testProviderConnection(payload)
        return {
          ...result,
          latencyMs: Date.now() - startedAt,
        }
      },
    },
  }
}

type LlmConnectionPayload = {
  provider?: string
  apiKey?: string
  baseUrl?: string
  model?: string
}

/**
 * Best-effort wire probe for OpenAI-compatible channels: reports whether the
 * endpoint speaks the OpenAI Responses API or only Chat Completions, so the
 * UI can explain how assistant sessions will reach the provider.
 */
async function probeOpenAiCompatWire(payload: LlmConnectionPayload): Promise<string | null> {
  const provider = typeof payload.provider === 'string'
    ? payload.provider.trim().toLowerCase()
    : ''
  if (getProviderKey(provider).toLowerCase() !== 'openai-compat') return null
  const baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : ''
  const model = typeof payload.model === 'string' ? payload.model.trim() : ''
  if (!baseUrl || !model) return null
  try {
    return await probeProviderWire({
      baseUrl,
      apiKey: typeof payload.apiKey === 'string' ? payload.apiKey : '',
      model,
    })
  } catch {
    return null
  }
}
