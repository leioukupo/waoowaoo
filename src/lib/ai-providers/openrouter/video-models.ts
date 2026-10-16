import type { AiOptionSchema, VideoCapabilities } from '@/lib/ai-registry/types'
import {
  OPENROUTER_STANDARD_VIDEO_ASPECT_RATIOS,
  OPENROUTER_STANDARD_VIDEO_MAX_REFERENCE_IMAGES,
  OPENROUTER_STANDARD_VIDEO_RESOLUTIONS,
  standardOpenRouterVideoCapabilities,
} from '@/lib/ai-registry/openrouter-standard-capabilities'
import {
  booleanValidator,
  buildMediaOptionSchema,
  enumValidator,
  integerRangeValidator,
  stringArrayValidator,
} from '@/lib/ai-providers/shared/option-schema'

export const OPENROUTER_SEEDANCE_2_VIDEO_MODEL_ID = 'bytedance/seedance-2.0'
export const OPENROUTER_SEEDANCE_2_FAST_VIDEO_MODEL_ID = 'bytedance/seedance-2.0-fast'
export const OPENROUTER_SEEDANCE_2_5_VIDEO_MODEL_ID = 'bytedance/seedance-2.5'
export const OPENROUTER_HAILUO_3_VIDEO_MODEL_ID = 'minimax/hailuo-3'
export const OPENROUTER_HAILUO_3_MAX_VIDEO_MODEL_ID = 'minimax/hailuo-3-max'
export const OPENROUTER_HAILUO_DURATION_OPTIONS = Array.from({ length: 11 }, (_, index) => index + 5)
export const OPENROUTER_HAILUO_3_MAX_REFERENCE_IMAGES = 9
export const OPENROUTER_SEEDANCE_2_5_OUTPUTS = [
  { resolution: '480p', aspectRatio: '16:9', width: 854, height: 480 },
  { resolution: '480p', aspectRatio: '4:3', width: 752, height: 560 },
  { resolution: '480p', aspectRatio: '1:1', width: 640, height: 640 },
  { resolution: '480p', aspectRatio: '3:4', width: 560, height: 752 },
  { resolution: '480p', aspectRatio: '9:16', width: 480, height: 854 },
  { resolution: '480p', aspectRatio: '21:9', width: 992, height: 432 },
  { resolution: '720p', aspectRatio: '16:9', width: 1280, height: 720 },
  { resolution: '720p', aspectRatio: '4:3', width: 1112, height: 834 },
  { resolution: '720p', aspectRatio: '1:1', width: 960, height: 960 },
  { resolution: '720p', aspectRatio: '3:4', width: 834, height: 1112 },
  { resolution: '720p', aspectRatio: '9:16', width: 720, height: 1280 },
  { resolution: '720p', aspectRatio: '21:9', width: 1470, height: 630 },
] as const
export const OPENROUTER_SEEDANCE_2_ASPECT_RATIO_OPTIONS = ['1:1', '3:4', '9:16', '4:3', '16:9', '21:9', '9:21'] as const

interface OpenRouterVideoModel {
  readonly modelId: string
  readonly name: string
  readonly aspectRatios: readonly string[]
  readonly capabilities: VideoCapabilities
  readonly supportsSeed: boolean
  readonly watermark: {
    readonly provider: 'seed' | 'minimax'
    readonly parameter: 'watermark' | 'aigc_watermark'
  }
}

const SEEDANCE_WIRE_OPTIONS = {
  supportsSeed: true,
  watermark: { provider: 'seed', parameter: 'watermark' },
} as const
const HAILUO_WIRE_OPTIONS = {
  supportsSeed: false,
  watermark: { provider: 'minimax', parameter: 'aigc_watermark' },
} as const
const HAILUO_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const
// The OpenRouter MiniMax family shares one capability surface: both H3 and
// H3 Max accept text, first/last keyframes and reference images
// (/api/v1/videos/models, checked 2026-10-14). Resolution tiers stay
// priced per model, so the availability projection still trims each
// model to the tiers its pricing catalog quotes.
const HAILUO_CAPABILITIES = {
  supportedInputModes: ['text_to_video', 'first_frame', 'first_last_frame', 'reference'],
  supportsTextToVideo: true,
  generationModeOptions: ['normal', 'firstlastframe'],
  generateAudioOptions: [true, false],
  supportGenerateAudio: true,
  durationOptions: OPENROUTER_HAILUO_DURATION_OPTIONS,
  resolutionOptions: ['480p', '768p', '2K'],
  firstlastframe: true,
  assetReferenceMultiReference: true,
  maxReferenceImages: OPENROUTER_HAILUO_3_MAX_REFERENCE_IMAGES,
  maxReferenceFiles: OPENROUTER_HAILUO_3_MAX_REFERENCE_IMAGES,
} satisfies VideoCapabilities

