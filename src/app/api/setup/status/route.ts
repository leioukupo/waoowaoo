import { NextResponse } from 'next/server'
import { isRuntimeConfigured } from '@/lib/runtime-config/store'

export const dynamic = 'force-dynamic'

export async function GET() {
  const configured = isRuntimeConfigured()
  return NextResponse.json({
    configured,
    setupUrlTokenRequired: !configured,
  })
}
