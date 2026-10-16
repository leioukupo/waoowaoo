import { sha256Hex } from '@/lib/sha256-browser'
const COMMAND_RECEIPT_STORAGE_PREFIX = 'workspace-assistant-command-receipt-v1'

interface StoredWorkspaceAssistantCommandReceipt {
  fingerprint: string
  messageId: string
}

const inMemoryReceipts = new Map<string, readonly StoredWorkspaceAssistantCommandReceipt[]>()

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  )
}

async function sha256(value: string): Promise<string> {
  // crypto.subtle is unavailable in non-secure contexts (plain-HTTP
  // deployments); the pure-JS fallback produces identical digests.
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined
  const digest =
    subtle && typeof subtle.digest === 'function'
      ? new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(value)))
      : sha256Hex(value)
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function storageKey(scopeKey: string): string {
  return `${COMMAND_RECEIPT_STORAGE_PREFIX}:${scopeKey}`
}

function parseStoredReceipts(
  value: string | null,
): readonly StoredWorkspaceAssistantCommandReceipt[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap<StoredWorkspaceAssistantCommandReceipt>((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const record = entry as Record<string, unknown>
      if (
        typeof record.fingerprint !== 'string' ||
        !record.fingerprint ||
        typeof record.messageId !== 'string' ||
        !record.messageId
      ) {
        return []
      }
      return [
        {
          fingerprint: record.fingerprint,
          messageId: record.messageId,
        },
      ]
    })
  } catch {
    return []
  }
}

function readStoredReceipts(key: string): readonly StoredWorkspaceAssistantCommandReceipt[] {
  try {
    const stored = parseStoredReceipts(sessionStorage.getItem(key))
    if (stored.length > 0) return stored
  } catch {}
  return inMemoryReceipts.get(key) ?? []
}

function writeStoredReceipts(
  key: string,
  receipts: readonly StoredWorkspaceAssistantCommandReceipt[],
): void {
  inMemoryReceipts.set(key, receipts)
  try {
    sessionStorage.setItem(key, JSON.stringify(receipts))
  } catch {}
}

function removeStoredReceipt(key: string): void {
  inMemoryReceipts.delete(key)
  try {
    sessionStorage.removeItem(key)
  } catch {}
}

export async function resolveWorkspaceAssistantUserMessageId(params: {
  scopeKey: string
  sourceKey?: string
  immutableInput: unknown
}): Promise<string> {
  const sourceKey = params.sourceKey?.trim() ?? ''
  if (sourceKey) {
    return `agent-dispatch:${await sha256(
      `workspace-assistant-dispatch-v1:${params.scopeKey}:${sourceKey}`,
    )}`
  }

  const fingerprint = await sha256(JSON.stringify(canonicalize(params.immutableInput)))
  const key = storageKey(params.scopeKey)
  const stored = readStoredReceipts(key)
  const existing = stored.find((receipt) => receipt.fingerprint === fingerprint)
  if (existing) return existing.messageId

  const messageId = crypto.randomUUID()
  writeStoredReceipts(key, [...stored, { fingerprint, messageId }])
  return messageId
}

export function clearWorkspaceAssistantUserMessageReceipt(params: {
  scopeKey: string
  messageId: string
}): void {
  const key = storageKey(params.scopeKey)
  const stored = readStoredReceipts(key)
  const remaining = stored.filter((receipt) => receipt.messageId !== params.messageId)
  if (remaining.length === stored.length) return
  if (remaining.length === 0) {
    removeStoredReceipt(key)
  } else {
    writeStoredReceipts(key, remaining)
  }
}
