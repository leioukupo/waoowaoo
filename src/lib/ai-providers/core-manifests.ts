import { arkProviderManifest } from '@/lib/ai-providers/ark/manifest'
import { elevenLabsProviderManifest } from '@/lib/ai-providers/elevenlabs/manifest'
import { falProviderManifest } from '@/lib/ai-providers/fal/manifest'
import { googleProviderManifest } from '@/lib/ai-providers/google/manifest'
import { openAiCompatProviderManifest } from '@/lib/ai-providers/openai-compat/manifest'
import { openAiProviderManifest } from '@/lib/ai-providers/openai/manifest'
import { openRouterProviderManifest } from '@/lib/ai-providers/openrouter/manifest'
import type { AiProviderManifest } from '@/lib/ai-providers/manifest'

export const CORE_AI_PROVIDER_MANIFESTS = [
  arkProviderManifest,
  openAiCompatProviderManifest,
  elevenLabsProviderManifest,
  falProviderManifest,
  googleProviderManifest,
  openAiProviderManifest,
  openRouterProviderManifest,
] as const satisfies readonly AiProviderManifest[]
