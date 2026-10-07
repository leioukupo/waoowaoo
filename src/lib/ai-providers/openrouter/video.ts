import type { VideoGenerationRequest } from '@openrouter/sdk/models'
import { ResponseValidationError } from '@openrouter/sdk/models/errors'
import { createScopedLogger } from '@/lib/logging/core'
import { AppError } from '@/lib/errors/app-error'
import type { FailureRecord } from '@/lib/errors/failure'
import { createProviderAsyncTaskFailure } from '@/lib/ai-providers/shared/async-task-status'
import { ProviderSubmissionError } from '@/lib/ai-exec/submission-error'
import type {
  AiProviderVideoExecutionContext,
  GenerateResult,
} from '@/lib/ai-providers/runtime-types'
import { requireSelectedModelId } from '@/lib/ai-providers/shared/model-selection'
import {
  OPENROUTER_VIDEO_MODEL_IDS,
  resolveOpenRouterVideoModel,
} from './video-models'
import {
  createOpenRouterVideoClient,
  serializeErrorForLog,
} from './video-transport'
import {
  isOpenRouterSensitiveRejection,
  OPENROUTER_CONTENT_POLICY_REJECTION_MESSAGE,
  throwNormalizedOpenRouterSdkError,
} from './error-normalization'
import { formatOpenRouterExternalId } from './external-id'

type OpenRouterVideoOptions = NonNullable<AiProviderVideoExecutionContext['options']>

type OpenRouterVideoRequest = VideoGenerationRequest

export type OpenRouterVideoPollResult = {
  status: 'pending' | 'completed' | 'failed'
  videoUrl?: string
  resultUrl?: string
  downloadHeaders?: Record<string, string>
  failure?: FailureRecord
}

const OPENROUTER_VIDEO_SUBMIT_TIMEOUT_MS = 5 * 60_000
const OPENROUTER_VIDEO_STATUS_TIMEOUT_MS = 60_000
const OPENROUTER_VIDEO_ERROR_FIELD_LIMIT = 1_000

function requireOpenRouterBaseUrl(baseUrl: string | undefined, context: string): string {
  const normalized = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''
  if (!normalized) {
    throw new Error(`PROVIDER_BASE_URL_MISSING: openrouter (${context})`)
  }
  return normalized
}

function normalizeMaybeRelativeUrl(value: string, baseUrl: string): string {
  const parsed = new URL(value, baseUrl)
  return parsed.toString()
}

function readCompletedVideoUrl(unsignedUrls: readonly string[] | undefined, baseUrl: string): string | null {
  const urls = Array.isArray(unsignedUrls) ? unsignedUrls : []
  const firstUrl = urls.find((url): url is string => typeof url === 'string' && url.trim().length > 0)
  if (!firstUrl) return null
  return normalizeMaybeRelativeUrl(firstUrl.trim(), baseUrl)
}

function buildDownloadHeaders(input: {
  resultUrl: string
  baseUrl: string
  apiKey: string
}): Record<string, string> | undefined {
  const result = new URL(input.resultUrl, input.baseUrl)
  const base = new URL(input.baseUrl)
  if (result.origin !== base.origin) return undefined
  return { Authorization: `Bearer ${input.apiKey}` }
}

function buildSharedVideoRequest(input: {
  modelId: string
  options: OpenRouterVideoOptions
}): OpenRouterVideoRequest {
  const prompt = typeof input.options.prompt === 'string' ? input.options.prompt.trim() : ''
  if (!prompt) throw new Error('OPENROUTER_VIDEO_PROMPT_REQUIRED')
  const { watermark } = resolveOpenRouterVideoModel(input.modelId)

  return {
    model: input.modelId,
    prompt,
    ...(typeof input.options.duration === 'number' ? { duration: input.options.duration } : {}),
    ...(input.options.resolution
      ? { resolution: input.options.resolution as NonNullable<VideoGenerationRequest['resolution']> }
      : {}),
    ...(input.options.aspectRatio
      ? { aspectRatio: input.options.aspectRatio as NonNullable<VideoGenerationRequest['aspectRatio']> }
      : {}),
    ...(typeof input.options.generateAudio === 'boolean' ? { generateAudio: input.options.generateAudio } : {}),
    ...(typeof input.options.seed === 'number' ? { seed: input.options.seed } : {}),
    ...(typeof input.options.watermark === 'boolean'
      ? { provider: { options: { [watermark.provider]: { parameters: { [watermark.parameter]: input.options.watermark } } } } }
      : {}),
  }
}