const SEEDANCE_2_CAPABILITIES = {
  supportedInputModes: ['text_to_video', 'first_frame', 'first_last_frame', 'reference'],
  supportsTextToVideo: true,
  generationModeOptions: ['normal', 'firstlastframe'],
  generateAudioOptions: [true, false],
  durationOptions: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  firstlastframe: true,
  supportGenerateAudio: true,
  assetReferenceMultiReference: true,
  maxReferenceImages: 9,
  maxReferenceAudios: 3,
  maxReferenceVideos: 3,
  maxReferenceFiles: 12,
  referenceAudioRequiresVisual: true,
  minReferenceAudioDurationMs: 1_800,
  maxTotalReferenceAudioDurationMs: 15_200,
} satisfies VideoCapabilities

// /api/v1/videos/models, checked 2026-09-05. 2.5's public API advertises
// 480p/720p only; the pricing page's higher-resolution SKUs are not capabilities.
export const OPENROUTER_VIDEO_MODELS: readonly OpenRouterVideoModel[] = [
  {
    modelId: OPENROUTER_SEEDANCE_2_VIDEO_MODEL_ID,
    ...SEEDANCE_WIRE_OPTIONS,
    name: 'Seedance 2.0',
    aspectRatios: OPENROUTER_SEEDANCE_2_ASPECT_RATIO_OPTIONS,
    capabilities: { ...SEEDANCE_2_CAPABILITIES, resolutionOptions: ['480p', '720p', '1080p'] },
  },
  {
    modelId: OPENROUTER_SEEDANCE_2_FAST_VIDEO_MODEL_ID,
    ...SEEDANCE_WIRE_OPTIONS,
    name: 'Seedance 2.0 Fast',
    aspectRatios: OPENROUTER_SEEDANCE_2_ASPECT_RATIO_OPTIONS,
    capabilities: { ...SEEDANCE_2_CAPABILITIES, resolutionOptions: ['480p', '720p'] },
  },
  {
    modelId: OPENROUTER_SEEDANCE_2_5_VIDEO_MODEL_ID,
    ...SEEDANCE_WIRE_OPTIONS,
    name: 'Seedance 2.5',
    aspectRatios: [...new Set(OPENROUTER_SEEDANCE_2_5_OUTPUTS.map(({ aspectRatio }) => aspectRatio))],
    capabilities: {
      ...SEEDANCE_2_CAPABILITIES,
      durationOptions: Array.from({ length: 27 }, (_, index) => index + 4),
      resolutionOptions: [...new Set(OPENROUTER_SEEDANCE_2_5_OUTPUTS.map(({ resolution }) => resolution))],
      maxReferenceImages: 30,
      maxReferenceAudios: 10,
      maxReferenceVideos: 10,
      maxReferenceFiles: 50,
      referenceAudioRequiresVisual: false,
      minReferenceAudioDurationMs: 2_000,
      maxReferenceAudioDurationMs: 30_000,
      maxTotalReferenceAudioDurationMs: 30_000,
      minReferenceVideoDurationMs: 2_000,
      maxReferenceVideoDurationMs: 30_000,
      maxTotalReferenceVideoDurationMs: 30_000,
    },
  },
  {
    modelId: OPENROUTER_HAILUO_3_VIDEO_MODEL_ID,
    ...HAILUO_WIRE_OPTIONS,
    name: 'MiniMax H3',
    aspectRatios: HAILUO_ASPECT_RATIOS,
    capabilities: HAILUO_CAPABILITIES,
  },
  {
    modelId: OPENROUTER_HAILUO_3_MAX_VIDEO_MODEL_ID,
    ...HAILUO_WIRE_OPTIONS,
    name: 'MiniMax H3 Max',
    aspectRatios: HAILUO_ASPECT_RATIOS,
    capabilities: HAILUO_CAPABILITIES,
  },
]


export function tryResolveOpenRouterVideoModel(modelId: string | undefined): OpenRouterVideoModel | null {
  return OPENROUTER_VIDEO_MODELS.find((candidate) => candidate.modelId === modelId) ?? null
}

