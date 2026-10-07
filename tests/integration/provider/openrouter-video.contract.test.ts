import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  executeOpenRouterVideoGeneration,
  submitOpenRouterVideoTask,
} from '@/lib/ai-providers/openrouter/video'
import { ProviderSubmissionError } from '@/lib/ai-exec/submission-error'
import { startScenarioServer } from '../../helpers/fakes/scenario-server'

describe('provider contract - OpenRouter video', () => {
  let server: Awaited<ReturnType<typeof startScenarioServer>> | null = null

  const providerConfig = (id = 'openrouter') => {
    if (!server) throw new Error('TEST_SCENARIO_SERVER_REQUIRED')
    return {
      id,
      name: id,
      apiKey: 'openrouter-video-key',
      baseUrl: `${server.baseUrl}/openrouter`,
    }
  }

  beforeEach(async () => {
    server = await startScenarioServer()
  })

  afterEach(async () => {
    await server?.close()
    server = null
  })

  it('does not retry an uncertain SDK video submission', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'retryable_error_then_success',
      submitResponse: { status: 503, body: { error: 'upstream unavailable' } },
      pollSequence: [{
        status: 202,
        body: {
          id: 'must-not-be-reached',
          status: 'pending',
          polling_url: `${server!.baseUrl}/openrouter/videos/must-not-be-reached`,
        },
      }],
    })

    await expect(submitOpenRouterVideoTask({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-video-key',
      payload: {
        model: 'bytedance/seedance-2.0',
        prompt: 'submit exactly once',
        duration: 5,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    })).rejects.toMatchObject({ statusCode: 503 })

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('preserves an accepted external id when the SDK rejects only the response shape', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'malformed_response',
      submitResponse: {
        status: 202,
        body: {
          id: 'accepted-job-id',
          status: 'pending',
          error: { message: 'non-contract warning shape' },
        },
      },
    })

    await expect(submitOpenRouterVideoTask({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-video-key',
      payload: {
        model: 'bytedance/seedance-2.0-fast',
        prompt: 'preserve the accepted provider identity',
        duration: 15,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    })).resolves.toBe('accepted-job-id')

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('surfaces the typed provider rejection hidden by an SDK response validation error', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'fatal_error',
      submitResponse: {
        status: 202,
        body: {
          error: {
            code: 400,
            message: 'Reference images must use directly downloadable URLs',
            metadata: { error_type: 'invalid_request' },
          },
        },
      },
    })

    await expect(submitOpenRouterVideoTask({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-video-key',
      payload: {
        model: 'bytedance/seedance-2.0-fast',
        prompt: 'surface the provider rejection',
        duration: 15,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'PROVIDER_SUBMISSION_REJECTED',
      disposition: 'rejected',
      details: {
        providerCode: 400,
        providerErrorType: 'invalid_request',
      },
      message: expect.stringContaining('Reference images must use directly downloadable URLs'),
    })

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('does not infer a submission disposition from a bare retryable HTTP status', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'fatal_error',
      submitResponse: {
        status: 429,
        body: { error: { code: 429, message: 'Rate limited' } },
      },
    })

    try {
      await submitOpenRouterVideoTask({
        baseUrl: `${server!.baseUrl}/openrouter`,
        apiKey: 'openrouter-video-key',
        payload: {
          model: 'bytedance/seedance-2.0-fast',
          prompt: 'do not infer acceptance from HTTP status',
          duration: 15,
          resolution: '720p',
          aspectRatio: '16:9',
        },
      })
      throw new Error('Expected the submission to fail')
    } catch (error) {
      expect(error).not.toBeInstanceOf(ProviderSubmissionError)
      expect(error).toMatchObject({ code: 'RATE_LIMIT' })
    }

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('preserves the provider privacy rejection as a permanent content-policy fact', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'fatal_error',
      submitResponse: {
        status: 202,
        body: {
          error: {
            code: 400,
            message: 'The supplied reference was rejected.',
            metadata: {
              error_type: 'InputImageSensitiveContentDetected.PrivacyInformation',
            },
          },
        },
      },
    })

    await expect(submitOpenRouterVideoTask({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-video-key',
      payload: {
        model: 'bytedance/seedance-2.0-fast',
        prompt: 'Do not collapse a machine policy code into an internal error.',
        duration: 15,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'SENSITIVE_CONTENT',
      disposition: 'rejected',
      provider: 'openrouter',
    })

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('does not turn an unclassified accepted response into a safe-to-retry rejection', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'malformed_response',
      submitResponse: {
        status: 202,
        body: { status: 'pending' },
      },
    })

    await expect(submitOpenRouterVideoTask({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-video-key',
      payload: {
        model: 'bytedance/seedance-2.0-fast',
        prompt: 'keep an ambiguous submission outcome fenced',
        duration: 15,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    })).rejects.toMatchObject({
      name: 'Error',
      message: 'OPENROUTER_VIDEO_SUBMIT_RESPONSE_INVALID_WITHOUT_ACCEPTANCE_ID_OR_ERROR',
    })

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('serializes Seedance image and voice references through one multimodal input list', async () => {
    const referenceAudioDataUrl = 'data:audio/wav;base64,UklGRgQAAABXQVZF'
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'success',
      submitResponse: {
        status: 202,
        body: {
          id: 'seedance-audio-reference-job',
          status: 'pending',
          polling_url: '/openrouter/videos/seedance-audio-reference-job',
        },
      },
    })

    await expect(executeOpenRouterVideoGeneration({
      userId: 'user-1',
      providerConfig: providerConfig(),
      selection: {
        provider: 'openrouter',
        modelId: 'bytedance/seedance-2.0-fast',
        modelKey: 'openrouter::bytedance/seedance-2.0-fast',
        variantSubKind: 'official',
      },
      imageUrl: '',
      options: {
        prompt: 'Image 1 speaks with audio 1 while following video 1 motion.',
        referenceImages: ['https://example.com/character.png'],
        referenceAudios: [referenceAudioDataUrl],
        referenceVideos: ['https://example.com/motion.mp4'],
        duration: 6,
        resolution: '720p',
        aspectRatio: '16:9',
        generateAudio: true,
      },
    })).resolves.toMatchObject({
      externalId: 'OPENROUTER:VIDEO:seedance-audio-reference-job',
    })

    const requests = server!.getRequests('POST', '/openrouter/videos')
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]?.bodyText || '{}')).toMatchObject({
      input_references: [
        { type: 'image_url', image_url: { url: 'https://example.com/character.png' } },
        { type: 'audio_url', audio_url: { url: referenceAudioDataUrl } },
        { type: 'video_url', video_url: { url: 'https://example.com/motion.mp4' } },
      ],
    })
  })

  it('persists a custom OpenRouter channel in the async external id', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'success',
      submitResponse: {
        status: 202,
        body: {
          id: 'custom-channel-job',
          status: 'pending',
          polling_url: '/openrouter/videos/custom-channel-job',
        },
      },
    })

    await expect(executeOpenRouterVideoGeneration({
      userId: 'user-1',
      providerConfig: providerConfig('openrouter:third-party'),
      selection: {
        provider: 'openrouter:third-party',
        modelId: 'bytedance/seedance-2.0-fast',
        modelKey: 'openrouter:third-party::bytedance/seedance-2.0-fast',
        variantSubKind: 'official',
      },
      imageUrl: '',
      options: {
        prompt: 'keep the custom channel identity on the durable task',
        duration: 6,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    })).resolves.toMatchObject({
      externalId: 'OPENROUTER:VIDEO:custom-channel-job:provider=openrouter%3Athird-party',
    })
  })
})
