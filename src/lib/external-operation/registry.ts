export const EXTERNAL_OPERATION = {
  ASSISTANT_FOLLOW_UP_DELIVERY: 'assistant.follow-up-delivery',
  DATABASE_READ: 'database.read',
  MEDIA_DOWNLOAD: 'media.download',
  MEDIA_DOWNLOAD_DNS: 'media.download-dns',
  MEDIA_DOWNLOAD_POLICY: 'media.download-policy',
  PROVIDER_CANCEL: 'provider.cancel',
  PROVIDER_POLL: 'provider.poll',
  PROVIDER_SUBMIT: 'provider.submit',
  PROVIDER_SUBMIT_REPLAY_AUTHORIZED: 'provider.submit.replay-authorized',
  PROVIDER_TERMINAL_RESULT: 'provider.terminal.result',
  STORAGE_DELETE: 'storage.delete',
  STORAGE_PUT_SAME_OBJECT: 'storage.put-same-object',
  STORAGE_READ: 'storage.read',
  STORAGE_SIGN: 'storage.sign',
  TEMPORAL_TASK_ACTIVITY: 'temporal.task-activity',
} as const

export type ExternalOperationId =
  (typeof EXTERNAL_OPERATION)[keyof typeof EXTERNAL_OPERATION]

export type ExternalEffect = 'committed' | 'none' | 'unknown'
export type TaskReplaySafety = 'forbidden' | 'safe'

export type ExternalOperationContract = {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly replay: 'forbidden' | 'idempotent'
  readonly effectOnFailure: ExternalEffect
  readonly taskReplay: TaskReplaySafety
}

/**
 * The only replay-policy owner. Callers select a closed operation identity;
 * they cannot supply retry counts, retryable booleans or error-code rules.
 */
export const EXTERNAL_OPERATION_REGISTRY = {
  [EXTERNAL_OPERATION.ASSISTANT_FOLLOW_UP_DELIVERY]: {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    replay: 'idempotent',
    effectOnFailure: 'unknown',
    taskReplay: 'safe',
  },
  [EXTERNAL_OPERATION.DATABASE_READ]: {
    maxAttempts: 3,
    baseDelayMs: 80,
    maxDelayMs: 320,
    replay: 'idempotent',
    effectOnFailure: 'none',
    taskReplay: 'safe',
  },
  [EXTERNAL_OPERATION.MEDIA_DOWNLOAD]: {
    maxAttempts: 3,
    baseDelayMs: 2_000,
    maxDelayMs: 8_000,
    replay: 'idempotent',
    effectOnFailure: 'none',
    taskReplay: 'safe',
  },
  [EXTERNAL_OPERATION.MEDIA_DOWNLOAD_DNS]: {
    maxAttempts: 3,
    baseDelayMs: 2_000,
    maxDelayMs: 8_000,
    replay: 'idempotent',
    effectOnFailure: 'none',
    taskReplay: 'safe',
  },
  [EXTERNAL_OPERATION.MEDIA_DOWNLOAD_POLICY]: {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    replay: 'forbidden',
    effectOnFailure: 'none',
    taskReplay: 'forbidden',
  },
  [EXTERNAL_OPERATION.PROVIDER_CANCEL]: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 2_000,
    replay: 'idempotent',
    effectOnFailure: 'unknown',
    taskReplay: 'safe',
  },
  [EXTERNAL_OPERATION.PROVIDER_POLL]: {
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 5_000,
    replay: 'idempotent',
    effectOnFailure: 'none',
    taskReplay: 'safe',
  },
  [EXTERNAL_OPERATION.PROVIDER_SUBMIT]: {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    replay: 'forbidden',
    effectOnFailure: 'unknown',
    taskReplay: 'forbidden',
  },
  [EXTERNAL_OPERATION.PROVIDER_SUBMIT_REPLAY_AUTHORIZED]: {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    replay: 'forbidden',
    effectOnFailure: 'none',
    taskReplay: 'safe',
  },
  [EXTERNAL_OPERATION.PROVIDER_TERMINAL_RESULT]: {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    replay: 'forbidden',
    effectOnFailure: 'committed',
    taskReplay: 'forbidden',
  },
  [EXTERNAL_OPERATION.STORAGE_DELETE]: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 2_000,
    replay: 'idempotent',
    effectOnFailure: 'unknown',
    taskReplay: 'safe',
  },
  [EXTERNAL_OPERATION.STORAGE_PUT_SAME_OBJECT]: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 2_000,
    replay: 'idempotent',
    effectOnFailure: 'unknown',
    taskReplay: 'safe',
  },
  [EXTERNAL_OPERATION.STORAGE_READ]: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 2_000,
    replay: 'idempotent',
    effectOnFailure: 'none',
    taskReplay: 'safe',
  },
  [EXTERNAL_OPERATION.STORAGE_SIGN]: {
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 1_000,
    replay: 'idempotent',
    effectOnFailure: 'none',
    taskReplay: 'safe',
  },
  [EXTERNAL_OPERATION.TEMPORAL_TASK_ACTIVITY]: {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    replay: 'forbidden',
    effectOnFailure: 'unknown',
    taskReplay: 'safe',
  },
} as const satisfies Record<ExternalOperationId, ExternalOperationContract>

export function getExternalOperationContract(
  operation: ExternalOperationId,
): ExternalOperationContract {
  return EXTERNAL_OPERATION_REGISTRY[operation]
}

export function isExternalOperationId(value: unknown): value is ExternalOperationId {
  return typeof value === 'string' && value in EXTERNAL_OPERATION_REGISTRY
}