function buildOpenRouterVideoPayload(input: {
  imageUrl: string
  modelId: string
  options: OpenRouterVideoOptions
}): OpenRouterVideoRequest {
  const shared = buildSharedVideoRequest({
    modelId: input.modelId,
    options: input.options,
  })
  const firstFrameUrl = input.imageUrl.trim()
  const referenceImages = input.options.referenceImages ?? []
  const referenceAudios = input.options.referenceAudios ?? []
  const referenceVideos = input.options.referenceVideos ?? []

  if (input.options.lastFrameImageUrl) {
    if (!firstFrameUrl) {
      throw new Error('OPENROUTER_VIDEO_OPTION_VALUE_UNSUPPORTED: lastFrameImageUrl_without_imageUrl')
    }
    if (referenceImages.length > 0 || referenceAudios.length > 0 || referenceVideos.length > 0) {
      throw new Error('OPENROUTER_VIDEO_OPTION_UNSUPPORTED: references_with_lastFrameImageUrl')
    }
    return {
      ...shared,
      frameImages: [
        { type: 'image_url', frameType: 'first_frame', imageUrl: { url: firstFrameUrl } },
        { type: 'image_url', frameType: 'last_frame', imageUrl: { url: input.options.lastFrameImageUrl.trim() } },
      ],
    }
  }

  if (firstFrameUrl) {
    if (referenceImages.length > 0 || referenceAudios.length > 0 || referenceVideos.length > 0) {
      throw new Error('OPENROUTER_VIDEO_OPTION_UNSUPPORTED: frame_with_references')
    }
    return {
      ...shared,
      frameImages: [
        { type: 'image_url', frameType: 'first_frame', imageUrl: { url: firstFrameUrl } },
      ],
    }
  }

  if (referenceImages.length > 0 || referenceAudios.length > 0 || referenceVideos.length > 0) {
    return {
      ...shared,
      inputReferences: [
        ...referenceImages.map((url) => ({
          type: 'image_url' as const,
          imageUrl: { url },
        })),
        ...referenceAudios.map((url) => ({
          type: 'audio_url' as const,
          audioUrl: { url },
        })),
        ...referenceVideos.map((url) => ({
          type: 'video_url' as const,
          videoUrl: { url },
        })),
      ],
    }
  }

  return shared
}

type OpenRouterVideoSubmitRejection = {
  readonly code: number | null
  readonly errorType: string | null
  readonly message: string
}

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readLimitedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, OPENROUTER_VIDEO_ERROR_FIELD_LIMIT) : null
}

function readProviderHttpCode(value: unknown): number | null {
  const code = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{3}$/.test(value.trim())
      ? Number.parseInt(value.trim(), 10)
      : NaN
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : null
}

function readRawRequestId(value: unknown): string | null {
  const record = asUnknownRecord(value)
  return readLimitedString(record?.id)
}

function readRawAcceptedRequestId(value: unknown): string | null {
  return readRawRequestId(value)
}

function readRawSubmitRejection(value: unknown): OpenRouterVideoSubmitRejection | null {
  const record = asUnknownRecord(value)
  if (!record || readRawRequestId(record)) return null
  if (typeof record.error === 'string') {
    const message = readLimitedString(record.error)
    return message ? { code: null, errorType: null, message } : null
  }

  const error = asUnknownRecord(record.error)
  if (!error) return null
  const message = readLimitedString(error.message)
  if (!message) return null
  const metadata = asUnknownRecord(error.metadata)
  return {
    code: readProviderHttpCode(error.code) ?? readProviderHttpCode(error.status),
    errorType: readLimitedString(metadata?.error_type) ?? readLimitedString(error.error_type),
    message,
  }
}

