import { createScopedLogger } from '@/lib/logging/core'
import { EXTERNAL_OPERATION } from '@/lib/external-operation/registry'
import { withRetry } from '@/lib/retry'
import { S3StorageProvider } from '@/lib/storage/providers/s3'
import type {
  DeleteObjectsResult,
  ObjectMetadata,
  ObjectByteRange,
  ObjectStreamResult,
  StorageProvider,
} from '@/lib/storage/types'
import { DEFAULT_SIGNED_URL_EXPIRES_SECONDS } from '@/lib/storage/utils'

const storageLogger = createScopedLogger({
  module: 'storage.provider',
})

let providerSingleton: StorageProvider | null = null

export function resetStorageProvider(): void {
  providerSingleton = null
}

export function getStorageProvider(): StorageProvider {
  if (!providerSingleton) {
    providerSingleton = new S3StorageProvider()
    storageLogger.info(`[Storage] provider initialized: ${providerSingleton.kind}`)
  }
  return providerSingleton
}

export function getMediaObjectDelivery(): StorageProvider['mediaObjectDelivery'] {
  return getStorageProvider().mediaObjectDelivery
}

export function toFetchableUrl(inputUrl: string): string {
  return getStorageProvider().toFetchableUrl(inputUrl)
}

export function generateUniqueKey(prefix: string, ext: string = 'png'): string {
  return getStorageProvider().generateUniqueKey({ prefix, ext })
}

export async function uploadObject(
  body: Buffer,
  key: string,
  contentType?: string,
): Promise<string> {
  const provider = getStorageProvider()

  const result = await withRetry({
    operation: EXTERNAL_OPERATION.STORAGE_PUT_SAME_OBJECT,
    scope: 'storage:upload',
    run: async () => {
      return await provider.uploadObject({ key, body, contentType })
    },
  })

  return result.key
}

export async function deleteObject(key: string): Promise<void> {
  await withRetry({
    operation: EXTERNAL_OPERATION.STORAGE_DELETE,
    run: async () => await getStorageProvider().deleteObject(key),
  })
}

export async function deleteObjects(keys: string[]): Promise<DeleteObjectsResult> {
  return await withRetry({
    operation: EXTERNAL_OPERATION.STORAGE_DELETE,
    run: async () => await getStorageProvider().deleteObjects(keys),
  })
}

export function extractStorageKey(input: string | null | undefined): string | null {
  return getStorageProvider().extractStorageKey(input)
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  return await withRetry({
    operation: EXTERNAL_OPERATION.STORAGE_READ,
    run: async () => await getStorageProvider().getObjectBuffer(key),
  })
}

export async function getObjectStream(
  key: string,
  range?: ObjectByteRange,
): Promise<ObjectStreamResult> {
  return await withRetry({
    operation: EXTERNAL_OPERATION.STORAGE_READ,
    run: async () => await getStorageProvider().getObjectStream(key, range),
  })
}

export async function getObjectMetadata(key: string): Promise<ObjectMetadata> {
  return await withRetry({
    operation: EXTERNAL_OPERATION.STORAGE_READ,
    run: async () => await getStorageProvider().getObjectMetadata(key),
  })
}

export type SignedObjectUrlOptions = {
  readonly expiresInSeconds?: number
  readonly responseCacheControl?: string
}

export async function getSignedObjectUrl(
  key: string,
  options: SignedObjectUrlOptions = {},
): Promise<string> {
  return await withRetry({
    operation: EXTERNAL_OPERATION.STORAGE_SIGN,
    run: async () => await getStorageProvider().getSignedObjectUrl({
      key,
      expiresInSeconds: options.expiresInSeconds ?? DEFAULT_SIGNED_URL_EXPIRES_SECONDS,
      ...(options.responseCacheControl
        ? { responseCacheControl: options.responseCacheControl }
        : {}),
    }),
  })
}

export function getSignedUrl(key: string, expiresInSeconds: number = DEFAULT_SIGNED_URL_EXPIRES_SECONDS): string {
  return `/api/storage/sign?key=${encodeURIComponent(key)}&expires=${encodeURIComponent(String(expiresInSeconds))}`
}

export function getSignedUrls(keys: string[], expiresInSeconds: number = DEFAULT_SIGNED_URL_EXPIRES_SECONDS): string[] {
  return keys.map((key) => getSignedUrl(key, expiresInSeconds))
}

export * from './signed-urls'
