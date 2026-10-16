import type { ImageGenerationRequest } from '@openrouter/sdk/models'
import { normalizeToBase64ForGeneration } from '@/lib/media/outbound-image'
import type { GptImage2ImageSize } from '@/lib/ai-providers/shared/gpt-image-2'
import { OPENROUTER_STANDARD_IMAGE_DEFAULT_RESOLUTION } from '@/lib/ai-registry/openrouter-standard-capabilities'
import { OPENROUTER_GPT_IMAGE_2_MODEL_ID } from './models'

export type OpenRouterImageOptions = Record<string, unknown> & {
  aspectRatio: string
  resolution: string
  referenceImages: string[]
  imageSize?: GptImage2ImageSize
  outputFormat?: string
  quality?: string
  background?: string
  outputCompression?: number
  moderation?: string
}

async function normalizeReferences(referenceImages: readonly string[] | undefined): Promise<string[]> {
  const list = Array.isArray(referenceImages) ? referenceImages : []
  return await Promise.all(list.map(normalizeToBase64ForGeneration))
}

export async function resolveOpenRouterImageInput(input: {
  modelId: string
  prompt: string
  options: OpenRouterImageOptions
}) {
  const promptText = input.prompt.trim()
  if (!promptText) throw new Error('OPENROUTER_IMAGE_PROMPT_REQUIRED')
  // No client-side model whitelist: any model is submitted through the
  // OpenRouter image API; unsupported models are rejected by the provider.
  const referenceImages = await normalizeReferences(input.options.referenceImages)
  // Always an array (possibly empty): an omitted key arrives as undefined
  // on OpenRouter-compatible endpoints and breaks their reference handling.
  const inputReferences = referenceImages.map((url) => ({
    type: 'image_url' as const,
    imageUrl: { url },
  }))

  if (input.modelId !== OPENROUTER_GPT_IMAGE_2_MODEL_ID) {
    // Always send a fully specified body: OpenRouter-compatible endpoints
    // (including self-hosted emulators) can expect every standard field to
    // be present, and an omitted key arrives as undefined over there.
    const request = {
      prompt: promptText,
      n: 1,
      resolution: (input.options.resolution ?? OPENROUTER_STANDARD_IMAGE_DEFAULT_RESOLUTION) as ImageGenerationRequest['resolution'],
      aspectRatio: (input.options.aspectRatio ?? 'auto') as ImageGenerationRequest['aspectRatio'],
      inputReferences,
      ...(typeof input.options.seed === 'number' ? { seed: input.options.seed } : {}),
    } satisfies Omit<ImageGenerationRequest, 'model' | 'stream'>
    return {
      request,
      size: request.resolution,
      quality: null,
      outputFormat: 'png',
      referenceImagesCount: referenceImages.length,
      stream: false,
    }
  }

  const imageSize = input.options.imageSize
  const quality = input.options.quality?.trim() ?? ''
  const outputFormat = input.options.outputFormat?.trim() ?? ''
  if (!imageSize || !quality || !outputFormat) {
    throw new Error('OPENROUTER_GPT_IMAGE_2_OPTIONS_INCOMPLETE')
  }
  const request = {
    prompt: promptText,
    n: 1,
    size: `${imageSize.width}x${imageSize.height}`,
    quality: quality as ImageGenerationRequest['quality'],
    outputFormat: outputFormat as ImageGenerationRequest['outputFormat'],
    inputReferences,
    ...(input.options.background
      ? { background: input.options.background as ImageGenerationRequest['background'] }
      : {}),
    ...(input.options.outputCompression !== undefined
      ? { outputCompression: input.options.outputCompression }
      : {}),
    provider: {
      only: ['openai'],
      allowFallbacks: false,
      ...(input.options.moderation
        ? { options: { openai: { moderation: input.options.moderation } } }
        : {}),
    },
  } satisfies Omit<ImageGenerationRequest, 'model' | 'stream'>

  return {
    request,
    size: request.size,
    quality,
    outputFormat,
    referenceImagesCount: referenceImages.length,
    // OpenRouter advertises streaming at the model endpoint level, but the
    // pinned OpenAI image endpoint rejects streaming when input_references
    // turns the request into image editing. Keep SSE for text-to-image only;
    // reference-image requests use the same dedicated Images API buffered.
    stream: referenceImages.length === 0,
  }
}
