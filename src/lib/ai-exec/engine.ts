import type { GenerateResult } from '@/lib/ai-providers/runtime-types'
import type {
  AiModality,
  AiLlmExecutionResult,
  AiStepExecutionInput,
  AiStepExecutionResult,
  AiVisionStepExecutionInput,
  AiVisionStepExecutionResult,
  AiLlmCallOptions,
  AiLlmStreamCallbacks,
  ChatMessage,
} from '@/lib/ai-registry/types'
import {
  getProviderConfig,
  resolveModelSelection,
  resolveFrozenModelSelection,
  resolveOpenRouterChannelRouteSet,
} from '@/lib/user-api/runtime-config'
import {
  resolveAiProviderAdapter,
  runRegisteredProviderOperation,
} from '@/lib/ai-providers'
import { normalizeMediaOptionsForSelection } from '@/lib/ai-exec/media-preflight'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { runLlmCompletion, runLlmStream } from '@/lib/ai-exec/llm/completion-runner'
import {
  runVisionCompletion,
  runVisionStream,
} from '@/lib/ai-exec/llm/vision-runner'
import { parseStoredAiLlmExecutionResult } from '@/lib/ai-exec/llm/result-projector'
import { AppError, toAppError } from '@/lib/errors/app-error'
import { getLogContext } from '@/lib/logging/context'
import {
  cancelAsyncProviderTaskBestEffort,
  ProviderQueueTimeoutError,
  waitForAsyncProviderResult,
  type AsyncProviderWaitCallbacks,
} from '@/lib/ai-exec/async-wait'
import { ProviderTaskFailureError } from '@/lib/ai-exec/provider-errors'
import { EXTERNAL_OPERATION } from '@/lib/external-operation/registry'
import { resolveReasoningEffort } from '@/lib/ai-exec/reasoning-effort'
import {
  createMediaProviderRequestIdentity,
} from '@/lib/ai-exec/media-references'
import {
  assertSelectionSupportsMediaInputs,
  collectMediaInputKinds,
  resolveCompatibleMediaProviderRoutes,
  type ProviderMediaInputKind,
} from '@/lib/ai-exec/media-input-transport'
import {
  projectImageMediaInputs,
  projectVideoMediaInputs,
} from '@/lib/ai-exec/media-input-projector'
import {
  executeTaskDurableInvocation,
  executeTaskProviderInvocation,
  markTaskProviderInvocationReplayAuthorized,
  type TaskProviderInvocation,
  type TaskProviderInvocationRoute,
} from '@/lib/task/provider-invocation'
import { resolveProviderRouteSet } from '@/lib/ai-registry/provider-route-set'
import type { AiResolvedSelection } from '@/lib/ai-registry/types'
import {
  logMediaModelSelectionResolved,
  summarizeGenerateResult,
  summarizeMediaRequestInput,
  wrapMediaProviderExecution,
} from '@/lib/ai-exec/media-observe'
import type { MusicCompositionPlan } from '@/lib/music/composition-plan'

export type AiMediaExecutionModality = Extract<AiModality, 'image' | 'video' | 'music' | 'voice'>

export type AiImageExecutionOptions = {
  referenceImages?: string[]
  aspectRatio?: string
  resolution?: string
  outputFormat?: string
  keepOriginalAspectRatio?: boolean
  size?: string
  quality?: string
  responseFormat?: string
  background?: string
  outputCompression?: number
  moderation?: string
  [key: string]: string | number | boolean | string[] | undefined
}

export type AiVideoExecutionOptions = {
  prompt?: string
  duration?: number
  resolution?: string
  aspectRatio?: string
  generateAudio?: boolean
  lastFrameImageUrl?: string
  referenceImages?: string[]
  referenceAudios?: string[]
  referenceVideos?: string[]
  [key: string]: string | number | boolean | string[] | undefined
}

export type AiMusicExecutionOptions = {
  negativePrompt?: string
  durationSeconds?: number
  vocalMode?: 'instrumental' | 'vocal'
  genre?: string
  mood?: string
  bpm?: number
  outputFormat?: 'mp3' | 'wav'
}

export type AiVoiceExecutionOptions = {
  language?: string
}

export type AiLlmExecutionInput = {
  modality: 'llm'
  userId: string
  model: string | null | undefined
  messages: ChatMessage[]
  options?: AiLlmCallOptions
}

export type AiLlmStreamExecutionInput = AiLlmExecutionInput & {
  callbacks?: AiLlmStreamCallbacks
}

export type AiVisionExecutionInput = {
  modality: 'vision'
  userId: string
  model: string | null | undefined
  textPrompt: string
  imageUrls?: string[]
  options?: AiLlmCallOptions
}

