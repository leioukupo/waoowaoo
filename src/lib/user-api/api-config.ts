import {
  getUserApiConfig as getUserApiConfigFromService,
  putUserApiConfig as putUserApiConfigFromService,
} from '@/lib/user-api/api-config-service'
import type { Prisma } from '@prisma/client'

export async function getUserApiConfig(userId: string) {
  return getUserApiConfigFromService(userId)
}

export async function putUserApiConfig(
  userId: string,
  body: unknown,
  client?: Prisma.TransactionClient,
) {
  return putUserApiConfigFromService(userId, body, client)
}
