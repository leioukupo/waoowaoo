import { rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { NativeConnection, Worker } from '@temporalio/worker'
import { createScopedLogger } from '@/lib/logging/core'
import type { OperationExecutionActivities } from './operation-execution/contracts'
import type { TaskWorkflowActivities, UserTaskSchedulerActivities } from './task/contracts'
import { buildTemporalConnectionOptions, getTemporalWorkerRuntimeConfig } from './config'
import { UNREGISTERED_WORKFLOW_VERSIONING_FALLBACK } from './workflow-registry'
import { getGeneratedSecrets, readRuntimeConfig } from '@/lib/runtime-config/store'

const logger = createScopedLogger({ module: 'temporal.worker' })

async function runTemporalWorker(): Promise<void> {
  // External Workers can mount the Web data directory and consume the same
  // encrypted configuration file. Environment variables still take
  // precedence, so a deployment may also inject a protected config API.
  const shared = readRuntimeConfig()
  if (shared) {
    const secrets = getGeneratedSecrets()
    process.env.NEXTAUTH_SECRET ||= secrets.nextAuthSecret
    process.env.API_ENCRYPTION_KEY ||= secrets.apiEncryptionKey
    process.env.CRON_SECRET ||= secrets.cronSecret
    process.env.DATABASE_URL ||= shared.databaseUrl
    process.env.REDIS_HOST ||= shared.redis.host
    process.env.REDIS_PORT ||= String(shared.redis.port)
    process.env.REDIS_USERNAME ||= shared.redis.username || ''
    process.env.REDIS_PASSWORD ||= shared.redis.password || ''
    process.env.REDIS_TLS ||= shared.redis.tls ? 'true' : 'false'
    process.env.S3_ENDPOINT ||= shared.storage.endpoint
    process.env.S3_UPLOAD_ENDPOINT ||= shared.storage.uploadEndpoint
    process.env.S3_REGION ||= shared.storage.region
    process.env.S3_BUCKET ||= shared.storage.bucket
    process.env.S3_ACCESS_KEY_ID ||= shared.storage.accessKeyId
    process.env.S3_SECRET_ACCESS_KEY ||= shared.storage.secretAccessKey
    process.env.S3_SESSION_TOKEN ||= shared.storage.sessionToken || ''
    process.env.S3_FORCE_PATH_STYLE ||= shared.storage.forcePathStyle ? 'true' : 'false'
    process.env.TEMPORAL_ADDRESS ||= shared.temporal.address
    process.env.TEMPORAL_NAMESPACE ||= shared.temporal.namespace
    process.env.TEMPORAL_TASK_QUEUE ||= shared.temporal.taskQueue
    process.env.TEMPORAL_API_KEY ||= shared.temporal.apiKey || ''
    process.env.TEMPORAL_TLS_ENABLED ||= shared.temporal.tls ? 'true' : 'false'
  }
  const activities = await import('./activities')
  const config = getTemporalWorkerRuntimeConfig()
  if (config.workerReadyFile) {
    await rm(config.workerReadyFile, { force: true })
  }
  const connection = await NativeConnection.connect(buildTemporalConnectionOptions(config))
  try {
    const worker = await Worker.create({
      connection,
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
      activities: activities satisfies
        TaskWorkflowActivities & UserTaskSchedulerActivities & OperationExecutionActivities,
      // Remote Activity cancellation is delivered through heartbeats. The
      // SDK default may throttle a 45s heartbeat timeout for ~36s, which is
      // too slow for an interactive Agent stop or message correction.
      maxHeartbeatThrottleInterval: '1 second',
      defaultHeartbeatThrottleInterval: '1 second',
      workerDeploymentOptions: {
        version: {
          deploymentName: config.workerDeploymentName,
          buildId: config.workerBuildId,
        },
        useWorkerVersioning: true,
        defaultVersioningBehavior: UNREGISTERED_WORKFLOW_VERSIONING_FALLBACK,
      },
    })
    logger.info({
      action: 'temporal.worker.started',
      message: 'Temporal worker started',
      details: {
        namespace: config.namespace,
        taskQueue: config.taskQueue,
        deploymentName: config.workerDeploymentName,
        buildId: config.workerBuildId,
        versioningEnabled: config.workerVersioningEnabled,
      },
    })
    const runPromise = worker.run()
    try {
      if (config.workerReadyFile) {
        await writeFile(config.workerReadyFile, `${process.pid}\n`, { encoding: 'utf8' })
      }
      await runPromise
    } catch (error: unknown) {
      if (worker.getState() === 'RUNNING') {
        worker.shutdown()
      }
      await runPromise.catch(() => undefined)
      throw error
    } finally {
      if (config.workerReadyFile) {
        await rm(config.workerReadyFile, { force: true })
      }
    }
  } finally {
    await connection.close()
  }
}

void runTemporalWorker().catch((error: unknown) => {
  logger.error({
    action: 'temporal.worker.failed',
    message: 'Temporal worker failed',
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : { message: String(error) },
  })
  process.exitCode = 1
})
