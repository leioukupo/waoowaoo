import { usdToCredits } from '@/lib/ai-registry/pricing-currency'
import { SEEDANCE_2_5_RETAIL_CREDITS_PER_SECOND } from '@/lib/ai-providers/shared/seedance-pricing'
import {
  OPENROUTER_HAILUO_3_MAX_REFERENCE_IMAGES,
  OPENROUTER_HAILUO_3_MAX_VIDEO_MODEL_ID,
  OPENROUTER_HAILUO_3_VIDEO_MODEL_ID,
  OPENROUTER_HAILUO_DURATION_OPTIONS,
  OPENROUTER_SEEDANCE_2_5_OUTPUTS,
  OPENROUTER_SEEDANCE_2_5_VIDEO_MODEL_ID,
} from './video-models'

// OpenRouter video_tokens SKU: USD 0.0000107/token, audio on or off.
// Native token formula: width * height * 24 * output_seconds / 1024.
// Reference-video pricing also counts input video; it must not match these
// output-only tiers. No adaptive-size or intelligent-duration approximation.
const tiers = OPENROUTER_SEEDANCE_2_5_OUTPUTS.map(({ resolution, aspectRatio, width, height }) => ({
  when: { resolution, aspectRatio, containsVideoInput: false },
  amount: usdToCredits(width * height * 24 / 1024 * 0.0000107),
  retail: SEEDANCE_2_5_RETAIL_CREDITS_PER_SECOND[resolution],
}))

export const OPENROUTER_SEEDANCE_2_5_PRICING = {
  apiType: 'video', provider: 'openrouter', modelId: OPENROUTER_SEEDANCE_2_5_VIDEO_MODEL_ID,
  cost: { mode: 'capability', unit: 'per_second', tiers: tiers.map(({ when, amount }) => ({ when, amount })) },
  retail: { mode: 'capability', unit: 'per_second', tiers: tiers.map(({ when, retail }) => ({ when, amount: retail })) },
} as const

// OpenRouter H3: USD 0.13/output second plus USD 0.04/image after the first five.
// Frame modes are mutually exclusive with references and contain at most two
// images, so their images never cross the free threshold. Freeze the entire
// request price rather than multiplying the image surcharge by video duration.
function hailuo3Tiers(resolutions: readonly string[], perSecond: number, perImage: number) {
  const tiers: Array<{
    when: { resolution: string; duration: number; referenceImageCount: number; containsVideoInput: false }
    amount: number
  }> = []
  for (const duration of OPENROUTER_HAILUO_DURATION_OPTIONS) {
    for (let referenceImageCount = 0; referenceImageCount <= OPENROUTER_HAILUO_3_MAX_REFERENCE_IMAGES; referenceImageCount += 1) {
      for (const resolution of resolutions) {
        tiers.push({
          when: { resolution, duration, referenceImageCount, containsVideoInput: false },
          amount: duration * perSecond + Math.max(referenceImageCount - 5, 0) * perImage,
        })
      }
    }
  }
  return tiers
}

export const OPENROUTER_HAILUO_PRICING_CATALOG_ENTRIES = [
  {
    apiType: 'video', provider: 'openrouter', modelId: OPENROUTER_HAILUO_3_VIDEO_MODEL_ID,
    // The H3 SKU is one flat per-second rate (plus the image surcharge), so
    // every advertised resolution carries the same quote; the catalog must
    // cover the whole offered surface or the availability projection drops
    // the unpriced combinations.
    cost: {
      mode: 'capability', unit: 'per_call',
      tiers: hailuo3Tiers(['480p', '768p', '2K'], usdToCredits(0.13), usdToCredits(0.04)),
    },
    // Retail keeps the flat-per-second shape but at product rates (12 credits
    // per output second, 4 credits per extra reference image) that clear the
    // margin floor at the deepest plan discount.
    retail: {
      mode: 'capability', unit: 'per_call',
      tiers: hailuo3Tiers(['480p', '768p', '2K'], 12, 4),
    },
  },
  {
    apiType: 'video', provider: 'openrouter', modelId: OPENROUTER_HAILUO_3_MAX_VIDEO_MODEL_ID,
    cost: {
      mode: 'capability', unit: 'per_second',
      tiers: [
        { when: { resolution: '480p', containsVideoInput: false }, amount: usdToCredits(0.05) },
        { when: { resolution: '768p', containsVideoInput: false }, amount: usdToCredits(0.08) },
      ],
    },
    // Retail mirrors the cost structure at product rates that clear the
    // margin floor at the deepest plan discount.
    retail: {
      mode: 'capability', unit: 'per_second',
      tiers: [
        { when: { resolution: '480p', containsVideoInput: false }, amount: 5 },
        { when: { resolution: '768p', containsVideoInput: false }, amount: 8 },
      ],
    },
  },
] as const
