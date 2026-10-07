import { NextRequest, NextResponse } from 'next/server'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler } from '@/lib/api-errors'
import { requireAdminUserId } from '@/lib/admin/admin-auth'
import { getRuntimeInfrastructurePublicConfig, updateRuntimeInfrastructureConfig } from '@/lib/runtime-config/infrastructure'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async () => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  requireAdminUserId(auth.session.user.id)
  return NextResponse.json(await getRuntimeInfrastructurePublicConfig())
})

export const PUT = apiHandler(async (request: NextRequest) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  requireAdminUserId(auth.session.user.id)
  const body = await request.json()
  const result = await updateRuntimeInfrastructureConfig(body)
  return NextResponse.json(result)
})
