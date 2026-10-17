import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { storeWorkspaceResourceContent, workspaceResourceContentPreview } from './content-store'
import type {
  WorkspaceResourceInputRef,
  WorkspaceResourceJsonValue,
  WorkspaceResourceMediaType,
} from './contracts'
import { createWorkspaceResourceId } from './identity'
import {
  buildGeneratedWorkspaceResourcePath,
  buildSavedWorkspaceDocumentPath,
  contentKindFromPath,
  isWorkspaceSubtreePath,
  parentWorkspacePath,
  replaceWorkspacePathPrefix,
  requireOutputPathForMediaType,
  resourceNameFromPath,
  validateWorkspaceResourceFilePath,
  validateWorkspaceResourceFolderPath,
  validateWorkspaceResourcePath,
  validateWorkspaceResourcePathForKind,
  workspacePathAncestors,
  WorkspaceResourcePlacementError,
} from './path'
import {
  WORKSPACE_RESOURCE_FOLDER_SCHEMA_ID,
  requireWorkspaceResourceSchema,
} from './schema-registry'
import { advanceWorkspaceResourceRevisionInTransaction } from './projection-revision'

export type WorkspaceResourceMaterializationContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'structured'; readonly data: WorkspaceResourceJsonValue }
  | { readonly kind: 'media'; readonly mediaId: string }

export type WorkspaceResourceClient = Pick<
  Prisma.TransactionClient,
  'project' | 'workspaceResource' | 'workspaceResourceVersion' | 'workspaceResourceLineage' | 'mediaObject'
> | typeof prisma

type ResourceProvenance = {
  readonly operationId: string | null
  readonly inputHash: string | null
  readonly taskId: string | null
  readonly operationExecutionId: string | null
  readonly toolCallId: string | null
  readonly prompt: string | null
  readonly modelKey: string | null
  readonly generationOptions: WorkspaceResourceJsonValue | null
}

function jsonValue(value: WorkspaceResourceJsonValue | null): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull {
  return value === null ? Prisma.JsonNull : value as Prisma.InputJsonValue
}

async function requireOwnedProject(
  client: WorkspaceResourceClient,
  projectId: string,
  userId: string,
): Promise<void> {
  const project = await client.project.findFirst({ where: { id: projectId, userId }, select: { id: true } })
  if (!project) throw new Error('WORKSPACE_RESOURCE_PROJECT_NOT_OWNED')
}