export function resolveOpenRouterVideoModel(modelId: string | undefined): OpenRouterVideoModel {
  const model = tryResolveOpenRouterVideoModel(modelId)
  if (!model) throw new Error(`OPENROUTER_VIDEO_MODEL_UNSUPPORTED:${modelId ?? '<missing>'}`)
  return model
}

export function buildOpenRouterVideoOptionSchema(modelId: string | undefined): AiOptionSchema {
  const model = resolveOpenRouterVideoModel(modelId)
  const caps = model.capabilities
  return buildMediaOptionSchema('video', {
    allowedKeys: ['referenceImages', 'referenceAudios', 'referenceVideos'],
    excludedKeys: [
      'size', 'promptExtend', 'serviceTier', 'executionExpiresAfter', 'returnLastFrame', 'draft', 'cameraFixed',
      ...(!model.supportsSeed ? ['seed'] : []),
      ...(!caps.supportGenerateAudio ? ['generateAudio'] : []),
      ...(!caps.supportedInputModes?.includes('first_last_frame') ? ['lastFrameImageUrl'] : []),
    ],
    validators: {
      duration: (value) => value === undefined || (typeof value === 'number' && caps.durationOptions?.includes(value))
        ? { ok: true } : { ok: false, reason: 'unsupported_duration' },
      aspectRatio: enumValidator(model.aspectRatios),
      resolution: enumValidator(caps.resolutionOptions ?? []),
      generateAudio: booleanValidator(),
      seed: integerRangeValidator({}),
      watermark: booleanValidator(),
      referenceImages: stringArrayValidator({ maxLength: caps.maxReferenceImages ?? 0 }),
      referenceAudios: stringArrayValidator({ maxLength: caps.maxReferenceAudios ?? 0 }),
      referenceVideos: stringArrayValidator({ maxLength: caps.maxReferenceVideos ?? 0 }),
    },
    objectValidators: [(options) => {
      const count = (key: string) => Array.isArray(options[key]) ? options[key].length : 0
      const images = count('referenceImages')
      const audios = count('referenceAudios')
      const videos = count('referenceVideos')
      if (images + audios + videos > (caps.maxReferenceFiles ?? 0)) {
        return { ok: false, reason: 'total_reference_limit_exceeded' }
      }
      if (caps.referenceAudioRequiresVisual && audios > 0 && images + videos === 0) {
        return { ok: false, reason: 'reference_audio_requires_visual' }
      }
      if (options.lastFrameImageUrl && images + audios + videos > 0) {
        return { ok: false, reason: 'frame_with_references' }
      }
      return { ok: true }
    }],
  })
}

/**
 * Standard OpenRouter wire for video models outside the curated list:
 * normalized resolution tiers, aspect ratios, durations and image
 * references. Audio and video references stay closed because only specific
 * curated providers honor them.
 */
export function buildOpenRouterStandardVideoOptionSchema(): AiOptionSchema {
  const caps = standardOpenRouterVideoCapabilities().video
  return buildMediaOptionSchema('video', {
    allowedKeys: ['referenceImages'],
    excludedKeys: [
      'size', 'promptExtend', 'serviceTier', 'executionExpiresAfter', 'returnLastFrame', 'draft', 'cameraFixed',
      'watermark',
    ],
    validators: {
      duration: (value) => value === undefined || (typeof value === 'number' && (caps?.durationOptions ?? []).includes(value))
        ? { ok: true } : { ok: false, reason: 'unsupported_duration' },
      aspectRatio: enumValidator(OPENROUTER_STANDARD_VIDEO_ASPECT_RATIOS),
      resolution: enumValidator(OPENROUTER_STANDARD_VIDEO_RESOLUTIONS),
      generateAudio: booleanValidator(),
      seed: integerRangeValidator({}),
      referenceImages: stringArrayValidator({ maxLength: OPENROUTER_STANDARD_VIDEO_MAX_REFERENCE_IMAGES }),
    },
    objectValidators: [(options) => {
      const images = Array.isArray(options.referenceImages) ? options.referenceImages.length : 0
      if (images > (caps?.maxReferenceFiles ?? 0)) return { ok: false, reason: 'total_reference_limit_exceeded' }
      if (typeof options.lastFrameImageUrl === 'string' && options.lastFrameImageUrl.trim() && images > 0) {
        return { ok: false, reason: 'frame_with_references' }
      }
      return { ok: true }
    }],
  })
}
