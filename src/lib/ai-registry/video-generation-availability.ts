import { getBillingModeSync } from '@/lib/billing/mode'
import { resolveBuiltinPricing } from './pricing-resolution'
import type { CapabilityValue, VideoCapabilities, VideoInputMode } from './types'

/**
 * Project a rectangular set of choices that all have an exact catalog quote.
 * Native provider capabilities remain intact for frozen executions. No price,
 * token estimate or provider identity is invented by this discovery projector.
 */
export function projectVideoGenerationAvailability(input: {
  readonly modelKey: string
  readonly video: VideoCapabilities
  readonly aspectRatios: readonly string[]
}): { readonly video: VideoCapabilities; readonly pricingLimited: boolean } {
  const { video, modelKey, aspectRatios } = input
  const durations = (video.durationOptions ?? []).filter((duration) => duration > 0)
  const audioOptions: readonly (boolean | undefined)[] = video.generateAudioOptions ?? [undefined]
  const nativeResolutions = video.resolutionOptions ?? []
  const nativeModes = video.supportedInputModes ?? []
  const imageCounts = (mode: VideoInputMode): readonly number[] => {
    switch (mode) {
      case 'text_to_video': return [0]
      case 'first_frame': return [1]
      case 'first_last_frame': return [2]
      case 'reference': return Array.from({
        length: Math.min(video.maxReferenceImages ?? 0, video.maxReferenceFiles ?? 0) + 1,
      }, (_, count) => count)
    }
  }
  // Billing-OFF deployments never fail on price, so an unknown quote there
  // only means "unquoted", not "unavailable".
  const billingOff = getBillingModeSync() === 'OFF'
  const priced = (resolution: string, mode: VideoInputMode, containsVideoInput: boolean): boolean => (
    billingOff
    || (aspectRatios.length > 0 && durations.length > 0
    && aspectRatios.every((aspectRatio) => durations.every((duration) => audioOptions.every((generateAudio) => imageCounts(mode).every((referenceImageCount) => {
      const selections: Record<string, CapabilityValue> = {
        resolution, aspectRatio, duration, generationMode: 'normal', containsVideoInput,
        containsFirstFrame: mode === 'first_frame' || mode === 'first_last_frame',
        referenceImageCount,
        ...(generateAudio === undefined ? {} : { generateAudio }),
      }
      const price = resolveBuiltinPricing({ apiType: 'video', model: modelKey, face: 'retail', selections })
      return price.status === 'resolved' && (price.mode === 'flat' || price.unit !== undefined)
    }))))
  ))
  const resolutionOptions = nativeResolutions.filter((resolution) => nativeModes.some((mode) => priced(resolution, mode, false)))
  const supportedInputModes = nativeModes.filter((mode) => resolutionOptions.length > 0
    && resolutionOptions.every((resolution) => priced(resolution, mode, false)))
  const maxReferenceVideos = supportedInputModes.includes('reference')
    && resolutionOptions.every((resolution) => priced(resolution, 'reference', true))
    ? video.maxReferenceVideos ?? 0 : 0
  const referenceAvailable = supportedInputModes.includes('reference')
  const maxReferenceImages = referenceAvailable ? video.maxReferenceImages ?? 0 : 0
  const maxReferenceAudios = referenceAvailable ? video.maxReferenceAudios ?? 0 : 0
  return {
    pricingLimited: resolutionOptions.length !== nativeResolutions.length
      || supportedInputModes.length !== nativeModes.length || maxReferenceVideos !== (video.maxReferenceVideos ?? 0),
    video: {
      ...video,
      resolutionOptions,
      supportedInputModes,
      generationModeOptions: (video.generationModeOptions ?? []).filter((mode) => mode !== 'firstlastframe' || supportedInputModes.includes('first_last_frame')),
      firstlastframe: supportedInputModes.includes('first_last_frame'),
      supportsTextToVideo: supportedInputModes.includes('text_to_video'),
      maxReferenceImages, maxReferenceAudios, maxReferenceVideos,
      maxReferenceFiles: Math.min(video.maxReferenceFiles ?? 0, maxReferenceImages + maxReferenceAudios + maxReferenceVideos),
    },
  }
}
