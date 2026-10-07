import { Client, Connection } from '@temporalio/client'
import {
  buildTemporalConnectionOptions,
  getTemporalRuntimeConfig,
  type TemporalRuntimeConfig,
} from './config'

export interface ConnectedTemporalClient {
  client: Client
  close(): Promise<void>
}

export async function connectTemporalClient(
  config: TemporalRuntimeConfig = getTemporalRuntimeConfig(),
): Promise<ConnectedTemporalClient> {
  const connection = await Connection.connect(
    buildTemporalConnectionOptions(config),
  )
  return {
    client: new Client({
      connection,
      namespace: config.namespace,
    }),
    async close() {
      await connection.close()
    },
  }
}

const globalForTemporal = globalThis as typeof globalThis & {
  __waoowaooTemporalConnectionPromise?: Promise<ConnectedTemporalClient>
}

export async function resetTemporalClient(): Promise<void> {
  const connection = await globalForTemporal.__waoowaooTemporalConnectionPromise?.catch(() => undefined)
  globalForTemporal.__waoowaooTemporalConnectionPromise = undefined
  await connection?.close()
}

export async function getTemporalClient(): Promise<Client> {
  if (!globalForTemporal.__waoowaooTemporalConnectionPromise) {
    globalForTemporal.__waoowaooTemporalConnectionPromise = connectTemporalClient()
      .catch((error: unknown) => {
        delete globalForTemporal.__waoowaooTemporalConnectionPromise
        throw error
      })
  }
  const connected = await globalForTemporal.__waoowaooTemporalConnectionPromise
  return connected.client
}
