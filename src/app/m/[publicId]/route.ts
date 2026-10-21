import { NextRequest, NextResponse } from 'next/server'
import {
  getMediaObjectDelivery,
  getObjectBuffer,
  getObjectMetadata,
  getObjectStream,
  getSignedObjectUrl,
} from '@/lib/storage'
import { authorizeMediaObjectRead } from '@/lib/media/storage-access-policy'
import { apiHandler } from '@/lib/api-errors'
import { createScopedLogger } from '@/lib/logging/core'

export const runtime = 'nodejs'

/**
 * The redirect must expire before the signed URL. `private` keeps shared/CDN
 * caches out, so this route remains the only authorization gate while the
 * browser downloads immutable bytes directly from object storage.
 */
const MEDIA_SIGNED_URL_EXPIRES_SECONDS = 60 * 60
const MEDIA_CACHE_MAX_AGE_SECONDS = 55 * 60
const MEDIA_CACHE_CONTROL = `private, max-age=${MEDIA_CACHE_MAX_AGE_SECONDS}, immutable`

/**
 * Some object-storage implementations (notably certain RustFS alpha builds)
 * answer ranged GETs with a broken response: they promise the full object
 * length, send zero bytes, and reset the socket. Browsers can never play
 * media over such a connection because their demuxers fetch data by ranges.
 * When a ranged read comes back short or errors, we transparently re-read
 * the whole object and slice out the requested range. Objects above this
 * size are streamed as-is because buffering them is not worth the memory.
 */
const RANGE_FALLBACK_MAX_OBJECT_BYTES = 512 * 1024 * 1024

const mediaDeliveryLogger = createScopedLogger({ module: 'media.delivery' })

async function readWebStreamToBuffer(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error('MEDIA_RANGE_STREAM_EXCEEDS_LIMIT')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function bufferToReadableStream(buffer: Buffer): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      const chunkSize = 256 * 1024
      if (offset < buffer.length) {
        const next = offset + chunkSize
        controller.enqueue(new Uint8Array(buffer.subarray(offset, next)))
        offset = next
      } else {
        controller.close()
      }
    },
  })
}

function buildEtag(media: { sha256?: string | null; id: string; updatedAt?: string | Date | null }) {
  if (media.sha256) return `"${media.sha256}"`
  return `W/"media-${media.id}-${media.updatedAt || '0'}"`
}

function normalizeSizeBytes(value: bigint | number | null): number | null {
  const size = typeof value === 'bigint' ? Number(value) : value
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null
}

type ByteRangeResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'valid'; readonly start: number; readonly end: number }
  | { readonly kind: 'invalid' }

function parseByteRange(header: string | null, totalBytes: number): ByteRangeResult {
  if (!header) return { kind: 'none' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return { kind: 'invalid' }

  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2] || '', 10)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || totalBytes <= 0) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'valid',
      start: Math.max(totalBytes - suffixLength, 0),
      end: totalBytes - 1,
    }
  }

  const start = Number.parseInt(match[1], 10)
  const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : totalBytes - 1
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= totalBytes
    || requestedEnd < start
  ) {
    return { kind: 'invalid' }
  }
  return { kind: 'valid', start, end: Math.min(requestedEnd, totalBytes - 1) }
}

