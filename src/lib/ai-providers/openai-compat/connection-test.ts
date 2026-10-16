import { ApiError } from '@/lib/api-errors'
import { createAiProviderFailureAdapter } from '@/lib/ai-providers/failure'
import { probeProviderWire } from '@/lib/codex-model-gateway/wire-probe'
import { createAiSdkConnectionTester } from '@/lib/ai-providers/shared/connection-test'
import type {
  AiProviderConnectionTestReport,
  AiProviderConnectionTestStep,
  AiProviderConnectionTester,
  AiProviderLlmConnectionInput,
  AiProviderLlmConnectionResult,
} from '@/lib/ai-providers/runtime-types'
import { createOpenAiCompatLanguageModel } from './language-model'

const baseTester = createAiSdkConnectionTester({
  providerKey: 'openai-compat',
  failure: createAiProviderFailureAdapter('openai-compat'),
  displayName: 'OpenAI Compatible',
  defaultBaseUrl: '',
  defaultTestModel: '',
  protocol: 'openai-compatible-chat',
  createLanguageModel: createOpenAiCompatLanguageModel,
})

const baseTestLlm = baseTester.testLlm

function requireModel(input: AiProviderLlmConnectionInput): string {
  const model = input.model?.trim() ?? ''
  if (!model) {
    throw new ApiError('INVALID_PARAMS', { message: 'Missing model' })
  }
  return model
}

function wireStep(input: {
  readonly model: string
  readonly wire: 'responses' | 'chat' | 'unknown'
}): AiProviderConnectionTestStep {
  if (input.wire === 'responses') {
    return {
      name: 'wire',
      status: 'pass',
      messageKey: 'connectionTest.responsesSupported',
      model: input.model,
      diagnostic: 'Responses API: supported',
    }
  }
  if (input.wire === 'chat') {
    return {
      name: 'wire',
      status: 'pass',
      messageKey: 'connectionTest.chatOnly',
      model: input.model,
      diagnostic: 'Chat Completions only (Responses API unavailable)',
    }
  }
  return {
    name: 'wire',
    status: 'pass',
    messageKey: 'connectionTest.wireUnknown',
    model: input.model,
    diagnostic: 'Provider wire unverified; Chat Completions is used by default',
  }
}

export const openAiCompatConnectionTester: AiProviderConnectionTester = {
  testLlm: async (input): Promise<AiProviderLlmConnectionResult> => {
    requireModel(input)
    if (!baseTestLlm) {
      throw new ApiError('INVALID_PARAMS', { message: 'Connection tester unavailable' })
    }
    return await baseTestLlm(input)
  },
  diagnose: async (input): Promise<AiProviderConnectionTestReport> => {
    const report = await baseTester.diagnose(input)
    if (!report.success) return report
    const model = (input.llmModel ?? '').trim()
    const baseUrl = (input.baseUrl ?? '').trim()
    if (!model || !baseUrl) return report
    let wire: 'responses' | 'chat' | 'unknown'
    try {
      wire = await probeProviderWire({
        baseUrl,
        apiKey: input.apiKey,
        model,
      })
    } catch {
      return report
    }
    return {
      success: true,
      steps: [...report.steps, wireStep({ model, wire })],
    }
  },
}
