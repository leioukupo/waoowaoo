import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import {
  backfillWorkspaceResourceModels,
  computeMediaModelBackfillTargets,
  hasMediaModelBackfillTargets,
} from '@/lib/user-api/media-model-backfill'
import type { StoredModel, StoredProvider } from '@/lib/user-api/api-config-types'

function model(overrides: Partial<StoredModel> & Pick<StoredModel, 'modelKey' | 'type'>): StoredModel {
  return {
    modelId: overrides.modelKey.split('::')[1] ?? 'model',
    name: 'Test Model',
    provider: overrides.modelKey.split('::')[0] ?? 'openrouter',
    price: 0,
    ...overrides,
  }
}

function provider(overrides: Partial<StoredProvider> & Pick<StoredProvider, 'id'>): StoredProvider {
  return {
    name: overrides.id,
    apiKey: 'encrypted-key',
    ...overrides,
  }
}

const providers = [
  provider({ id: 'openrouter' }),
  provider({ id: 'fal' }),
  provider({ id: 'elevenlabs' }),
]

describe('computeMediaModelBackfillTargets', () => {
  it('selects the single model of every configured media slot', () => {
    const targets = computeMediaModelBackfillTargets([
      model({ modelKey: 'openrouter::llm/assistant-1', type: 'llm' }),
      model({ modelKey: 'openrouter::img/one', type: 'image' }),
      model({ modelKey: 'fal::video/two', type: 'video' }),
      model({ modelKey: 'fal::music/three', type: 'music' }),
      model({ modelKey: 'elevenlabs::voice/four', type: 'voice' }),
    ], providers)
    expect(targets).toEqual({
      image: 'openrouter::img/one',
      video: 'fal::video/two',
      music: 'fal::music/three',
      voice: 'elevenlabs::voice/four',
    })
  })

  it('drops slots whose only model belongs to a provider without a credential', () => {
    const targets = computeMediaModelBackfillTargets([
      model({ modelKey: 'fal::video/two', type: 'video' }),
      model({ modelKey: 'elevenlabs::voice/four', type: 'voice' }),
    ], [
      provider({ id: 'fal', apiKey: '' }),
      provider({ id: 'elevenlabs' }),
    ])
    expect(targets).toEqual({ voice: 'elevenlabs::voice/four' })
  })

  it('skips ambiguous slots instead of guessing', () => {
    const targets = computeMediaModelBackfillTargets([
      model({ modelKey: 'openrouter::img/a', type: 'image' }),
      model({ modelKey: 'fal::img/b', type: 'image' }),
      model({ modelKey: 'fal::video/two', type: 'video' }),
    ], providers)
    expect(targets).toEqual({ video: 'fal::video/two' })
  })

  it('returns an empty target set when nothing is configured', () => {
    expect(computeMediaModelBackfillTargets([], providers)).toEqual({})
  })
})

describe('hasMediaModelBackfillTargets', () => {
  it('detects at least one actionable slot', () => {
    expect(hasMediaModelBackfillTargets({})).toBe(false)
    expect(hasMediaModelBackfillTargets({ voice: 'elevenlabs::voice/four' })).toBe(true)
  })
})

describe('backfillWorkspaceResourceModels', () => {
  it('replaces frozen model keys per slot, splitting audio resources by schema', async () => {
    const updateMany = vi.fn(async (call: { where: Prisma.WorkspaceResourceWhereInput; data: unknown }) => ({ count: 1 }))
    const client = { workspaceResource: { updateMany } } as unknown as Pick<Prisma.TransactionClient, 'workspaceResource'>
    const counts = await backfillWorkspaceResourceModels(
      'user-1',
      {
        image: 'openrouter::img/new',
        video: 'fal::video/new',
        music: 'fal::music/new',
        voice: 'elevenlabs::voice/new',
      },
      client,
    )
    expect(counts).toEqual({ image: 1, video: 1, music: 1, voice: 1 })
    expect(updateMany).toHaveBeenCalledTimes(4)

    const calledWhere = updateMany.mock.calls.map((call) => call[0].where)
    const imageWhere = calledWhere.find((where) => where.mediaType === 'image')
    const videoWhere = calledWhere.find((where) => where.mediaType === 'video')
    const audioWheres = calledWhere.filter((where) => where.mediaType === 'audio')
    expect(imageWhere).toBeDefined()
    expect(videoWhere).toBeDefined()
    expect(audioWheres.map((where) => where.schemaId).sort()).toEqual(['project.bgm_audio', 'project.voice_reference'])

    for (const where of calledWhere) {
      expect(where.userId).toBe('user-1')
      expect(where.resourceKind).toBe('file')
      expect(where.deletedAt).toBe(null)
      expect(where.AND).toEqual([
        { modelKey: { not: null } },
        { modelKey: { not: where.mediaType === 'audio' && where.schemaId === 'project.bgm_audio'
          ? 'fal::music/new'
          : where.mediaType === 'audio'
            ? 'elevenlabs::voice/new'
            : where.mediaType === 'image'
              ? 'openrouter::img/new'
              : 'fal::video/new' } },
      ])
    }
    expect(updateMany.mock.calls[0][0].data).toEqual({ modelKey: 'openrouter::img/new' })
  })

  it('leaves slots without a target untouched', async () => {
    const updateMany = vi.fn(async (call: { where: Prisma.WorkspaceResourceWhereInput; data: unknown }) => ({ count: 0 }))
    const client = { workspaceResource: { updateMany } } as unknown as Pick<Prisma.TransactionClient, 'workspaceResource'>
    const counts = await backfillWorkspaceResourceModels('user-1', { video: 'fal::video/new' }, client)
    expect(counts).toEqual({ image: 0, video: 0, music: 0, voice: 0 })
    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(updateMany.mock.calls[0][0].where.mediaType).toBe('video')
  })
})