async function lockOwnedProject(
  tx: Prisma.TransactionClient,
  projectId: string,
  userId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM projects WHERE id = ${projectId} AND userId = ${userId} FOR UPDATE
  `)
  if (rows.length !== 1) throw new Error('WORKSPACE_RESOURCE_PROJECT_NOT_OWNED')
}

export async function resolveActiveWorkspaceResourceByPath(
  client: WorkspaceResourceClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly workspacePath: string
  },
): Promise<{
  readonly resourceId: string
  readonly workspacePath: string
}> {
  await requireOwnedProject(client, input.projectId, input.userId)
  const workspacePath = validateWorkspaceResourcePath(input.workspacePath)
  const resource = await client.workspaceResource.findFirst({
    where: {
      projectId: input.projectId,
      userId: input.userId,
      activePath: workspacePath,
      deletedAt: null,
    },
    select: { id: true, workspacePath: true },
  })
  if (!resource) {
    throw new Error(`WORKSPACE_RESOURCE_NOT_FOUND:${workspacePath}`)
  }
  return {
    resourceId: resource.id,
    workspacePath: resource.workspacePath,
  }
}

async function requireParentFolder(
  tx: Prisma.TransactionClient,
  input: { readonly projectId: string; readonly userId: string; readonly workspacePath: string },
): Promise<void> {
  const parentPath = parentWorkspacePath(input.workspacePath)
  if (!parentPath) return
  const parent = await tx.workspaceResource.findFirst({
    where: {
      projectId: input.projectId,
      userId: input.userId,
      activePath: parentPath,
      resourceKind: 'folder',
      deletedAt: null,
    },
    select: { id: true },
  })
  if (!parent) {
    throw new WorkspaceResourcePlacementError(
      'WORKSPACE_RESOURCE_FOLDER_NOT_FOUND',
      parentPath,
    )
  }
}

async function requirePathAvailable(
  tx: Prisma.TransactionClient,
  projectId: string,
  workspacePath: string,
  excludedIds: readonly string[] = [],
): Promise<void> {
  const occupied = await tx.workspaceResource.findFirst({
    where: {
      projectId,
      activePath: workspacePath,
      ...(excludedIds.length > 0 ? { id: { notIn: [...excludedIds] } } : {}),
    },
    select: { id: true },
  })
  if (occupied) {
    throw new WorkspaceResourcePlacementError('WORKSPACE_RESOURCE_PATH_CONFLICT', workspacePath)
  }
}

export type ReserveWorkspaceResourceInput = {
  readonly resourceId?: string
  readonly userId: string
  readonly projectId: string
  readonly outputPath: string
  readonly mediaType: WorkspaceResourceMediaType
  readonly schemaId: string
  readonly sourceType?: string | null
  readonly sourceId?: string | null
  readonly memberIndex?: number | null
  readonly operationExecutionId?: string | null
  readonly alternativeGroupExecutionId?: string | null
  readonly toolCallId?: string | null
  readonly prompt?: string | null
  readonly modelKey?: string | null
  readonly generationOptions?: WorkspaceResourceJsonValue | null
  readonly operationId?: string | null
  readonly inputHash?: string | null
  readonly taskId?: string | null
}

async function validateWorkspaceResourceFolderPlacement(
  client: WorkspaceResourceClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly folderPath?: string | null
  },
): Promise<string | null> {
  if (!input.folderPath) return null
  const folderPath = validateWorkspaceResourceFolderPath(input.folderPath)
  const paths = [...workspacePathAncestors(folderPath), folderPath]
  const occupied = await client.workspaceResource.findMany({
    where: {
      projectId: input.projectId,
      userId: input.userId,
      activePath: { in: paths },
      deletedAt: null,
    },
    select: { activePath: true, resourceKind: true },
  })
  const conflict = occupied.find((resource) => resource.resourceKind !== 'folder')
  if (conflict) {
    throw new WorkspaceResourcePlacementError(
      'WORKSPACE_RESOURCE_TREE_PATH_CONFLICT',
      conflict.activePath ?? folderPath,
    )
  }
  return folderPath
}

export async function resolveGeneratedWorkspaceResourcePlacement(
  client: WorkspaceResourceClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly folderPath?: string | null
    readonly name: string
    readonly resourceId: string
    readonly mediaType: Exclude<WorkspaceResourceMediaType, 'text'>
    readonly schemaId: string
    readonly alternativeIndex?: number | null
  },
): Promise<string> {
  await requireOwnedProject(client, input.projectId, input.userId)
  const schema = requireWorkspaceResourceSchema(input.schemaId)
  if (schema.resourceKind !== 'file' || schema.mediaType !== input.mediaType) {
    throw new Error(`WORKSPACE_RESOURCE_SCHEMA_MEDIA_MISMATCH:${input.schemaId}:${input.mediaType}`)
  }
  const folderPath = await validateWorkspaceResourceFolderPlacement(client, input)
  const workspacePath = buildGeneratedWorkspaceResourcePath({
    parentPath: folderPath,
    name: input.name,
    mediaType: input.mediaType,
    alternativeIndex: input.alternativeIndex,
  })
  const occupied = await client.workspaceResource.findFirst({
    where: { projectId: input.projectId, activePath: workspacePath },
    select: { id: true },
  })
  if (occupied && occupied.id !== input.resourceId) {
    throw new WorkspaceResourcePlacementError('WORKSPACE_RESOURCE_PATH_CONFLICT', workspacePath)
  }
  return workspacePath
}

export async function resolveSavedWorkspaceDocumentPlacement(
  client: WorkspaceResourceClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly folderPath?: string | null
    readonly name: string
    readonly resourceId: string
    readonly contentKind: 'text' | 'structured'
    readonly schemaId: string
  },
): Promise<string> {
  await requireOwnedProject(client, input.projectId, input.userId)
  const schema = requireWorkspaceResourceSchema(input.schemaId)
  if (schema.resourceKind !== 'file' || schema.mediaType !== 'text') {
    throw new Error(`WORKSPACE_RESOURCE_SCHEMA_MEDIA_MISMATCH:${input.schemaId}:text`)
  }
  const folderPath = await validateWorkspaceResourceFolderPlacement(client, input)
  const workspacePath = buildSavedWorkspaceDocumentPath({
    parentPath: folderPath,
    name: input.name,
    contentKind: input.contentKind,
  })
  const occupied = await client.workspaceResource.findFirst({
    where: { projectId: input.projectId, activePath: workspacePath },
    select: { id: true },
  })
  if (occupied && occupied.id !== input.resourceId) {
    throw new WorkspaceResourcePlacementError('WORKSPACE_RESOURCE_PATH_CONFLICT', workspacePath)
  }
  return workspacePath
}

export async function reserveWorkspaceResourceInTransaction(
  tx: Prisma.TransactionClient,
  input: ReserveWorkspaceResourceInput,
): Promise<{ readonly resourceId: string; readonly workspacePath: string }> {
  await lockOwnedProject(tx, input.projectId, input.userId)
  const workspacePath = requireOutputPathForMediaType(input.outputPath, input.mediaType)
  const schema = requireWorkspaceResourceSchema(input.schemaId)
  if (schema.resourceKind !== 'file' || schema.mediaType !== input.mediaType) {
    throw new Error(`WORKSPACE_RESOURCE_SCHEMA_MEDIA_MISMATCH:${input.schemaId}:${input.mediaType}`)
  }
  await requireParentFolder(tx, { projectId: input.projectId, userId: input.userId, workspacePath })
  if (input.prompt !== undefined && input.prompt !== null && !input.prompt.trim()) {
    throw new Error('WORKSPACE_RESOURCE_PROMPT_EMPTY')
  }
  const resourceId = input.resourceId?.trim() || createWorkspaceResourceId()
  const existing = await tx.workspaceResource.findUnique({ where: { id: resourceId } })
  if (existing) {
    if (
      existing.userId !== input.userId
      || existing.projectId !== input.projectId
      || existing.workspacePath !== workspacePath
      || existing.resourceKind !== 'file'
      || existing.mediaType !== input.mediaType
      || existing.schemaId !== input.schemaId
    ) {
      throw new Error(`WORKSPACE_RESOURCE_RESERVATION_CONFLICT:${resourceId}`)
    }
    return { resourceId, workspacePath }
  }
  await requirePathAvailable(tx, input.projectId, workspacePath)
  await tx.workspaceResource.create({
    data: {
      id: resourceId,
      userId: input.userId,
      projectId: input.projectId,
      workspacePath,
      activePath: workspacePath,
      resourceKind: 'file',
      mediaType: input.mediaType,
      schemaId: input.schemaId.trim(),
      name: resourceNameFromPath(workspacePath),
      status: 'pending',
      currentVersion: 0,
      sourceType: input.sourceType?.trim() || null,
      sourceId: input.sourceId?.trim() || null,
      memberIndex: input.memberIndex ?? null,
      prompt: input.prompt ?? null,
      modelKey: input.modelKey?.trim() || null,
      generationOptions: jsonValue(input.generationOptions ?? null),
      operationId: input.operationId?.trim() || null,
      inputHash: input.inputHash?.trim() || null,
      taskId: input.taskId?.trim() || null,
      operationExecutionId: input.operationExecutionId?.trim() || null,
      alternativeGroupExecutionId: input.alternativeGroupExecutionId?.trim() || null,
      toolCallId: input.toolCallId?.trim() || null,
    },
  })
  await advanceWorkspaceResourceRevisionInTransaction(tx, input)
  return { resourceId, workspacePath }
}

/**
 * Replace the frozen model key of a user's generated resources with the
 * currently selected slot model. Personal settings are the single model fact
 * for existing scenes: saving them re-points every stored generation at the
 * model now selected for that slot. Returns the changed projects (their
 * canvas revision is advanced so open editors refetch).
 */
export async function backfillWorkspaceResourceModelKeysInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly userId: string
    readonly mediaType: WorkspaceResourceMediaType
    readonly schemaId?: string
    readonly modelKey: string
  },
): Promise<{ readonly projectId: string; readonly count: number }[]> {
  const where: Prisma.WorkspaceResourceWhereInput = {
    userId: input.userId,
    resourceKind: 'file',
    mediaType: input.mediaType,
    ...(input.schemaId ? { schemaId: input.schemaId } : {}),
    deletedAt: null,
    AND: [
      { modelKey: { not: null } },
      { modelKey: { not: input.modelKey } },
    ],
  }
  const affectedProjects = await tx.workspaceResource.findMany({
    where,
    select: { projectId: true },
    distinct: ['projectId'],
  })
  const changed: { readonly projectId: string; readonly count: number }[] = []
  for (const row of affectedProjects) {
    const updated = await tx.workspaceResource.updateMany({
      where: { ...where, projectId: row.projectId },
      data: { modelKey: input.modelKey },
    })
    if (updated.count === 0) continue
    changed.push({ projectId: row.projectId, count: updated.count })
    await advanceWorkspaceResourceRevisionInTransaction(tx, {
      projectId: row.projectId,
      userId: input.userId,
    })
  }
  return changed
}

export async function retryWorkspaceResourcesInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly resources: readonly {
      readonly resourceId: string
      readonly operationId: string
      readonly operationExecutionId: string | null
      readonly inputHash: string
      readonly prompt: string | null
      readonly modelKey: string
      readonly generationOptions: WorkspaceResourceJsonValue
      readonly toolCallId: string | null
    }[]
  },
): Promise<void> {
  if (input.resources.length === 0) throw new Error('WORKSPACE_RESOURCE_RETRY_TARGETS_REQUIRED')
  await lockOwnedProject(tx, input.projectId, input.userId)
  for (const resource of input.resources) {
    const updated = await tx.workspaceResource.updateMany({
      where: {
        id: resource.resourceId,
        userId: input.userId,
        projectId: input.projectId,
        status: { in: ['failed', 'canceled'] },
        deletedAt: null,
      },
      data: {
        status: 'pending',
        operationId: resource.operationId,
        operationExecutionId: resource.operationExecutionId,
        inputHash: resource.inputHash,
        prompt: resource.prompt,
        modelKey: resource.modelKey,
        generationOptions: jsonValue(resource.generationOptions),
        toolCallId: resource.toolCallId,
      },
    })
    if (updated.count !== 1) {
      throw new Error(`WORKSPACE_RESOURCE_RETRY_TARGET_CHANGED:${resource.resourceId}`)
    }
  }
  await advanceWorkspaceResourceRevisionInTransaction(tx, input)
}

export async function bindWorkspaceResourceTasksInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly bindings: readonly {
      readonly resourceId: string
      readonly taskId: string
    }[]
  },
): Promise<void> {
  if (input.bindings.length === 0) throw new Error('WORKSPACE_RESOURCE_TASK_BINDINGS_REQUIRED')
  await lockOwnedProject(tx, input.projectId, input.userId)
  for (const binding of input.bindings) {
    const updated = await tx.workspaceResource.updateMany({
      where: {
        id: binding.resourceId,
        userId: input.userId,
        projectId: input.projectId,
        status: 'pending',
        deletedAt: null,
      },
      data: { taskId: binding.taskId },
    })
    if (updated.count !== 1) {
      throw new Error(`WORKSPACE_RESOURCE_TASK_BINDING_CONFLICT:${binding.resourceId}`)
    }
  }
  await advanceWorkspaceResourceRevisionInTransaction(tx, input)
}

export async function createWorkspaceResourceFolderInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly workspacePath: string
    readonly sourceType?: string | null
    readonly sourceId?: string | null
  },
): Promise<{ readonly resourceId: string; readonly workspacePath: string; readonly createdCount: number }> {
  await lockOwnedProject(tx, input.projectId, input.userId)
  const workspacePath = validateWorkspaceResourceFolderPath(input.workspacePath)
  const paths = [...workspacePathAncestors(workspacePath), workspacePath]
  const existing = await tx.workspaceResource.findMany({
    where: {
      projectId: input.projectId,
      userId: input.userId,
      activePath: { in: paths },
      deletedAt: null,
    },
    select: { id: true, activePath: true, resourceKind: true },
  })
  const existingByPath = new Map(existing.map((resource) => [resource.activePath, resource]))
  let leafId: string | null = null
  let createdCount = 0
  for (const pathToCreate of paths) {
    const occupied = existingByPath.get(pathToCreate)
    if (occupied) {
      if (occupied.resourceKind !== 'folder') {
        throw new WorkspaceResourcePlacementError('WORKSPACE_RESOURCE_TREE_PATH_CONFLICT', pathToCreate)
      }
      if (pathToCreate === workspacePath) leafId = occupied.id
      continue
    }
    const resourceId = createWorkspaceResourceId()
    await tx.workspaceResource.create({
      data: {
        id: resourceId,
        userId: input.userId,
        projectId: input.projectId,
        workspacePath: pathToCreate,
        activePath: pathToCreate,
        resourceKind: 'folder',
        mediaType: null,
        schemaId: WORKSPACE_RESOURCE_FOLDER_SCHEMA_ID,
        name: resourceNameFromPath(pathToCreate, 'folder'),
        status: 'ready',
        currentVersion: 0,
        sourceType: input.sourceType?.trim() || null,
        sourceId: input.sourceId?.trim() || null,
        materializedAt: new Date(),
      },
    })
    createdCount += 1
    if (pathToCreate === workspacePath) leafId = resourceId
  }
  if (!leafId) throw new Error('WORKSPACE_RESOURCE_FOLDER_CREATE_RESULT_MISSING')
  if (createdCount > 0) {
    await advanceWorkspaceResourceRevisionInTransaction(tx, input)
  }
  return { resourceId: leafId, workspacePath, createdCount }
}

export async function resolveWorkspaceResourceInputs(
  client: WorkspaceResourceClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly references: readonly {
      readonly workspacePath?: string
      readonly resourceId: string
      readonly contentVersion: number
      readonly role: string
      readonly position: number
    }[]
  },
): Promise<readonly WorkspaceResourceInputRef[]> {
  const resourceIds = input.references.map((reference) => reference.resourceId)
  const resources = resourceIds.length === 0 ? [] : await client.workspaceResource.findMany({
    where: {
      id: { in: resourceIds },
      projectId: input.projectId,
      userId: input.userId,
      activePath: { not: null },
      resourceKind: 'file',
      deletedAt: null,
    },
    select: { id: true, workspacePath: true, currentVersion: true, status: true },
  })
  const byId = new Map(resources.map((resource) => [resource.id, resource]))
  const seenPositions = new Set<string>()
  const resolved: WorkspaceResourceInputRef[] = []
  for (const reference of input.references) {
    const resource = byId.get(reference.resourceId)
    if (!resource) {
      throw new Error(`WORKSPACE_RESOURCE_INPUT_NOT_FOUND:${reference.resourceId}`)
    }
    const workspacePath = validateWorkspaceResourceFilePath(resource.workspacePath)
    if (
      reference.workspacePath !== undefined
      && validateWorkspaceResourceFilePath(reference.workspacePath) !== workspacePath
    ) {
      throw new Error(`WORKSPACE_RESOURCE_INPUT_PATH_STALE:${reference.resourceId}`)
    }
    const contentVersion = reference.contentVersion
    if (resource.status !== 'ready' || !Number.isSafeInteger(contentVersion) || contentVersion < 1) {
      throw new Error(`WORKSPACE_RESOURCE_INPUT_NOT_READY:${reference.resourceId}`)
    }
    const version = await client.workspaceResourceVersion.findUnique({
      where: { resourceId_version: { resourceId: resource.id, version: contentVersion } },
      select: { id: true },
    })
    if (!version) throw new Error(`WORKSPACE_RESOURCE_INPUT_VERSION_NOT_FOUND:${resource.id}:${String(contentVersion)}`)
    const role = reference.role.trim()
    const positionKey = `${role}:${String(reference.position)}`
    if (!role || !Number.isSafeInteger(reference.position) || reference.position < 0 || seenPositions.has(positionKey)) {
      throw new Error('WORKSPACE_RESOURCE_INPUT_REFERENCE_INVALID')
    }
    seenPositions.add(positionKey)
    resolved.push({ resourceId: resource.id, contentVersion, workspacePath, role, position: reference.position })
  }
  return resolved
}

export async function validateWorkspaceResourceInputReferencesInTransaction(
  tx: Prisma.TransactionClient,
  input: { readonly userId: string; readonly projectId: string },
  references: readonly WorkspaceResourceInputRef[],
): Promise<void> {
  const seen = new Set<string>()
  for (const reference of references) {
    const key = `${reference.role}:${String(reference.position)}`
    if (seen.has(key)) throw new Error('WORKSPACE_RESOURCE_INPUT_REFERENCE_DUPLICATE')
    seen.add(key)
    const version = await tx.workspaceResourceVersion.findFirst({
      where: {
        resourceId: reference.resourceId,
        version: reference.contentVersion,
        resource: {
          userId: input.userId,
          projectId: input.projectId,
          resourceKind: 'file',
        },
      },
      select: { id: true },
    })
    if (!version) {
      throw new Error(`WORKSPACE_RESOURCE_INPUT_VERSION_NOT_FOUND:${reference.resourceId}:${String(reference.contentVersion)}`)
    }
  }
}

function contentKind(content: WorkspaceResourceMaterializationContent): 'text' | 'structured' | 'media' {
  return content.kind
}

export async function materializeWorkspaceResourceInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly resourceId: string
    readonly userId: string
    readonly projectId: string
    readonly mediaType: WorkspaceResourceMediaType
    readonly schemaId: string
    readonly content: WorkspaceResourceMaterializationContent
    readonly inputs: readonly WorkspaceResourceInputRef[]
    readonly sourceTurnId?: string | null
    readonly provenance: ResourceProvenance
  },
): Promise<{ readonly resourceId: string; readonly contentVersion: number }> {
  await lockOwnedProject(tx, input.projectId, input.userId)
  const resource = await tx.workspaceResource.findUnique({ where: { id: input.resourceId } })
  if (
    !resource
    || resource.userId !== input.userId
    || resource.projectId !== input.projectId
    || resource.deletedAt
    || resource.resourceKind !== 'file'
  ) {
    throw new Error(`WORKSPACE_RESOURCE_NOT_OWNED:${input.resourceId}`)
  }
  if (resource.mediaType !== input.mediaType || resource.schemaId !== input.schemaId) {
    throw new Error(`WORKSPACE_RESOURCE_MATERIALIZATION_CONTRACT_MISMATCH:${resource.id}`)
  }
  if (resource.status === 'ready' && resource.currentVersion > 0) {
    if (resource.taskId === input.provenance.taskId && input.provenance.taskId) {
      return { resourceId: resource.id, contentVersion: resource.currentVersion }
    }
    throw new Error(`WORKSPACE_RESOURCE_ALREADY_MATERIALIZED:${resource.id}`)
  }
  await validateWorkspaceResourceInputReferencesInTransaction(tx, {
    userId: input.userId,
    projectId: resource.projectId,
  }, input.inputs)
  const nextContentVersion = resource.currentVersion + 1
  let mediaId: string
  let sha256: string | null
  let sizeBytes: bigint | null
  let versionContentPreview: string | null = null
  if (input.content.kind === 'media') {
    const media = await tx.mediaObject.findUnique({ where: { id: input.content.mediaId } })
    if (!media) throw new Error(`WORKSPACE_RESOURCE_MEDIA_NOT_FOUND:${input.content.mediaId}`)
    mediaId = media.id
    sha256 = media.sha256
    sizeBytes = media.sizeBytes
  } else {
    if (input.mediaType !== 'text') throw new Error('WORKSPACE_RESOURCE_TEXT_MEDIA_TYPE_REQUIRED')
    const expectedKind = contentKindFromPath(resource.workspacePath)
    if (expectedKind !== input.content.kind) {
      throw new Error(`WORKSPACE_RESOURCE_CONTENT_PATH_MISMATCH:${resource.workspacePath}`)
    }
    const serialized = input.content.kind === 'text'
      ? input.content.text
      : `${JSON.stringify(input.content.data, null, 2)}\n`
    const media = await storeWorkspaceResourceContent({
      projectId: resource.projectId,
      resourceId: resource.id,
      version: nextContentVersion,
      workspacePath: resource.workspacePath,
      content: serialized,
    })
    mediaId = media.id
    sha256 = media.sha256 ?? null
    sizeBytes = media.sizeBytes === null || media.sizeBytes === undefined ? null : BigInt(media.sizeBytes)
    versionContentPreview = workspaceResourceContentPreview(serialized)
  }
  await tx.workspaceResourceVersion.create({
    data: {
      id: randomUUID(),
      resourceId: resource.id,
      version: nextContentVersion,
      contentKind: contentKind(input.content),
      mediaId,
      sha256,
      sizeBytes,
      contentPreview: versionContentPreview,
      sourceTurnId: input.sourceTurnId?.trim() || null,
    },
  })
  if (input.inputs.length > 0) {
    await tx.workspaceResourceLineage.createMany({
      data: input.inputs.map((reference) => ({
        id: randomUUID(),
        outputResourceId: resource.id,
        outputVersion: nextContentVersion,
        inputResourceId: reference.resourceId,
        inputVersion: reference.contentVersion,
        role: reference.role,
        position: reference.position,
      })),
    })
  }
  const updated = await tx.workspaceResource.updateMany({
    where: {
      id: resource.id,
      currentVersion: resource.currentVersion,
      status: { in: ['pending', 'failed', 'canceled'] },
      deletedAt: null,
    },
    data: {
      currentVersion: nextContentVersion,
      status: 'ready',
      materializedAt: new Date(),
      prompt: input.provenance.prompt,
      modelKey: input.provenance.modelKey,
      generationOptions: jsonValue(input.provenance.generationOptions),
      operationId: input.provenance.operationId,
      inputHash: input.provenance.inputHash,
      taskId: input.provenance.taskId,
      operationExecutionId: input.provenance.operationExecutionId,
      toolCallId: input.provenance.toolCallId,
    },
  })
  if (updated.count !== 1) throw new Error(`WORKSPACE_RESOURCE_MATERIALIZATION_CONFLICT:${resource.id}`)
  await advanceWorkspaceResourceRevisionInTransaction(tx, {
    projectId: resource.projectId,
    userId: input.userId,
  })
  return { resourceId: resource.id, contentVersion: nextContentVersion }
}

export async function materializeWorkspaceResourceMediaInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly resourceId: string
    readonly userId: string
    readonly projectId: string
    readonly mediaId: string
    readonly inputs: readonly WorkspaceResourceInputRef[]
    readonly sourceTurnId?: string | null
    readonly provenance: ResourceProvenance
  },
): Promise<{ readonly resourceId: string; readonly contentVersion: number }> {
  await lockOwnedProject(tx, input.projectId, input.userId)
  const resource = await tx.workspaceResource.findUnique({ where: { id: input.resourceId } })
  if (resource?.projectId !== input.projectId || !resource.mediaType) {
    throw new Error(`WORKSPACE_RESOURCE_NOT_OWNED:${input.resourceId}`)
  }
  return await materializeWorkspaceResourceInTransaction(tx, {
    ...input,
    mediaType: resource.mediaType as WorkspaceResourceMediaType,
    schemaId: resource.schemaId,
    content: { kind: 'media', mediaId: input.mediaId },
  })
}

export async function appendWorkspaceResourceUserContent(input: {
  readonly userId: string
  readonly projectId: string
  readonly resourceId: string
  readonly expectedContentVersion: number
  readonly content: Extract<WorkspaceResourceMaterializationContent, { kind: 'text' | 'structured' }>
  readonly sourceTurnId?: string | null
}): Promise<{ readonly resourceId: string; readonly contentVersion: number }> {
  return await prisma.$transaction(async (tx) => await appendWorkspaceResourceUserContentInTransaction(tx, input))
}

export async function appendWorkspaceResourceUserContentInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly resourceId: string
    readonly expectedContentVersion: number
    readonly content: Extract<WorkspaceResourceMaterializationContent, { kind: 'text' | 'structured' }>
    readonly sourceTurnId?: string | null
  },
): Promise<{ readonly resourceId: string; readonly contentVersion: number }> {
  await lockOwnedProject(tx, input.projectId, input.userId)
    const resource = await tx.workspaceResource.findFirst({
      where: { id: input.resourceId, projectId: input.projectId, userId: input.userId, deletedAt: null },
    })
    if (!resource || resource.resourceKind !== 'file' || resource.mediaType !== 'text') {
      throw new Error('WORKSPACE_RESOURCE_TEXT_NOT_FOUND')
    }
    if (resource.currentVersion !== input.expectedContentVersion) {
      throw new Error(`WORKSPACE_RESOURCE_CONTENT_VERSION_CONFLICT:${String(resource.currentVersion)}`)
    }
    const expectedKind = contentKindFromPath(resource.workspacePath)
    if (expectedKind !== input.content.kind) throw new Error('WORKSPACE_RESOURCE_CONTENT_PATH_MISMATCH')
    const nextVersion = resource.currentVersion + 1
    const serialized = input.content.kind === 'text'
      ? input.content.text
      : `${JSON.stringify(input.content.data, null, 2)}\n`
    const media = await storeWorkspaceResourceContent({
      projectId: resource.projectId,
      resourceId: resource.id,
      version: nextVersion,
      workspacePath: resource.workspacePath,
      content: serialized,
    })
    await tx.workspaceResourceVersion.create({
      data: {
        id: randomUUID(),
        resourceId: resource.id,
        version: nextVersion,
        contentKind: input.content.kind,
        mediaId: media.id,
        sha256: media.sha256,
        sizeBytes: media.sizeBytes === null || media.sizeBytes === undefined ? null : BigInt(media.sizeBytes),
        contentPreview: workspaceResourceContentPreview(serialized),
        sourceTurnId: input.sourceTurnId?.trim() || null,
      },
    })
    const updated = await tx.workspaceResource.updateMany({
      where: { id: resource.id, currentVersion: input.expectedContentVersion, deletedAt: null },
      data: { currentVersion: nextVersion, status: 'ready', materializedAt: new Date() },
    })
    if (updated.count !== 1) throw new Error('WORKSPACE_RESOURCE_CONTENT_VERSION_CONFLICT')
    await advanceWorkspaceResourceRevisionInTransaction(tx, input)
  return { resourceId: resource.id, contentVersion: nextVersion }
}

export async function createWorkspaceResourceUserFileInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly outputPath: string
    readonly schemaId: string
    readonly content: Extract<WorkspaceResourceMaterializationContent, { kind: 'text' | 'structured' }>
    readonly sourceTurnId?: string | null
    readonly sourceType?: string | null
    readonly sourceId?: string | null
  },
): Promise<{ readonly resourceId: string; readonly workspacePath: string; readonly contentVersion: number }> {
  const reserved = await reserveWorkspaceResourceInTransaction(tx, {
    userId: input.userId,
    projectId: input.projectId,
    outputPath: input.outputPath,
    mediaType: 'text',
    schemaId: input.schemaId,
    sourceType: input.sourceType ?? 'agent_file',
    sourceId: input.sourceId ?? null,
  })
  const materialized = await materializeWorkspaceResourceInTransaction(tx, {
    resourceId: reserved.resourceId,
    userId: input.userId,
    projectId: input.projectId,
    mediaType: 'text',
    schemaId: input.schemaId,
    content: input.content,
    inputs: [],
    sourceTurnId: input.sourceTurnId,
    provenance: {
      operationId: null,
      inputHash: null,
      taskId: null,
      operationExecutionId: null,
      toolCallId: null,
      prompt: null,
      modelKey: null,
      generationOptions: null,
    },
  })
  return { ...reserved, contentVersion: materialized.contentVersion }
}

export async function settleWorkspaceResourceFailureInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly resourceId: string
    readonly userId: string
    readonly projectId: string
    readonly status: 'failed' | 'canceled'
  },
): Promise<void> {
  await lockOwnedProject(tx, input.projectId, input.userId)
  const resource = await tx.workspaceResource.findUnique({ where: { id: input.resourceId } })
  if (
    !resource
    || resource.userId !== input.userId
    || resource.projectId !== input.projectId
    || resource.resourceKind !== 'file'
  ) {
    throw new Error('WORKSPACE_RESOURCE_NOT_OWNED')
  }
  if (resource.status === 'ready' || resource.status === input.status) return
  await tx.workspaceResource.update({
    where: { id: resource.id },
    data: {
      status: input.status,
    },
  })
  await advanceWorkspaceResourceRevisionInTransaction(tx, {
    projectId: resource.projectId,
    userId: input.userId,
  })
}

async function requireNoActiveResourceTasks(
  tx: Prisma.TransactionClient,
  resourceIds: readonly string[],
): Promise<void> {
  if (resourceIds.length === 0) return
  const activeTask = await tx.task.findFirst({
    where: {
      targetType: 'WorkspaceResource',
      targetId: { in: [...resourceIds] },
      status: { in: ['queued', 'processing'] },
    },
    select: { id: true },
  })
  if (activeTask) throw new Error(`WORKSPACE_RESOURCE_ACTIVE_TASK_CONFLICT:${activeTask.id}`)
}

export async function moveWorkspaceResourceInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly sourcePath: string
    readonly destinationPath: string
  },
): Promise<{ readonly resourceId: string; readonly workspacePath: string; readonly movedCount: number }> {
  await lockOwnedProject(tx, input.projectId, input.userId)
  const sourcePath = validateWorkspaceResourcePath(input.sourcePath)
  const root = await tx.workspaceResource.findFirst({
    where: {
      activePath: sourcePath,
      projectId: input.projectId,
      userId: input.userId,
      deletedAt: null,
    },
  })
  if (!root) throw new Error('WORKSPACE_RESOURCE_NOT_FOUND')
  const destinationPath = root.resourceKind === 'folder'
    ? validateWorkspaceResourceFolderPath(input.destinationPath)
    : requireOutputPathForMediaType(input.destinationPath, root.mediaType as WorkspaceResourceMediaType)
  if (root.resourceKind === 'folder' && isWorkspaceSubtreePath(destinationPath, root.workspacePath)) {
    throw new Error('WORKSPACE_RESOURCE_MOVE_INTO_SELF')
  }
  await requireParentFolder(tx, { projectId: input.projectId, userId: input.userId, workspacePath: destinationPath })
  const subtree = await tx.workspaceResource.findMany({
    where: {
      projectId: input.projectId,
      userId: input.userId,
      deletedAt: null,
      OR: [{ workspacePath: root.workspacePath }, { workspacePath: { startsWith: `${root.workspacePath}/` } }],
    },
    orderBy: { workspacePath: 'asc' },
  })
  const ids = subtree.map((resource) => resource.id)
  await requireNoActiveResourceTasks(tx, ids)
  const destinations = subtree.map((resource) => ({
    resource,
    path: replaceWorkspacePathPrefix(resource.workspacePath, root.workspacePath, destinationPath),
  }))
  for (const destination of destinations) {
    await requirePathAvailable(tx, input.projectId, destination.path, ids)
  }
  await tx.workspaceResource.updateMany({ where: { id: { in: ids } }, data: { activePath: null } })
  for (const destination of destinations) {
    const kind = destination.resource.resourceKind === 'folder' ? 'folder' : 'file'
    await tx.workspaceResource.update({
      where: { id: destination.resource.id },
      data: {
        workspacePath: destination.path,
        activePath: destination.path,
        name: resourceNameFromPath(destination.path, kind),
      },
    })
  }
  await advanceWorkspaceResourceRevisionInTransaction(tx, input)
  return { resourceId: root.id, workspacePath: destinationPath, movedCount: subtree.length }
}

export async function softDeleteWorkspaceResourceInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly resourceId: string
    readonly workspacePath: string
  },
): Promise<number> {
  await lockOwnedProject(tx, input.projectId, input.userId)
  const root = await tx.workspaceResource.findFirst({
    where: {
      id: input.resourceId,
      userId: input.userId,
      projectId: input.projectId,
      deletedAt: null,
      activePath: { not: null },
    },
  })
  if (!root) throw new Error('WORKSPACE_RESOURCE_NOT_FOUND')
  const approvedPath = validateWorkspaceResourcePathForKind(
    input.workspacePath,
    root.resourceKind === 'folder' ? 'folder' : 'file',
  )
  if (root.workspacePath !== approvedPath) {
    throw new Error(`WORKSPACE_RESOURCE_DELETE_PATH_CHANGED:${input.resourceId}`)
  }
  const workspacePath = validateWorkspaceResourcePathForKind(
    root.workspacePath,
    root.resourceKind === 'folder' ? 'folder' : 'file',
  )
  const resources = await tx.workspaceResource.findMany({
    where: {
      userId: input.userId,
      projectId: input.projectId,
      deletedAt: null,
      OR: [{ workspacePath }, { workspacePath: { startsWith: `${workspacePath}/` } }],
    },
    select: { id: true, status: true },
  })
  if (root.resourceKind === 'file' && resources.length !== 1) throw new Error('WORKSPACE_RESOURCE_FILE_HAS_DESCENDANTS')
  const ids = resources.map((resource) => resource.id)
  await requireNoActiveResourceTasks(tx, ids)
  if (resources.some((resource) => resource.status === 'pending')) {
    throw new Error('WORKSPACE_RESOURCE_PENDING_DELETE_CONFLICT')
  }
  const deletedAt = new Date()
  const result = await tx.workspaceResource.updateMany({
    where: { id: { in: ids }, deletedAt: null },
    data: { activePath: null, deletedAt },
  })
  if (result.count !== resources.length) throw new Error('WORKSPACE_RESOURCE_DELETE_CONFLICT')
  await advanceWorkspaceResourceRevisionInTransaction(tx, input)
  return result.count
}

export async function restoreWorkspaceResourceInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly userId: string
    readonly projectId: string
    readonly resourceId: string
    readonly workspacePath?: string | null
  },
): Promise<{ readonly resourceId: string; readonly workspacePath: string; readonly restoredCount: number }> {
  await lockOwnedProject(tx, input.projectId, input.userId)
    const root = await tx.workspaceResource.findFirst({
      where: { id: input.resourceId, projectId: input.projectId, userId: input.userId },
    })
    if (!root || !root.deletedAt) throw new Error('WORKSPACE_RESOURCE_DELETED_NOT_FOUND')
    const destinationPath = input.workspacePath
      ? (root.resourceKind === 'folder'
          ? validateWorkspaceResourceFolderPath(input.workspacePath)
          : requireOutputPathForMediaType(input.workspacePath, root.mediaType as WorkspaceResourceMediaType))
      : root.workspacePath
    await requireParentFolder(tx, { projectId: input.projectId, userId: input.userId, workspacePath: destinationPath })
    const cohort = await tx.workspaceResource.findMany({
      where: {
        userId: input.userId,
        projectId: input.projectId,
        deletedAt: root.deletedAt,
        OR: [{ workspacePath: root.workspacePath }, { workspacePath: { startsWith: `${root.workspacePath}/` } }],
      },
      orderBy: { workspacePath: 'asc' },
    })
    const ids = cohort.map((resource) => resource.id)
    const destinations = cohort.map((resource) => ({
      resource,
      path: replaceWorkspacePathPrefix(resource.workspacePath, root.workspacePath, destinationPath),
    }))
    for (const destination of destinations) {
      await requirePathAvailable(tx, input.projectId, destination.path, ids)
    }
    for (const destination of destinations) {
      const kind = destination.resource.resourceKind === 'folder' ? 'folder' : 'file'
      await tx.workspaceResource.update({
        where: { id: destination.resource.id },
        data: {
          workspacePath: destination.path,
          activePath: destination.path,
          name: resourceNameFromPath(destination.path, kind),
          deletedAt: null,
        },
      })
    }
    await advanceWorkspaceResourceRevisionInTransaction(tx, input)
  return { resourceId: root.id, workspacePath: destinationPath, restoredCount: cohort.length }
}
