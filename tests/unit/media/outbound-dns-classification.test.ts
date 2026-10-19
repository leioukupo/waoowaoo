import { describe, expect, it } from 'vitest'
import { OutboundMediaSecurityError } from '@/lib/media/outbound-fetch'
import { getExternalOperationContract } from '@/lib/external-operation/registry'

describe('outbound media security failure classification', () => {
  it('classifies DNS failures as a retryable, replay-safe operation', () => {
    const error = new OutboundMediaSecurityError(
      'OUTBOUND_MEDIA_DNS_FAILED',
      'https://example.test/video.mp4',
      'outbound media DNS lookup returned no addresses',
    )
    expect(error.failure.recovery.operation).toBe('media.download-dns')
    const contract = getExternalOperationContract('media.download-dns')
    expect(contract.taskReplay).toBe('safe')
    expect(contract.replay).toBe('idempotent')
    expect(contract.maxAttempts).toBeGreaterThanOrEqual(2)
  })

  it('keeps deterministic policy rejections non-retryable', () => {
    for (const code of [
      'OUTBOUND_MEDIA_URL_INVALID',
      'OUTBOUND_MEDIA_URL_UNSAFE',
      'OUTBOUND_MEDIA_REDIRECT_LIMIT',
    ] as const) {
      const error = new OutboundMediaSecurityError(code, 'https://example.test/video.mp4', 'rejected')
      expect(error.failure.recovery.operation, code).toBe('media.download-policy')
      expect(getExternalOperationContract('media.download-policy').taskReplay).toBe('forbidden')
    }
  })
})
