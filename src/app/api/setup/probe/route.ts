import { NextRequest, NextResponse } from 'next/server'
import { isRuntimeConfigured } from '@/lib/runtime-config/store'
import { isProbeHostAllowed, probeSetupServices } from '@/lib/setup/probe'
import { createSlidingWindowThrottle } from '@/lib/setup/throttle'

export const dynamic = 'force-dynamic'

// Redis is not configured yet during setup, so this endpoint keeps a small
// in-memory window instead of the Redis-backed limiter.
const PROBE_THROTTLE = createSlidingWindowThrottle(10 * 60 * 1000, 20)

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  const real = request.headers.get('x-real-ip')
  return real?.trim() || 'unknown'
}

export async function POST(request: NextRequest) {
  if (isRuntimeConfigured()) {
    return NextResponse.json({ error: { code: 'SETUP_ALREADY_COMPLETE' } }, { status: 409 })
  }

  let body: { host?: unknown }
  try {
    body = (await request.json()) as { host?: unknown }
  } catch {
    return NextResponse.json({ error: { code: 'INVALID_JSON' } }, { status: 400 })
  }

  const host = typeof body.host === 'string' ? body.host.trim() : ''
  if (!isProbeHostAllowed(host)) {
    return NextResponse.json({ error: { code: 'PROBE_HOST_INVALID' } }, { status: 400 })
  }

  const waitSeconds = PROBE_THROTTLE.allow(clientIp(request))
  if (waitSeconds !== null) {
    return NextResponse.json(
      { error: { code: 'PROBE_RATE_LIMITED', retryAfterSeconds: waitSeconds } },
      { status: 429, headers: { 'retry-after': String(waitSeconds) } },
    )
  }

  const result = await probeSetupServices(host)
  return NextResponse.json(result)
}
