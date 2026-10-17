import type { Prisma } from '@prisma/client'
import {
  MEDIA_MODEL_TYPES,
  resolveSingleModelSelection,
  type MediaModelType,
} from '@/lib/ai-registry/media-model-selection'
import { WORKSPACE_RESOURCE_SCHEMA } from '@/lib/workspace-resource/schema-registry'
import { filterEffectiveModels } from './effective-config'
import type { StoredModel, StoredProvider } from './api-config-types'

/**
 * 个人设置保存后的场景模型回填。
 *
 * 产品规则：媒体模型槽位（图像/视频/音乐/声音）以用户个人设置为唯一事实来源。
 * 保存配置时，把该用户已有生成资源（场景）上冻结的 modelKey 统一替换为当前
 * 槽位选中的模型，历史场景不再保留过期的模型选择。
 */
export type MediaModelBackfillTargets = Partial<Record<MediaModelType, string>>

/**
 * 从新保存的模型列表与渠道列表计算每个媒体槽位当前选中的 modelKey。
 * 只保留“有效”模型（渠道存在且配置了密钥）；槽位未配置或无法唯一解析时
 * 不产生回填目标，避免把场景指向一个运行期不可用的模型。
 */
export function computeMediaModelBackfillTargets(
  models: readonly StoredModel[],
  providers: readonly StoredProvider[],
): MediaModelBackfillTargets {
  const effective = filterEffectiveModels(models, providers)
  const targets: MediaModelBackfillTargets = {}
  for (const type of MEDIA_MODEL_TYPES) {
    const selection = resolveSingleModelSelection(effective, type)
    if (selection.status === 'selected') {
      targets[type] = selection.model.modelKey
    }
  }
  return targets
}

export function hasMediaModelBackfillTargets(targets: MediaModelBackfillTargets): boolean {
  return MEDIA_MODEL_TYPES.some((type) => typeof targets[type] === 'string')
}

type WorkspaceResourceDbClient = Pick<Prisma.TransactionClient, 'workspaceResource'>

/**
 * 把用户已有场景的 modelKey 批量替换为当前槽位模型。
 * 只动“生成类”资源：图片/视频按 mediaType 命中；音乐/声音是同一
 * mediaType='audio'，按 schemaId 区分（bgm_audio=音乐，voice_reference=声音）。
 * 上传、文本、文件夹等没有生成模型语义的行不受影响。
 */
export async function backfillWorkspaceResourceModels(
  userId: string,
  targets: MediaModelBackfillTargets,
  client: WorkspaceResourceDbClient,
): Promise<Record<MediaModelType, number>> {
  const counts: Record<MediaModelType, number> = { image: 0, video: 0, music: 0, voice: 0 }
  for (const type of MEDIA_MODEL_TYPES) {
    const modelKey = targets[type]
    if (!modelKey) continue
    const where: Prisma.WorkspaceResourceWhereInput = {
      userId,
      resourceKind: 'file',
      deletedAt: null,
      AND: [
        { modelKey: { not: null } },
        { modelKey: { not: modelKey } },
      ],
    }
    if (type === 'music') {
      where.mediaType = 'audio'
      where.schemaId = WORKSPACE_RESOURCE_SCHEMA.BGM_AUDIO
    } else if (type === 'voice') {
      where.mediaType = 'audio'
      where.schemaId = WORKSPACE_RESOURCE_SCHEMA.VOICE_REFERENCE
    } else {
      where.mediaType = type
    }
    const result = await client.workspaceResource.updateMany({ where, data: { modelKey } })
    counts[type] = result.count
  }
  return counts
}
