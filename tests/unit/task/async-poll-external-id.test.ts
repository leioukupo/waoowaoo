import { describe, expect, it } from 'vitest'
import { formatExternalId, parseExternalId } from '@/lib/ai-exec/async-poll'
import { normalizeAsyncPollResult } from '@/lib/ai-providers/async-task-types'
import { createProviderAsyncTaskFailure } from '@/lib/ai-providers/shared/async-task-status'
import type { FailureRecord } from '@/lib/errors/failure'

describe('async poll externalId contract', () => {
  it('requires the canonical failure record only for failed provider terminals', () => {
    const failure = createProviderAsyncTaskFailure({
      provider: 'test', code: 'EXTERNAL_ERROR', message: 'native terminal failure',
      cause: { name: 'ProviderError', message: 'native terminal failure', code: 'P-42' },
    })
    expect(() => normalizeAsyncPollResult({ status: 'failed' }))
      .toThrow('ASYNC_PROVIDER_FAILURE_RECORD_REQUIRED')
    expect(() => normalizeAsyncPollResult({ status: 'pending', failure }))
      .toThrow('ASYNC_PROVIDER_NON_FAILURE_RECORD_FORBIDDEN')
    expect(() => normalizeAsyncPollResult({
      status: 'failed',
      failure: { version: 2 } as unknown as FailureRecord,
    })).toThrow('ASYNC_PROVIDER_FAILURE_RECORD_REQUIRED')
    expect(normalizeAsyncPollResult({
      status: 'failed',
      failure,
    })).toMatchObject({
      status: 'failed',
      failure: {
        native: { code: 'P-42' },
        interpretation: { code: 'EXTERNAL_ERROR' },
        recovery: { operation: 'provider.terminal.result', taskReplay: 'forbidden' },
      },
    })
  })

  it('parses standard FAL externalId with endpoint', () => {
    const parsed = parseExternalId('FAL:VIDEO:fal-ai/wan/v2.6/image-to-video:req_123')
    expect(parsed.provider).toBe('FAL')
    expect(parsed.type).toBe('VIDEO')
    expect(parsed.endpoint).toBe('fal-ai/wan/v2.6/image-to-video')
    expect(parsed.requestId).toBe('req_123')
  })

  it('rejects legacy non-standard externalId formats', () => {
    expect(() => parseExternalId('FAL:fal-ai/wan/v2.6/image-to-video:req_123')).toThrow(/无效 FAL externalId/)
    expect(() => parseExternalId('batches/legacy')).toThrow(/无法识别的 externalId 格式/)
  })

  it('requires endpoint when formatting FAL externalId', () => {
    expect(() => formatExternalId('FAL', 'VIDEO', 'req_123')).toThrow(/requires endpoint/)
  })

  it('parses and formats FAL music externalId through the shared async protocol', () => {
    const externalId = formatExternalId('FAL', 'MUSIC', 'music_123', 'fal-ai/lyria-3/8b')
    expect(externalId).toBe('FAL:MUSIC:fal-ai/lyria-3/8b:music_123')

    const parsed = parseExternalId(externalId)
    expect(parsed.provider).toBe('FAL')
    expect(parsed.type).toBe('MUSIC')
    expect(parsed.endpoint).toBe('fal-ai/lyria-3/8b')
    expect(parsed.requestId).toBe('music_123')
  })

  it('parses and formats ARK externalId', () => {
    const externalId = formatExternalId('ARK', 'VIDEO', 'task_123')
    expect(externalId).toBe('ARK:VIDEO:task_123')

    const parsed = parseExternalId(externalId)
    expect(parsed.provider).toBe('ARK')
    expect(parsed.type).toBe('VIDEO')
    expect(parsed.requestId).toBe('task_123')
  })

  it('parses and formats GOOGLE video externalId', () => {
    const externalId = formatExternalId('GOOGLE', 'VIDEO', 'task_456')
    expect(externalId).toBe('GOOGLE:VIDEO:task_456')

    const parsed = parseExternalId(externalId)
    expect(parsed.provider).toBe('GOOGLE')
    expect(parsed.type).toBe('VIDEO')
    expect(parsed.requestId).toBe('task_456')
  })

  it('parses and formats OPENROUTER video externalId', () => {
    const externalId = formatExternalId('OPENROUTER', 'VIDEO', 'job_789')
    expect(externalId).toBe('OPENROUTER:VIDEO:job_789')

    const parsed = parseExternalId(externalId)
    expect(parsed.provider).toBe('OPENROUTER')
    expect(parsed.type).toBe('VIDEO')
    expect(parsed.requestId).toBe('job_789')
  })

  it('preserves a custom OpenRouter channel in the durable externalId', () => {
    const externalId = formatExternalId(
      'OPENROUTER',
      'VIDEO',
      'job_custom',
      undefined,
      'openrouter:third-party',
    )
    expect(externalId).toBe('OPENROUTER:VIDEO:job_custom:provider=openrouter%3Athird-party')

    const parsed = parseExternalId(externalId)
    expect(parsed.provider).toBe('OPENROUTER')
    expect(parsed.type).toBe('VIDEO')
    expect(parsed.requestId).toBe('job_custom')
    expect(parsed.providerToken).toBe('openrouter:third-party')
  })
})