export type AiVisionStreamExecutionInput = AiVisionExecutionInput & {
  callbacks?: AiLlmStreamCallbacks
}

export type AiMediaExecutionInput =
  | {
    modality: 'image'
    userId: string
    modelKey: string
    prompt: string
    options?: AiImageExecutionOptions
  }
  | {
    modality: 'video'
    userId: string
    modelKey: string
    imageUrl: string
    options?: AiVideoExecutionOptions
  }
  | {
    modality: 'music'
    userId: string
    modelKey: string
    generation:
      | { readonly kind: 'prompt'; readonly prompt: string }
      | { readonly kind: 'composition_plan'; readonly compositionPlan: MusicCompositionPlan }
    options?: AiMusicExecutionOptions
  }
  | {
    modality: 'voice'
    userId: string
    modelKey: string
    description: string
    text: string
    options?: AiVoiceExecutionOptions
  }

export async function executeMediaGeneration(
  input: AiMediaExecutionInput,
  invocation?: TaskProviderInvocation,
  wait?: AsyncProviderWaitCallbacks,
): Promise<GenerateResult> {
  ensureAiCatalogsRegistered()
  const selection = invocation
    ? resolveFrozenModelSelection(input.modelKey, input.modality)
    : await resolveModelSelection(input.userId, input.modelKey, input.modality)
  logMediaModelSelectionResolved({
    modality: input.modality,
    provider: selection.provider,
    modelKey: selection.modelKey,
  })
  let mediaInputKinds: ProviderMediaInputKind[] = []
  let executionInput: AiMediaExecutionInput = input
  if (input.modality === 'image') {
    mediaInputKinds = collectMediaInputKinds({ modality: 'image', options: input.options })
    assertSelectionSupportsMediaInputs({
      selection,
      modality: 'image',
      mediaKinds: mediaInputKinds,
    })
    executionInput = {
      ...input,
      options: await projectImageMediaInputs({ userId: input.userId, options: input.options }),
    }
  } else if (input.modality === 'video') {
    mediaInputKinds = collectMediaInputKinds({
      modality: 'video',
      imageUrl: input.imageUrl,
      options: input.options,
    })
    assertSelectionSupportsMediaInputs({
      selection,
      modality: 'video',
      mediaKinds: mediaInputKinds,
    })
    const projected = await projectVideoMediaInputs({
      userId: input.userId,
      imageUrl: input.imageUrl,
      options: input.options,
    })
    executionInput = { ...input, ...projected }
  }
  // Descriptor resolution and option normalization are local preflight. They
  // must finish before executeTaskProviderInvocation claims the durable
  // "submitting" fence; only adapter execution may cross that boundary.
  // The engine owns credential resolution. Provider modules receive the
  // resolved config through the execution context and never import the
  // registry-consuming resolver themselves, which keeps them import-order safe.
  const buildRoute = (routeSelection: AiResolvedSelection): TaskProviderInvocationRoute<GenerateResult> => {
    const adapter = resolveAiProviderAdapter(routeSelection.provider)
    switch (executionInput.modality) {
    case 'image': {
      const modalityAdapter = adapter[executionInput.modality]
      if (!modalityAdapter) {
        throw new Error(`AI_PROVIDER_MODALITY_UNSUPPORTED:${routeSelection.provider}:${executionInput.modality}`)
      }
      const options = normalizeMediaOptionsForSelection({
        selection: routeSelection,
        modality: executionInput.modality,
        options: executionInput.options,
        prompt: executionInput.prompt,
      }) as AiImageExecutionOptions | undefined
      return {
        provider: routeSelection.provider,
        modelKey: routeSelection.modelKey,
        request: createMediaProviderRequestIdentity({ ...input, modelKey: routeSelection.modelKey }),
        execute: async () => await modalityAdapter.execute({
          userId: executionInput.userId,
          providerConfig: await getProviderConfig(executionInput.userId, routeSelection.provider),
          selection: routeSelection,
          prompt: executionInput.prompt,
          options,
        }),
      }
    }
    case 'video': {
      const modalityAdapter = adapter[executionInput.modality]
      if (!modalityAdapter) {
        throw new Error(`AI_PROVIDER_MODALITY_UNSUPPORTED:${routeSelection.provider}:${executionInput.modality}`)
      }
      const options = normalizeMediaOptionsForSelection({
        selection: routeSelection,
        modality: executionInput.modality,
        options: executionInput.options,
        prompt: executionInput.options?.prompt,
      }) as AiVideoExecutionOptions | undefined
      return {
        provider: routeSelection.provider,
        modelKey: routeSelection.modelKey,
        request: createMediaProviderRequestIdentity({ ...input, modelKey: routeSelection.modelKey }),
        execute: async () => await modalityAdapter.execute({
          userId: executionInput.userId,
          providerConfig: await getProviderConfig(executionInput.userId, routeSelection.provider),
          selection: routeSelection,
          imageUrl: executionInput.imageUrl,
          options,
        }),
      }
    }
    case 'music': {
      const modalityAdapter = adapter[executionInput.modality]
      if (!modalityAdapter) {
        throw new Error(`AI_PROVIDER_MODALITY_UNSUPPORTED:${routeSelection.provider}:${executionInput.modality}`)
      }
      const options = normalizeMediaOptionsForSelection({
        selection: routeSelection,
        modality: executionInput.modality,
        options: executionInput.options,
        prompt: executionInput.generation.kind === 'prompt' ? executionInput.generation.prompt : undefined,
        musicGenerationMode: executionInput.generation.kind,
      }) as AiMusicExecutionOptions | undefined
      return {
        provider: routeSelection.provider,
        modelKey: routeSelection.modelKey,
        request: createMediaProviderRequestIdentity({ ...input, modelKey: routeSelection.modelKey }),
        execute: async () => await modalityAdapter.execute({
          userId: executionInput.userId,
          providerConfig: await getProviderConfig(executionInput.userId, routeSelection.provider),
          selection: routeSelection,
          generation: executionInput.generation,
          options,
        }),
      }
    }
    case 'voice': {
      const modalityAdapter = adapter[executionInput.modality]
      if (!modalityAdapter) {
        throw new Error(`AI_PROVIDER_MODALITY_UNSUPPORTED:${routeSelection.provider}:${executionInput.modality}`)
      }
      const options = normalizeMediaOptionsForSelection({
        selection: routeSelection,
        modality: executionInput.modality,
        options: executionInput.options,
        voiceInput: { description: executionInput.description, text: executionInput.text },
      }) as AiVoiceExecutionOptions | undefined
      return {
        provider: routeSelection.provider,
        modelKey: routeSelection.modelKey,
        request: createMediaProviderRequestIdentity({ ...input, modelKey: routeSelection.modelKey }),
        execute: async () => await modalityAdapter.execute({
          userId: executionInput.userId,
          providerConfig: await getProviderConfig(executionInput.userId, routeSelection.provider),
          selection: routeSelection,
          description: executionInput.description,
          text: executionInput.text,
          options,
        }),
      }
    }
    }
  }
  // Logging-only wrapper around the provider execution throat; it swallows its
  // own failures and rethrows execution errors unchanged (no control-flow change).
  const buildObservedRoute = (routeSelection: AiResolvedSelection): TaskProviderInvocationRoute<GenerateResult> => {
    const route = buildRoute(routeSelection)
    return {
      ...route,
      execute: () => wrapMediaProviderExecution(
        {
          provider: route.provider,
          modelKey: route.modelKey,
          modality: input.modality,
          phase: 'execute',
          requestSummary: () => summarizeMediaRequestInput(input),
        },
        async () => await runRegisteredProviderOperation({
          providerId: route.provider,
          phase: 'submit',
          operation: EXTERNAL_OPERATION.PROVIDER_SUBMIT,
          run: route.execute,
        }),
        summarizeGenerateResult,
      ),
    }
  }
  const taskId = getLogContext().taskId
  let result: GenerateResult
  if (!taskId) {
    result = await buildObservedRoute(selection).execute()
  } else {
    if (!invocation) throw new Error(`TASK_PROVIDER_INVOCATION_KEY_REQUIRED:${taskId}:${input.modality}`)
    const routeSet = await resolveOpenRouterChannelRouteSet(input.userId, input.modality, selection)
      ?? resolveProviderRouteSet(input.modality, selection.modelKey)
    const compatibleRoutes = input.modality === 'image' || input.modality === 'video'
      ? resolveCompatibleMediaProviderRoutes({
          routeSet,
          selection,
          modality: input.modality,
          mediaKinds: mediaInputKinds,
        })
      : routeSet.routes
    const routes = compatibleRoutes.map((route) => buildObservedRoute({
      provider: route.provider,
      modelId: route.modelId,
      modelKey: route.modelKey,
      variantSubKind: 'official',
    }))
    result = await executeTaskProviderInvocation({
      taskId,
      invocation,
      modality: input.modality,
      logicalCapabilityId: routeSet.logicalCapabilityId,
      primaryModelKey: routeSet.primaryModelKey,
      routes,
    })
  }

  if ((input.modality !== 'music' && input.modality !== 'voice') || !result.async) return result
  const externalId = result.externalId?.trim()
  if (!externalId) throw new Error(`ASYNC_${input.modality.toUpperCase()}_EXTERNAL_ID_MISSING`)
  try {
    const completed = await wrapMediaProviderExecution(
      {
        provider: selection.provider,
        modelKey: selection.modelKey,
        modality: input.modality,
        phase: 'async_wait',
        requestSummary: () => ({ externalId }),
      },
      () => waitForAsyncProviderResult({
        externalId,
        userId: input.userId,
        beforePoll: wait?.beforePoll,
        onPending: wait?.onPending,
      }),
      (finished) => ({ hasUrl: Boolean(finished.url) }),
    )
    return {
      ...result,
      async: false,
      audioUrl: completed.url,
    }
  } catch (error) {
    if (error instanceof ProviderQueueTimeoutError) {
      const queueError = new AppError('GENERATION_QUEUE_TIMEOUT', error.message, {
        provider: selection.provider,
        details: { externalId, queuedMs: error.queuedMs, queueTimeoutMs: error.queueTimeoutMs },
        cause: error,
      })
      // 顺序契约（PG-06A 排队超时补偿）：先持久化“旧 external id 作废”
      // （checkpoint submitted → replay_authorized），再尽力取消 provider 侧任务；
      // 新提交只能由下一 attempt 经 durable fence 重新授权。此处崩溃最坏留下
      // 一个已被作废、无人消费的孤儿 provider job，不会出现双活身份。
      if (taskId && invocation) {
        await markTaskProviderInvocationReplayAuthorized({ taskId, invocation, error: queueError })
        const replayAuthorized = new AppError('GENERATION_QUEUE_TIMEOUT', error.message, {
          provider: selection.provider,
          details: { externalId, queuedMs: error.queuedMs, queueTimeoutMs: error.queueTimeoutMs },
          operation: EXTERNAL_OPERATION.PROVIDER_SUBMIT_REPLAY_AUTHORIZED,
          cause: queueError,
        })
        await cancelAsyncProviderTaskBestEffort({ externalId, userId: input.userId })
        throw replayAuthorized
      }
      await cancelAsyncProviderTaskBestEffort({ externalId, userId: input.userId })
      throw queueError
    }
    if (error instanceof ProviderTaskFailureError) {
      throw AppError.fromFailure(error.failure, error)
    }
    throw error
  }
}