function formatSubmitRejection(rejection: OpenRouterVideoSubmitRejection): string {
  const identity = [
    rejection.code === null ? null : `code=${String(rejection.code)}`,
    rejection.errorType ? `type=${rejection.errorType}` : null,
  ].filter((value): value is string => value !== null).join(', ')
  return identity
    ? `OpenRouter video submission rejected (${identity}): ${rejection.message}`
    : `OpenRouter video submission rejected: ${rejection.message}`
}

function normalizeOpenRouterVideoSubmitValidationError(error: ResponseValidationError): string {
  const acceptedRequestId = error.statusCode === 202
    ? readRawAcceptedRequestId(error.rawValue)
    : null
  if (acceptedRequestId) return acceptedRequestId

  const rejection = readRawSubmitRejection(error.rawValue)
  if (!rejection) {
    throw new Error('OPENROUTER_VIDEO_SUBMIT_RESPONSE_INVALID_WITHOUT_ACCEPTANCE_ID_OR_ERROR', {
      cause: error,
    })
  }

  const message = formatSubmitRejection(rejection)
  const details = {
    ...(rejection.code === null ? {} : { providerCode: rejection.code }),
    ...(rejection.errorType ? { providerErrorType: rejection.errorType } : {}),
  }
  if (isOpenRouterSensitiveRejection(rejection.errorType)) {
    throw new ProviderSubmissionError(
      'SENSITIVE_CONTENT',
      OPENROUTER_CONTENT_POLICY_REJECTION_MESSAGE,
      {
        disposition: 'rejected',
        provider: 'openrouter',
        details,
        cause: error,
      },
    )
  }
  throw new ProviderSubmissionError('PROVIDER_SUBMISSION_REJECTED', message, {
    disposition: 'rejected',
    provider: 'openrouter',
    details,
    cause: error,
  })
}

export async function submitOpenRouterVideoTask(input: {
  baseUrl: string
  apiKey: string
  payload: OpenRouterVideoRequest
}): Promise<string> {
  if (!input.apiKey) {
    throw new AppError('PROVIDER_AUTH_INVALID', undefined, { provider: 'openrouter' })
  }

  let requestId: string
  try {
    const response = await createOpenRouterVideoClient({
      ...input,
      timeoutMs: OPENROUTER_VIDEO_SUBMIT_TIMEOUT_MS,
    }).videoGeneration.generate(
      { videoGenerationRequest: input.payload },
      { retries: { strategy: 'none' }, cache: 'no-store' },
    )
    requestId = response.id.trim()
  } catch (error) {
    if (error instanceof ResponseValidationError) {
      requestId = normalizeOpenRouterVideoSubmitValidationError(error)
    } else {
      throwNormalizedOpenRouterSdkError(error)
    }
  }
  if (!requestId) throw new Error('OPENROUTER_VIDEO_SUBMIT_ID_MISSING')
  return requestId
}

