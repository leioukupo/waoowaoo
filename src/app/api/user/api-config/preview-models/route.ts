import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { ApiError, apiHandler } from '@/lib/api-errors'
import { previewChannelModels } from '@/lib/user-api/api-config-preview-models'

const requestSchema = z.object({
  baseUrl: z.string().min(1).max(500),
  // OpenAI 兼容渠道允许不带 Key
  apiKey: z.string().max(500).optional(),
}).strict()

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth

  const body: unknown = await request.json().catch(() => null)
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    throw new ApiError('INVALID_PARAMS', { code: 'PREVIEW_MODELS_INPUT_INVALID', field: 'baseUrl' })
  }

  const result = await previewChannelModels(parsed.data)
  return NextResponse.json(result)
})