export async function executeLlmCompletion(input: AiLlmExecutionInput): Promise<AiLlmExecutionResult> {
  return await runLlmCompletion(input.userId, input.model, input.messages, input.options || {})
}

export async function executeLlmStreamCompletion(input: AiLlmStreamExecutionInput): Promise<AiLlmExecutionResult> {
  return await runLlmStream(input.userId, input.model, input.messages, input.options || {}, input.callbacks)
}

export async function executeVisionCompletion(input: AiVisionExecutionInput): Promise<AiLlmExecutionResult> {
  return await runVisionCompletion(
    input.userId,
    input.model,
    input.textPrompt,
    input.imageUrls || [],
    input.options || {},
  )
}

export async function executeVisionStreamCompletion(input: AiVisionStreamExecutionInput): Promise<AiLlmExecutionResult> {
  return await runVisionStream(
    input.userId,
    input.model,
    input.textPrompt,
    input.imageUrls || [],
    input.options || {},
    input.callbacks,
  )
}

export async function generateImage(
  userId: string,
  modelKey: string,
  prompt: string,
  options?: AiImageExecutionOptions,
  invocation?: TaskProviderInvocation,
): Promise<GenerateResult> {
  return await executeMediaGeneration({
    modality: 'image',
    userId,
    modelKey,
    prompt,
    options,
  }, invocation)
}

