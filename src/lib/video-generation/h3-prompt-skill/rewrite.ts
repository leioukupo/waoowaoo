import { createScopedLogger } from '@/lib/logging/core'
import { runLlmCompletion } from '@/lib/ai-exec/llm/completion-runner'
import { resolveUtilityModelKey } from '@/lib/ai-exec/utility-model'
import { parseModelKeyStrict } from '@/lib/ai-registry/selection'
import type { VideoReferenceImageInput } from '@/lib/video-generation/reference-images'
import { loadH3PromptSkillGuides } from './guides'

export type H3GenerationMode = 'T2VA' | 'I2VA' | 'FL2VA' | 'L2VA' | 'Ref2VA'

export const H3_PROMPT_SKILL_DISABLED_ENV = 'H3_PROMPT_SKILL_DISABLED'

const H3_PROMPT_SKILL_TIMEOUT_MS = 120 * 1000
const H3_VIDEO_MODEL_ID_PATTERN = /^minimax\/hailuo-3/i
const MIN_REWRITTEN_LENGTH = 60
const MAX_REWRITTEN_LENGTH = 24000

export interface H3PromptRewriteInput {
  readonly userId: string
  readonly projectId?: string
  readonly modelKey: string
  readonly rawPrompt: string
  readonly durationSeconds: number
  readonly referenceImages: readonly VideoReferenceImageInput[]
  readonly referenceVideos?: readonly string[]
  readonly referenceAudios?: readonly string[]
}

export interface H3PromptRewriteResult {
  readonly mode: H3GenerationMode
  readonly prompt: string
  readonly modelKey: string
  readonly durationMs: number
}

const DISABLED_VALUES = new Set(['1', 'true', 'yes', 'on'])

export function isH3PromptSkillEnabled(): boolean {
  const raw = process.env[H3_PROMPT_SKILL_DISABLED_ENV]
  return !(typeof raw === 'string' && DISABLED_VALUES.has(raw.trim().toLowerCase()))
}

export function isH3VideoModel(modelKey?: string | null): boolean {
  const parsed = parseModelKeyStrict(modelKey)
  return !!parsed && H3_VIDEO_MODEL_ID_PATTERN.test(parsed.modelId)
}

function detectH3Mode(input: {
  referenceImages: readonly VideoReferenceImageInput[]
  referenceVideos?: readonly string[]
  referenceAudios?: readonly string[]
}): H3GenerationMode {
  const hasVideo = (input.referenceVideos?.length ?? 0) > 0
  const hasAudio = (input.referenceAudios?.length ?? 0) > 0
  const hasGenericImage = input.referenceImages.some((image) => image.role === 'reference_image')
  if (hasVideo || hasAudio || hasGenericImage) return 'Ref2VA'
  const hasFirstFrame = input.referenceImages.some((image) => image.role === 'first_frame')
  const hasLastFrame = input.referenceImages.some((image) => image.role === 'last_frame')
  if (hasFirstFrame && hasLastFrame) return 'FL2VA'
  if (hasFirstFrame) return 'I2VA'
  if (hasLastFrame) return 'L2VA'
  return 'T2VA'
}

function formatSeconds(value: number): string {
  return value.toFixed(2)
}

