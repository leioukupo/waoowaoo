import type { ModelCapabilities } from './types'

/**
 * The OpenRouter wire API carries a stable standard surface for every
 * image and video model: normalized resolution tiers, a normalized
 * aspect-ratio vocabulary, and reference assets. Models the user brings
 * in through their own OpenRouter-compatible endpoint that are not in the
 * curated catalog are described with that standard surface instead of
 * nothing — everything OpenRouter can carry, their endpoint can receive,
 * and options it does not support get clamped or ignored over there.
 */
export const OPENROUTER_STANDARD_IMAGE_RESOLUTIONS = ['512', '1K', '2K', '4K'] as const
export const OPENROUTER_STANDARD_IMAGE_ASPECT_RATIOS = [
  '1:1', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '16:9', '9:16', '21:9', '9:21',
] as const
export const OPENROUTER_STANDARD_IMAGE_MAX_REFERENCE_IMAGES = 14
export const OPENROUTER_STANDARD_IMAGE_DEFAULT_RESOLUTION = '1K'

export const OPENROUTER_STANDARD_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const
export const OPENROUTER_STANDARD_VIDEO_ASPECT_RATIOS = [
  '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '9:21',
] as const
export const OPENROUTER_STANDARD_VIDEO_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const
export const OPENROUTER_STANDARD_VIDEO_MAX_REFERENCE_IMAGES = 9

export function standardOpenRouterImageCapabilities(): ModelCapabilities {
  return {
    image: {
      resolutionOptions: [...OPENROUTER_STANDARD_IMAGE_RESOLUTIONS],
      maxReferenceImages: OPENROUTER_STANDARD_IMAGE_MAX_REFERENCE_IMAGES,
    },
  }
}

export function standardOpenRouterVideoCapabilities(): ModelCapabilities {
  return {
    video: {
      supportedInputModes: ['text_to_video', 'first_frame', 'first_last_frame', 'reference'],
      supportsTextToVideo: true,
      generationModeOptions: ['normal', 'firstlastframe'],
      generateAudioOptions: [true, false],
      supportGenerateAudio: true,
      durationOptions: [...OPENROUTER_STANDARD_VIDEO_DURATIONS],
      resolutionOptions: [...OPENROUTER_STANDARD_VIDEO_RESOLUTIONS],
      firstFrameAspectRatio: 'adaptive',
      firstlastframe: true,
      assetReferenceMultiReference: true,
      maxReferenceImages: OPENROUTER_STANDARD_VIDEO_MAX_REFERENCE_IMAGES,
      maxReferenceFiles: OPENROUTER_STANDARD_VIDEO_MAX_REFERENCE_IMAGES,
      referenceAudioRequiresVisual: false,
    },
  }
}