export async function generateVideo(
  userId: string,
  modelKey: string,
  imageUrl: string,
  options?: AiVideoExecutionOptions,
  invocation?: TaskProviderInvocation,
): Promise<GenerateResult> {
  return await executeMediaGeneration({
    modality: 'video',
    userId,
    modelKey,
    imageUrl,
    options,
  }, invocation)
}

export async function generateMusic(
  userId: string,
  modelKey: string,
  generation:
    | { readonly kind: 'prompt'; readonly prompt: string }
    | { readonly kind: 'composition_plan'; readonly compositionPlan: MusicCompositionPlan },
  options?: AiMusicExecutionOptions,
  invocation?: TaskProviderInvocation,
  wait?: AsyncProviderWaitCallbacks,
): Promise<GenerateResult> {
  return await executeMediaGeneration({
    modality: 'music',
    userId,
    modelKey,
    generation,
    options,
  }, invocation, wait)
}

export async function generateVoice(
  userId: string,
  modelKey: string,
  description: string,
  text: string,
  options?: AiVoiceExecutionOptions,
  invocation?: TaskProviderInvocation,
  wait?: AsyncProviderWaitCallbacks,
): Promise<GenerateResult> {
  return await executeMediaGeneration({
    modality: 'voice',
    userId,
    modelKey,
    description,
    text,
    options,
  }, invocation, wait)
}

