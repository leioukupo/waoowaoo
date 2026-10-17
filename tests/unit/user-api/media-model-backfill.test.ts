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

interface FakeCall {
  where: Prisma.WorkspaceResourceWhereInput
  data: Record<string, unknown>
}

function fakeClient(projectIds: string[]) {
  const updateMany = vi.fn(async (_args: { where: Prisma.WorkspaceResourceWhereInput; data: Record<string, unknown> }) => ({
    count: 1,
  }))
  const findMany = vi.fn(async () => projectIds.map((projectId) => ({ projectId })))
  const projectUpdate = vi.fn(async (_args: { where: { id: string; userId: string }; data: Record<string, unknown>; select: Record<string, boolean> }) => ({ workspaceResourceRevision: 7 }))
  const client = {
    workspaceResource: { findMany, updateMany },
    project: { update: projectUpdate },
  }
  return { client, updateMany, findMany, projectUpdate }
}

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
    const { client, updateMany, projectUpdate } = fakeClient(['project-1', 'project-2'])
    const counts = await backfillWorkspaceResourceModels(
      'user-1',
      {
        image: 'openrouter::img/new',
        video: 'fal::video/new',
        music: 'fal::music/new',
        voice: 'elevenlabs::voice/new',
      },
      client as unknown as Prisma.TransactionClient,
    )
    expect(counts).toEqual({ image: 2, video: 2, music: 2, voice: 2 })
    expect(updateMany).toHaveBeenCalledTimes(8)

    const calls: FakeCall[] = updateMany.mock.calls.map((call) => call[0])
    const imageCalls = calls.filter((call) => call.where.mediaType === 'image')
    const videoCalls = calls.filter((call) => call.where.mediaType === 'video')
    const audioCalls = calls.filter((call) => call.where.mediaType === 'audio')
    expect(imageCalls.map((call) => call.where.schemaId).sort()).toEqual([undefined, undefined])
    expect(videoCalls).toHaveLength(2)
    expect(audioCalls.map((call) => call.where.schemaId).sort())
      .toEqual(['project.bgm_audio', 'project.bgm_audio', 'project.voice_reference', 'project.voice_reference'])

    for (const call of calls) {
      expect(call.where.userId).toBe('user-1')
      expect(call.where.resourceKind).toBe('file')
      expect(call.where.deletedAt).toBe(null)
      expect(call.where.AND).toEqual([
        { modelKey: { not: null } },
        {
          modelKey: {
            not: call.where.mediaType === 'audio'
              ? call.where.schemaId === 'project.bgm_audio'
                ? 'fal::music/new'
                : 'elevenlabs::voice/new'
              : call.where.mediaType === 'image'
                ? 'openrouter::img/new'
                : 'fal::video/new',
          },
        },
      ])
      expect(call.data).toEqual({
        modelKey: call.where.mediaType === 'audio'
          ? call.where.schemaId === 'project.bgm_audio'
            ? 'fal::music/new'
            : 'elevenlabs::voice/new'
          : call.where.mediaType === 'image'
            ? 'openrouter::img/new'
            : 'fal::video/new',
      })
    }
    const projectIds = new Set(calls.map((call) => call.where.projectId))
    expect(projectIds).toEqual(new Set(['project-1', 'project-2']))
    // Each changed project advances its canvas revision.
    expect(projectUpdate).toHaveBeenCalledTimes(8)
    expect(projectUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: 'project-1', userId: 'user-1' },
      data: { workspaceResourceRevision: { increment: 1 } },
    })
  })

  it('leaves slots without a target untouched', async () => {
    const { client, updateMany, projectUpdate } = fakeClient(['project-1'])
    const counts = await backfillWorkspaceResourceModels(
      'user-1',
      { video: 'fal::video/new' },
      client as unknown as Prisma.TransactionClient,
    )
    expect(counts).toEqual({ image: 0, video: 1, music: 0, voice: 0 })
    expect(updateMany).toHaveBeenCalledTimes(1)
    expect((updateMany.mock.calls[0][0].where.mediaType as string)).toBe('video')
    expect(projectUpdate).toHaveBeenCalledTimes(1)
  })

  it('skips revision bumps when nothing changed in a project', async () => {
    const { client, projectUpdate } = fakeClient(['project-1'])
    const noopClient = {
      workspaceResource: {
        findMany: vi.fn(async () => [{ projectId: 'project-1' }]),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      project: { update: projectUpdate },
    }
    const counts = await backfillWorkspaceResourceModels(
      'user-1',
      { image: 'openrouter::img/new' },
      noopClient as unknown as Prisma.TransactionClient,
    )
    expect(counts).toEqual({ image: 0, video: 0, music: 0, voice: 0 })
    expect(projectUpdate).not.toHaveBeenCalled()
    expect(client).toBeDefined()
  })
})
