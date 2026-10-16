import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// MiniMax H3 "h3-prompt-writing" skill, vendored from
// https://github.com/MiniMax-AI/MiniMax-H3 (skills/h3-prompt-writing).
// Files are read from the repository at runtime (same pattern as
// src/lib/creative-skills/loader.ts) so the Docker image stays self-contained.

const H3_SKILL_ROOT_SEGMENTS = ['src', 'lib', 'video-generation', 'h3-prompt-skill'] as const
const SKILL_FILE = 'SKILL.md'
const GUIDE_FILES: Record<'base' | 'ref', string> = {
  base: 'references/base-en.txt',
  ref: 'references/ref-en.txt',
}

export type H3GuideKind = 'base' | 'ref'

export interface H3PromptSkillGuides {
  readonly skill: string
  readonly guide: string
  readonly checksum: string
}

const guideCache = new Map<H3GuideKind, Promise<H3PromptSkillGuides>>()

function readSkillText(absolutePath: string, label: string): Promise<string> {
  return readFile(absolutePath, 'utf8').catch((error) => {
    const code = error instanceof Error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : 'UNKNOWN'
    throw new Error(`H3_PROMPT_SKILL_UNAVAILABLE:${label}:${code}`, { cause: error })
  })
}

export function loadH3PromptSkillGuides(kind: H3GuideKind): Promise<H3PromptSkillGuides> {
  const cached = guideCache.get(kind)
  if (cached) return cached
  const root = path.resolve(process.cwd(), ...H3_SKILL_ROOT_SEGMENTS)
  const load = Promise.all([
    readSkillText(path.resolve(root, SKILL_FILE), 'skill'),
    readSkillText(path.resolve(root, GUIDE_FILES[kind]), `guide:${kind}`),
  ]).then(([skill, guide]) => ({
    skill,
    guide,
    checksum: createHash('sha256').update(`${skill}\n${guide}`, 'utf8').digest('hex'),
  }))
  guideCache.set(kind, load)
  return load
}