export function taskAiInvocationKey(input: {
  readonly modality: 'llm' | 'vision'
  readonly action?: string
  readonly meta?: { readonly stepId: string; readonly stepAttempt?: number; readonly stepIndex: number }
}): string {
  const action = input.action?.trim() || ''
  const stepId = input.meta?.stepId.trim() || ''
  if (!action || !stepId || !input.meta) {
    throw new Error(`TASK_AI_INVOCATION_IDENTITY_REQUIRED:${input.modality}`)
  }
  // `stepAttempt` is stream presentation metadata, not a provider invocation
  // identity. Including it here would let a replay submit the same external
  // request under a fresh durable fence.
  return `ai:${input.modality}:${action}:${stepId}:${input.meta.stepIndex}`
}

async function executeTaskAwareLlmCompletion(input: {
  readonly modality: 'llm' | 'vision'
  readonly userId: string
  readonly model: string
  readonly action?: string
  readonly meta?: { readonly stepId: string; readonly stepAttempt?: number; readonly stepIndex: number }
  readonly request: unknown
  readonly execute: () => Promise<AiLlmExecutionResult>
}): Promise<AiLlmExecutionResult> {
  const taskId = getLogContext().taskId
  if (!taskId) return await input.execute()
  return await executeTaskDurableInvocation({
    taskId,
    invocation: { key: taskAiInvocationKey(input) },
    modality: input.modality,
    provider: 'llm-runtime',
    modelKey: input.model,
    request: input.request,
    execute: input.execute,
    resultPolicy: {
      parse: parseStoredAiLlmExecutionResult,
    },
  })
}

export async function executeAiTextStep(input: AiStepExecutionInput): Promise<AiStepExecutionResult> {
  try {
    const reasoningEffort = await resolveReasoningEffort({
      userId: input.userId,
      modelKey: input.model,
      purpose: 'analysis',
      projectId: input.projectId,
      explicit: input.reasoningEffort,
    })
    const options = {
      reasoning: input.reasoning,
      reasoningEffort,
      projectId: input.projectId,
      action: input.action,
      streamStepId: input.meta.stepId,
      streamStepAttempt: input.meta.stepAttempt || 1,
      streamStepTitle: input.meta.stepTitle,
      streamStepIndex: input.meta.stepIndex,
      streamStepTotal: input.meta.stepTotal,
    }
    return await executeTaskAwareLlmCompletion({
      modality: 'llm',
      userId: input.userId,
      model: input.model,
      action: input.action,
      meta: input.meta,
      request: { messages: input.messages, options },
      execute: async () => await executeLlmCompletion({
        modality: 'llm',
        userId: input.userId,
        model: input.model,
        messages: input.messages,
        options,
      }),
    })
  } catch (error) {
    throw toAppError(error)
  }
}

export async function executeAiVisionStep(input: AiVisionStepExecutionInput): Promise<AiVisionStepExecutionResult> {
  try {
    const reasoningEffort = await resolveReasoningEffort({
      userId: input.userId,
      modelKey: input.model,
      purpose: 'analysis',
      projectId: input.projectId,
      explicit: input.reasoningEffort,
    })
    const options = {
      reasoning: input.reasoning,
      reasoningEffort,
      projectId: input.projectId,
      action: input.action,
      streamStepId: input.meta?.stepId,
      streamStepAttempt: input.meta?.stepAttempt || 1,
      streamStepTitle: input.meta?.stepTitle,
      streamStepIndex: input.meta?.stepIndex,
      streamStepTotal: input.meta?.stepTotal,
    }
    return await executeTaskAwareLlmCompletion({
      modality: 'vision',
      userId: input.userId,
      model: input.model,
      action: input.action,
      meta: input.meta,
      request: { prompt: input.prompt, imageUrls: input.imageUrls, options },
      execute: async () => await executeVisionCompletion({
        modality: 'vision',
        userId: input.userId,
        model: input.model,
        textPrompt: input.prompt,
        imageUrls: input.imageUrls,
        options,
      }),
    })
  } catch (error) {
    throw toAppError(error)
  }
}