export async function queryOpenRouterVideoStatus(input: {
  baseUrl: string
  apiKey: string
  requestId: string
}): Promise<OpenRouterVideoPollResult> {
  if (!input.apiKey) {
    throw new AppError('PROVIDER_AUTH_INVALID', undefined, { provider: 'openrouter' })
  }

  let response: Awaited<ReturnType<ReturnType<typeof createOpenRouterVideoClient>['videoGeneration']['getGeneration']>>
  try {
    response = await createOpenRouterVideoClient({
      ...input,
      timeoutMs: OPENROUTER_VIDEO_STATUS_TIMEOUT_MS,
    }).videoGeneration.getGeneration(
      { jobId: input.requestId },
      { retries: { strategy: 'none' }, cache: 'no-store' },
    )
  } catch (error) {
    throwNormalizedOpenRouterSdkError(error)
  }
  const status = response.status
  if (status === 'pending' || status === 'in_progress') {
    return { status: 'pending' }
  }

  if (status === 'completed') {
    const videoUrl = readCompletedVideoUrl(response.unsignedUrls, input.baseUrl)
    if (!videoUrl) {
      return {
        status: 'failed',
        failure: createProviderAsyncTaskFailure({
          provider: 'openrouter',
          code: 'EMPTY_RESPONSE',
          message: 'OPENROUTER_VIDEO_COMPLETED_WITHOUT_URL',
          cause: response,
        }),
      }
    }
    return {
      status: 'completed',
      videoUrl,
      resultUrl: videoUrl,
      downloadHeaders: buildDownloadHeaders({
        resultUrl: videoUrl,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
      }),
    }
  }

  if (status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'expired') {
    const message = response.error?.trim() || `OpenRouter video generation ${status}`
    return {
      status: 'failed',
      failure: createProviderAsyncTaskFailure({
        provider: 'openrouter',
        code: 'EXTERNAL_ERROR',
        message,
        cause: response,
      }),
    }
  }

  throw new Error(`OPENROUTER_VIDEO_STATUS_UNKNOWN:${status}`)
}

export async function executeOpenRouterVideoGeneration(input: AiProviderVideoExecutionContext): Promise<GenerateResult> {
  const { apiKey, baseUrl } = input.providerConfig
  const normalizedBaseUrl = requireOpenRouterBaseUrl(baseUrl, 'video')
  const modelId = requireSelectedModelId(input.selection, 'openrouter:video')
  if (!OPENROUTER_VIDEO_MODEL_IDS.has(modelId)) {
    throw new Error(`OPENROUTER_VIDEO_MODEL_UNSUPPORTED: ${modelId}`)
  }

  const options: OpenRouterVideoOptions = input.options ?? {}

  const payload = buildOpenRouterVideoPayload({
    imageUrl: input.imageUrl,
    modelId,
    options,
  })

  const logger = createScopedLogger({ module: 'worker.openrouter-video', action: 'openrouter_video_generate' })
  const submitStartedAt = Date.now()
  const referenceSummary = summarizeReferenceCounts(payload)
  logger.info({
    message: 'OpenRouter video generation request',
    details: {
      modelId,
      submitTimeoutMs: OPENROUTER_VIDEO_SUBMIT_TIMEOUT_MS,
      ...referenceSummary,
    },
  })

  let requestId: string
  try {
    requestId = await submitOpenRouterVideoTask({
      baseUrl: normalizedBaseUrl,
      apiKey,
      payload,
    })
  } catch (error) {
    logger.error({
      action: 'openrouter_video_submit_failed',
      message: 'OpenRouter video task submission failed',
      durationMs: Date.now() - submitStartedAt,
      details: {
        modelId,
        submitTimeoutMs: OPENROUTER_VIDEO_SUBMIT_TIMEOUT_MS,
        ...referenceSummary,
      },
      error: serializeErrorForLog(error),
    })
    throw error
  }
  logger.info({
    message: 'OpenRouter video task submitted',
    durationMs: Date.now() - submitStartedAt,
    details: {
      requestId,
      submitTimeoutMs: OPENROUTER_VIDEO_SUBMIT_TIMEOUT_MS,
    },
  })

  return {
    success: true,
    async: true,
    requestId,
    endpoint: 'videos',
    externalId: formatOpenRouterExternalId({
      type: 'VIDEO',
      requestId,
      providerToken: input.providerConfig.id,
    }),
  }
}

function summarizeReferenceCounts(payload: OpenRouterVideoRequest): {
  frameImageCount: number
  inputImageReferenceCount: number
  inputAudioReferenceCount: number
  inputVideoReferenceCount: number
} {
  const inputReferences = payload.inputReferences ?? []
  return {
    frameImageCount: payload.frameImages?.length ?? 0,
    inputImageReferenceCount: inputReferences.filter((reference) => reference.type === 'image_url').length,
    inputAudioReferenceCount: inputReferences.filter((reference) => reference.type === 'audio_url').length,
    inputVideoReferenceCount: inputReferences.filter((reference) => reference.type === 'video_url').length,
  }
}