function describeReferenceAssets(input: H3PromptRewriteInput, mode: H3GenerationMode): string {
  const lines: string[] = []
  const duration = formatSeconds(input.durationSeconds)
  if (mode === 'T2VA') {
    lines.push('None (pure text-to-video).')
    return lines.join('\n')
  }
  const orderedImages = [...input.referenceImages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  let pictureIndex = 0
  for (const image of orderedImages) {
    pictureIndex += 1
    if (mode === 'Ref2VA') {
      const roleLabel = image.role === 'first_frame'
        ? 'the first-frame image, which the target video must open on'
        : image.role === 'last_frame'
          ? 'the last-frame image, which the target video must end on'
          : 'a reference image'
      lines.push(`- Picture ${pictureIndex}: ${roleLabel} (user-provided image #${image.order ?? pictureIndex}).`)
    } else if (image.role === 'first_frame') {
      lines.push(`- Picture ${pictureIndex}: the user-provided first-frame image; it is the actual first frame of the target video at 0.00 seconds.`)
    } else if (image.role === 'last_frame') {
      lines.push(`- Picture ${pictureIndex}: the user-provided last-frame image; it is the actual last frame of the target video at ${duration} seconds.`)
    }
  }
  if (mode === 'Ref2VA') {
    for (let i = 1; i <= (input.referenceVideos?.length ?? 0); i += 1) {
      lines.push(`- Video ${i}: a user-provided reference video (#${i}).`)
    }
    for (let i = 1; i <= (input.referenceAudios?.length ?? 0); i += 1) {
      lines.push(`- Audio ${i}: a user-provided reference audio (#${i}).`)
    }
  }
  return lines.join('\n')
}

function buildH3PromptSkillMessages(params: {
  input: H3PromptRewriteInput
  mode: H3GenerationMode
  skill: string
  guide: string
}): [string, string] {
  const { input, mode, skill, guide } = params
  const duration = formatSeconds(input.durationSeconds)
  const systemMessage = [
    skill,
    '',
    '---',
    '',
    `The selected generation mode is ${mode}. The following is the reference guide required for this mode. Follow its final prompt structure, field names, section order, labels, and timing notation exactly.`,
    '',
    '---',
    '',
    guide,
  ].join('\n')
  const userMessage = [
    'Rewrite the video generation request below into the final H3 prompt.',
    '',
    `Mode: ${mode}`,
    `Target video duration: ${input.durationSeconds} seconds (format times as ${duration} seconds, two decimal places).`,
    '',
    'Reference assets:',
    describeReferenceAssets(input, mode),
    '',
    'Original user request:',
    '"""',
    input.rawPrompt.trim(),
    '"""',
    '',
    'Output only the final H3 prompt text. No markdown fences, no commentary, no headers before or after the prompt.',
  ].join('\n')
  return [systemMessage, userMessage]
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?\s*```\s*$/)
  if (fenceMatch) return fenceMatch[1].trim()
  return trimmed
}

function validateRewrittenPrompt(mode: H3GenerationMode, text: string): boolean {
  if (text.length < MIN_REWRITTEN_LENGTH || text.length > MAX_REWRITTEN_LENGTH) return false
  if (mode === 'Ref2VA') {
    const sections = [
      'subject_definitions',
      'summary',
      'retention_analysis',
      'detailed_description',
      'overall_soundscape',
      'non_diegetic_music',
    ]
    let cursor = 0
    for (const section of sections) {
      const index = text.indexOf(`${section}:`, cursor)
      if (index === -1) return false
      cursor = index + section.length + 1
    }
    return true
  }
  if (!text.includes('integrated_multimodal_description:')) return false
  if (!text.includes('overall_soundscape:')) return false
  if (!text.includes('non_diegetic_music:')) return false
  if (mode !== 'T2VA') {
    const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
    if (!/^(For the target video|How the reference pictures align)/.test(firstLine)) return false
  }
  return true
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}:timeout`)), timeoutMs)
  })
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    timeout,
  ])
}

export async function rewriteVideoPromptWithH3Skill(
  input: H3PromptRewriteInput,
): Promise<H3PromptRewriteResult | null> {
  const logger = createScopedLogger({ module: 'video-generation', action: 'h3_prompt_skill' })
  const startedAt = Date.now()
  if (!isH3PromptSkillEnabled()) return null
  if (!isH3VideoModel(input.modelKey)) return null
  const rawPrompt = input.rawPrompt.trim()
  if (!rawPrompt) return null

  const mode = detectH3Mode(input)
  let modelKey: string
  try {
    modelKey = await resolveUtilityModelKey(input.userId)
  } catch (error) {
    logger.warn({
      message: 'h3 prompt skill skipped: no usable LLM model configured',
      details: { mode, reason: error instanceof Error ? error.message : String(error) },
    })
    return null
  }

  try {
    const { skill, guide } = await loadH3PromptSkillGuides(mode === 'Ref2VA' ? 'ref' : 'base')
    const [systemMessage, userMessage] = buildH3PromptSkillMessages({ input, mode, skill, guide })
    const result = await withTimeout(
      runLlmCompletion(
        input.userId,
        modelKey,
        [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage },
        ],
        {
          action: 'h3_prompt_skill',
          reasoning: false,
          ...(input.projectId ? { projectId: input.projectId } : {}),
        },
      ),
      H3_PROMPT_SKILL_TIMEOUT_MS,
      'h3_prompt_skill',
    )
    const rewritten = stripCodeFences(result.text ?? '')
    if (!validateRewrittenPrompt(mode, rewritten)) {
      logger.warn({
        message: 'h3 prompt skill output failed validation; keeping original prompt',
        details: {
          mode,
          modelKey,
          originalLength: input.rawPrompt.length,
          rewrittenLength: rewritten.length,
        },
      })
      return null
    }
    logger.info({
      message: 'video prompt rewritten with h3 prompt skill',
      durationMs: Date.now() - startedAt,
      details: {
        mode,
        modelKey,
        originalLength: input.rawPrompt.length,
        rewrittenLength: rewritten.length,
      },
    })
    return {
      mode,
      prompt: rewritten,
      modelKey,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    logger.warn({
      message: 'h3 prompt skill failed; keeping original prompt',
      details: {
        mode,
        modelKey,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    return null
  }
}