function rangeNotSatisfiable(totalBytes: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${String(totalBytes)}`,
      'Cache-Control': 'private, no-store',
    },
  })
}

export const GET = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ publicId: string }> },
) => {
  const { publicId } = await context.params
  const authorization = await authorizeMediaObjectRead(publicId)
  if (authorization instanceof Response) return authorization
  const { media } = authorization
  if (!media.storageKey) {
    throw new Error('MEDIA_STORAGE_KEY_MISSING')
  }

  if (getMediaObjectDelivery() === 'authenticated-proxy') {
    const etag = buildEtag({
      id: media.id,
      sha256: media.sha256,
      updatedAt: media.updatedAt || null,
    })
    const requestedRange = request.headers.get('range')
    if (!requestedRange && request.headers.get('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          'Accept-Ranges': 'bytes',
          'Cache-Control': MEDIA_CACHE_CONTROL,
          ETag: etag,
        },
      })
    }

    let totalBytes = normalizeSizeBytes(media.sizeBytes)
    let metadataContentType: string | null = null
    if (totalBytes === null) {
      const metadata = await getObjectMetadata(media.storageKey)
      totalBytes = metadata.contentLength
      metadataContentType = metadata.contentType
    }
    if (totalBytes === null || !Number.isSafeInteger(totalBytes) || totalBytes < 0) {
      throw new Error('MEDIA_STORAGE_SIZE_UNAVAILABLE')
    }

    const range = parseByteRange(requestedRange, totalBytes)
    if (range.kind === 'invalid') return rangeNotSatisfiable(totalBytes)
    const headers = new Headers()
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Cache-Control', MEDIA_CACHE_CONTROL)
    headers.set('ETag', etag)

    if (range.kind === 'valid') {
      const expected = range.end - range.start + 1
      const streamDirectly = totalBytes > RANGE_FALLBACK_MAX_OBJECT_BYTES
      let data: Buffer | null = null
      let contentType: string | null = metadataContentType || media.mimeType || null

      if (streamDirectly) {
        // Too large to buffer: keep the original zero-copy behavior.
        const object = await getObjectStream(
          media.storageKey,
          { start: range.start, end: range.end },
        )
        contentType = object.contentType || contentType
        headers.set('Content-Type', contentType || 'application/octet-stream')
        headers.set('Content-Length', String(expected))
        headers.set('Content-Range', `bytes ${String(range.start)}-${String(range.end)}/${String(totalBytes)}`)
        return new Response(object.body, { status: 206, headers })
      }

      try {
        const object = await getObjectStream(
          media.storageKey,
          { start: range.start, end: range.end },
        )
        contentType = object.contentType || contentType
        const fetched = await readWebStreamToBuffer(object.body, totalBytes)
        if (object.contentRange) {
          // A compliant 206: the body is exactly the requested slice.
          if (fetched.length === expected) data = fetched
        } else if (fetched.length >= range.end + 1) {
          // The server ignored the Range header and returned the object
          // from byte zero: slice out what was requested.
          data = fetched.subarray(range.start, range.start + expected)
        }
        if (!data) {
          mediaDeliveryLogger.warn('Ranged object read came back short; retrying full read', {
            action: 'MEDIA_RANGE_FALLBACK',
            publicId: media.publicId,
            rangeStart: range.start,
            rangeEnd: range.end,
            fetchedBytes: fetched.length,
          })
        }
      } catch (error) {
        mediaDeliveryLogger.warn('Ranged object read failed; retrying full read', {
          action: 'MEDIA_RANGE_FALLBACK',
          publicId: media.publicId,
          rangeStart: range.start,
          rangeEnd: range.end,
          reason: error instanceof Error ? error.message : String(error),
        })
      }

      if (!data) {
        const full = await getObjectBuffer(media.storageKey)
        if (full.length < range.end + 1) {
          throw new Error('MEDIA_RANGE_FALLBACK_TRUNCATED')
        }
        data = full.subarray(range.start, range.start + expected)
      }

      headers.set('Content-Type', contentType || 'application/octet-stream')
      headers.set('Content-Length', String(expected))
      headers.set('Content-Range', `bytes ${String(range.start)}-${String(range.end)}/${String(totalBytes)}`)
      return new Response(bufferToReadableStream(data), { status: 206, headers })
    }

    const object = await getObjectStream(media.storageKey)
    headers.set('Content-Type', object.contentType || metadataContentType || media.mimeType || 'application/octet-stream')
    headers.set('Content-Length', String(totalBytes))
    return new Response(object.body, { status: 200, headers })
  }

  const signedUrl = await getSignedObjectUrl(media.storageKey, {
    expiresInSeconds: MEDIA_SIGNED_URL_EXPIRES_SECONDS,
    responseCacheControl: MEDIA_CACHE_CONTROL,
  })

  return new NextResponse(null, {
    status: 307,
    headers: {
      Location: signedUrl,
      'Cache-Control': MEDIA_CACHE_CONTROL,
    },
  })
})

export const HEAD = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ publicId: string }> },
) => {
  const { publicId } = await context.params
  const authorization = await authorizeMediaObjectRead(publicId)
  if (authorization instanceof Response) return authorization
  const { media } = authorization

  const etag = buildEtag({
    id: media.id,
    sha256: media.sha256,
    updatedAt: media.updatedAt || null,
  })

  const headers = new Headers()
  headers.set('Cache-Control', MEDIA_CACHE_CONTROL)
  headers.set('ETag', etag)
  if (getMediaObjectDelivery() === 'authenticated-proxy') {
    if (!media.storageKey) throw new Error('MEDIA_STORAGE_KEY_MISSING')
    const metadata = media.mimeType && normalizeSizeBytes(media.sizeBytes) !== null
      ? null
      : await getObjectMetadata(media.storageKey)
    const sizeBytes = normalizeSizeBytes(media.sizeBytes) ?? metadata?.contentLength ?? null
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Content-Type', media.mimeType || metadata?.contentType || 'application/octet-stream')
    if (sizeBytes !== null) headers.set('Content-Length', String(sizeBytes))
  } else {
    if (media.mimeType) headers.set('Content-Type', media.mimeType)
    if (media.sizeBytes != null) headers.set('Content-Length', String(media.sizeBytes))
  }
  return new Response(null, { status: 200, headers })
})
