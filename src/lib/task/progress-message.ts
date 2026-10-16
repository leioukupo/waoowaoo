import { TASK_EVENT_TYPE, TASK_TYPE } from './types'

const TASK_TYPE_LABELS: Record<string, string> = {
  [TASK_TYPE.WORKSPACE_RESOURCE_IMAGE]: 'progress.taskType.workspaceResourceImage',
  [TASK_TYPE.WORKSPACE_RESOURCE_AUDIO]: 'progress.taskType.workspaceResourceAudio',
  [TASK_TYPE.WORKSPACE_RESOURCE_VOICE]: 'progress.taskType.workspaceResourceVoice',
  [TASK_TYPE.WORKSPACE_RESOURCE_VIDEO]: 'progress.taskType.workspaceResourceVideo',
  [TASK_TYPE.WORKSPACE_RESOURCE_VIDEO_MERGE]: 'progress.taskType.workspaceResourceVideoMerge',
}

const STAGE_LABELS: Record<string, string> = {
  received: 'progress.stage.received',
  workspace_resource_prepare: 'progress.stage.workspaceResourcePrepare',
  workspace_resource_generate: 'progress.stage.workspaceResourceGenerate',
  workspace_resource_prompt_skill: 'progress.stage.workspaceResourcePromptSkill',
  workspace_resource_persist: 'progress.stage.workspaceResourcePersist',
  generate_voice_submit: 'progress.stage.generateVoiceSubmit',
  persist_voice: 'progress.stage.persistVoice',
  polling_external: 'progress.stage.pollingExternal',
  retrying: 'progress.stage.retrying',
  enqueue_failed: 'progress.stage.enqueueFailed',
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function getTaskTypeLabel(taskType?: string | null) {
  if (!taskType) return 'progress.taskType.generic'
  return TASK_TYPE_LABELS[taskType] || 'progress.taskType.generic'
}

export function getTaskStageLabel(stage?: string | null) {
  if (!stage) return null
  return STAGE_LABELS[stage] || stage
}

export function buildTaskProgressMessage(params: {
  eventType?: string | null
  taskType?: string | null
  progress?: number | null
  payload?: Record<string, unknown> | null
}) {
  const payloadMessage = asString(params.payload?.message)
  if (payloadMessage) return payloadMessage

  const stage = asString(params.payload?.stage)
  const stageLabel = getTaskStageLabel(stage)

  if (params.eventType === TASK_EVENT_TYPE.CREATED) {
    return 'progress.runtime.taskCreated'
  }
  if (params.eventType === TASK_EVENT_TYPE.PROCESSING) {
    return stageLabel || 'progress.runtime.taskStarted'
  }
  if (params.eventType === TASK_EVENT_TYPE.COMPLETED) {
    return 'progress.runtime.taskCompleted'
  }
  if (params.eventType === TASK_EVENT_TYPE.FAILED) {
    return 'progress.runtime.taskFailed'
  }

  return stageLabel || 'progress.runtime.taskProcessing'
}
