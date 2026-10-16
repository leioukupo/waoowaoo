import {
  parseWorkspaceResourceGenerationTaskPayload,
  type WorkspaceResourceGenerationTaskPayload,
} from '@/lib/workspace-resource/generation-contract'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import { resolveWorkspaceResourceInputMedia } from '@/lib/workspace-resource/input-media'
import { reportTaskProgress } from '../progress'
import type { TaskExecutionContext } from '../context'
import {
  requireTaskProviderRouteSelection,
  resolveVideoSourceFromGeneration,
  uploadVideoSourceToStorage,
} from '../provider-media'
import {
  isH3VideoModel,
  rewriteVideoPromptWithH3Skill,
} from '@/lib/video-generation/h3-prompt-skill'

function frozenVideoOptions(
  value: WorkspaceResourceGenerationTaskPayload['generationOptions'],
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string | number | boolean] => (
      typeof entry[1] === 'string'
      || typeof entry[1] === 'number'
      || typeof entry[1] === 'boolean'
    )),
  )
}

async function loadVideoImageReferences(
  context: TaskExecutionContext,
  input: WorkspaceResourceGenerationTaskPayload,
) {
  const inputByPosition = new Map(input.resource.inputs.map((reference) => [reference.position, reference]))
  const imageInputs = input.resource.imageInputPositions.map((position) => {
    const reference = inputByPosition.get(position)
    if (!reference) throw new Error(`WORKSPACE_RESOURCE_VIDEO_IMAGE_INPUT_POSITION_INVALID:${String(position)}`)
    return reference
  })
  if (imageInputs.length === 0) return []
  const resources = await resolveWorkspaceResourceInputMedia({
    userId: context.data.userId,
    projectId: context.data.projectId,
    references: imageInputs,
    expectedMediaType: 'image',
  })
  return resources.map((resource, index) => {
    const reference = resource.reference
    const role: 'first_frame' | 'last_frame' | 'reference_image' = reference.role === 'first_frame' || reference.role === 'last_frame'
      ? reference.role
      : 'reference_image'
    return {
      url: resource.storageKey,
      role,
      order: index + 1,
      source: 'generated' as const,
    }
  })
}

async function loadVideoReferences(
  context: TaskExecutionContext,
  input: WorkspaceResourceGenerationTaskPayload,
): Promise<string[]> {
  const inputByPosition = new Map(input.resource.inputs.map((reference) => [reference.position, reference]))
  const videoInputs = input.resource.videoInputPositions.map((position) => {
    const reference = inputByPosition.get(position)
    if (!reference) throw new Error(`WORKSPACE_RESOURCE_VIDEO_INPUT_POSITION_INVALID:${String(position)}`)
    return reference
  })
  if (videoInputs.length === 0) return []
  const resources = await resolveWorkspaceResourceInputMedia({
    userId: context.data.userId,
    projectId: context.data.projectId,
    references: videoInputs,
    expectedMediaType: 'video',
  })
  return resources.map((resource) => resource.storageKey)
}

export async function loadVideoAudioReferences(
  userId: string,
  projectId: string,
  input: WorkspaceResourceGenerationTaskPayload,
): Promise<string[]> {
  const inputByPosition = new Map(input.resource.inputs.map((reference) => [reference.position, reference]))
  const audioInputs = input.resource.audioInputPositions.map((position) => {
    const reference = inputByPosition.get(position)
    if (!reference) throw new Error(`WORKSPACE_RESOURCE_VIDEO_AUDIO_INPUT_POSITION_INVALID:${String(position)}`)
    return reference
  })
  if (audioInputs.length === 0) return []
  const resources = await resolveWorkspaceResourceInputMedia({
    userId,
    projectId,
    references: audioInputs,
    expectedMediaType: 'audio',
  })
  return resources.map((resource) => resource.storageKey)
}

export async function handleWorkspaceResourceVideoTask(
  context: TaskExecutionContext,
) {
  const { data } = context
  if (data.targetType !== 'WorkspaceResource') {
    throw new Error(`WORKSPACE_RESOURCE_TASK_TARGET_INVALID:${data.targetType}`)
  }
  const payload = parseWorkspaceResourceGenerationTaskPayload(data.payload ?? {})
  if (
    payload.resource.resourceId !== data.targetId
    || payload.resource.mediaType !== 'video'
    || payload.videoModel !== payload.resource.modelKey
  ) {
    throw new Error(`WORKSPACE_RESOURCE_VIDEO_TASK_CONTRACT_INVALID:${data.taskId}`)
  }
  const prompt = payload.resource.prompt
  if (prompt === null) throw new Error(`WORKSPACE_RESOURCE_VIDEO_PROMPT_REQUIRED:${data.taskId}`)
  await reportTaskProgress(context, 20, { stage: 'workspace_resource_prepare' })
  const referenceImages = await loadVideoImageReferences(context, payload)
  const referenceAudios = await loadVideoAudioReferences(data.userId, data.projectId, payload)
  const referenceVideos = await loadVideoReferences(context, payload)
  const options = payload.generationOptions
  const durationSeconds = payload.durationSeconds
  if (!durationSeconds) {
    throw new Error(`WORKSPACE_RESOURCE_VIDEO_DURATION_REQUIRED:${data.taskId}`)
  }
  // 提交前用 MiniMax H3 提示词 skill 重写提示词（仅 H3 视频模型；失败时回退原文）
  const skillModel = isH3VideoModel(payload.resource.modelKey)
  if (skillModel) {
    await reportTaskProgress(context, 30, { stage: 'workspace_resource_prompt_skill' })
  }
  const skillRewrite = await rewriteVideoPromptWithH3Skill({
    userId: data.userId,
    projectId: data.projectId,
    modelKey: payload.resource.modelKey,
    rawPrompt: prompt,
    durationSeconds,
    referenceImages,
    referenceAudios,
    referenceVideos,
  })
  const submissionPrompt = skillRewrite?.prompt ?? prompt
  await reportTaskProgress(context, 45, { stage: 'workspace_resource_generate' })
  const generated = await resolveVideoSourceFromGeneration(context, {
    userId: data.userId,
    modelId: payload.resource.modelKey,
    referenceImages,
    referenceAudios,
    referenceVideos,
    options: {
      ...frozenVideoOptions(options),
      prompt: submissionPrompt,
      duration: durationSeconds,
    },
  })
  const providerRoute = await requireTaskProviderRouteSelection(
    context,
    'media:video:primary',
  )
  await reportTaskProgress(context, 90, { stage: 'workspace_resource_persist' })
  const stored = await uploadVideoSourceToStorage(
    generated.url,
    'workspace-resource',
    payload.resource.resourceId,
    generated.downloadHeaders,
    { taskId: data.taskId, artifact: `workspace-resource:${payload.resource.resourceId}` },
  )
  const media = await ensureMediaObjectFromStorageKey(stored.storageKey, stored.metadata)
  return {
    mediaId: media.id,
    videoUrl: media.url,
    storageKey: media.storageKey,
    modelKey: providerRoute.modelKey,
    provider: providerRoute.provider,
    durationMs: media.durationMs,
    ...(typeof generated.actualVideoTokens === 'number'
      ? { actualVideoTokens: generated.actualVideoTokens }
      : {}),
  }
}
