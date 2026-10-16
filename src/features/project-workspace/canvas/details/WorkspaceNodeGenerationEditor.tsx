'use client'

import { GenerationReferenceLimits } from '../controls/GenerationReferenceLimits'
import { GenerationFormIssues } from '../controls/GenerationFormIssues'
import { canvasUsesAdaptiveFrame } from '../create/canvas-generation-form'

import { useTranslations } from 'next-intl'
import { AppIcon } from '@/components/ui/icons'
import { useToast } from '@/contexts/ToastContext'
import type {
  WorkspaceResourceRegenerationReference,
  WorkspaceResourceRegenerationTemplate,
} from '@/lib/workspace-resource/regeneration'
import { copyPlainText } from '@/lib/clipboard'
import { workspaceCanvasScrollableRegionProps } from '../canvas-scroll-lock'
import { AspectRatioPicker } from '../controls/AspectRatioPicker'
import { GenerationParameterFields } from '../controls/GenerationParameterFields'
import { resolveCanvasAspectRatioChoices, type CanvasGenerationCapability } from '../create/canvas-draft'
import { SELECTABLE_TEXT_CLASS } from '../nodes/renderers/renderer-shared'
import type { useWorkspaceNodeGenerationEdits } from './useWorkspaceNodeGenerationEdits'

type GenerationEditor = ReturnType<typeof useWorkspaceNodeGenerationEdits>

const PROMPT_MAX_LENGTH = 100_000

function ModelNameLine({ label, modelName }: { readonly label: string; readonly modelName: string }) {
  return (
    <p
      className={`${SELECTABLE_TEXT_CLASS} min-w-0 truncate text-right text-[10px] leading-4 text-[var(--glass-text-tertiary)]`}
      title={modelName}
    >
      <span className="mr-1.5 font-semibold uppercase tracking-wide">{label}</span>
      <span>{modelName}</span>
    </p>
  )
}

function CopyPromptButton({ prompt }: { readonly prompt: string }) {
  const actionLabels = useTranslations('projectWorkflow.canvas.workspace.actions')
  const { showError, showToast } = useToast()
  const copyPrompt = async () => {
    const ok = await copyPlainText(prompt)
    if (ok) {
      showToast(actionLabels('copyPromptSuccess'), 'success')
    } else {
      showError(new Error('CLIPBOARD_COPY_FAILED'), actionLabels('copyPromptFailed'))
    }
  }
  return (
    <button
      type="button"
      aria-label={actionLabels('copyPrompt')}
      title={actionLabels('copyPrompt')}
      className="nodrag shrink-0 rounded-md p-1 text-[var(--glass-text-tertiary)] transition hover:bg-white hover:text-[var(--glass-text-secondary)]"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        void copyPrompt()
      }}
    >
      <AppIcon name="copy" className="h-3.5 w-3.5" />
    </button>
  )
}

/** Section header shared by the read-only and editable prompt views. */
function PromptHeader({
  title,
  modelName,
  prompt,
}: {
  readonly title: string
  readonly modelName: string | null
  readonly prompt: string
}) {
  const labels = useTranslations('projectWorkflow.canvas.workspace.nodeFields')
  return (
    <div className="flex items-baseline justify-between gap-3">
      <p className={`${SELECTABLE_TEXT_CLASS} shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--glass-text-tertiary)]`}>
        {title}
      </p>
      <span className="flex min-w-0 items-center gap-2">
        {modelName ? <ModelNameLine label={labels('generationModel')} modelName={modelName} /> : null}
        {prompt ? <CopyPromptButton prompt={prompt} /> : null}
      </span>
    </div>
  )
}

/**
 * Read-only prompt provenance for cards the server cannot re-run (uploads,
 * audio, pending generations).
 */
export function WorkspaceNodePromptReadout({
  prompt,
  modelName,
}: {
  readonly prompt: string
  readonly modelName: string | null
}) {
  const labels = useTranslations('projectWorkflow.canvas.workspace.nodeFields')
  return (
    <section className="rounded-[16px] bg-slate-50 p-3 ring-1 ring-slate-100">
      <PromptHeader title={labels('generationPrompt')} modelName={modelName} prompt={prompt} />
      <div
        {...workspaceCanvasScrollableRegionProps<HTMLDivElement>()}
        className="nowheel mt-2 max-h-44 overflow-y-auto"
      >
        <p className={`${SELECTABLE_TEXT_CLASS} whitespace-pre-wrap break-words text-xs leading-5 text-slate-700`}>
          {prompt}
        </p>
      </div>
    </section>
  )
}

/**
 * The editable generation input of a selected card: the frozen prompt, frame
 * and duration become a draft that "run again" submits as a new Resource.
 * Every field maps one-to-one onto the server-projected template; the editor
 * never invents inputs the Operation schema does not own.
 */
export function WorkspaceNodeGenerationEditor({
  template,
  editor,
  capability,
  modelName,
  disabled,
  dropHighlighted,
  addedReferences,
}: {
  readonly template: WorkspaceResourceRegenerationTemplate
  readonly editor: GenerationEditor
  /** Configured model capability for this card's kind; null means no model is configured. */
  readonly capability: CanvasGenerationCapability | null
  readonly modelName: string | null
  readonly disabled: boolean
  readonly dropHighlighted: boolean
  /** References attached in this edit that are not lineage inputs of the card. */
  readonly addedReferences: readonly WorkspaceResourceRegenerationReference[]
}) {
  const t = useTranslations('projectWorkflow.canvas.workspace.details.editor')
  const labels = useTranslations('projectWorkflow.canvas.workspace.nodeFields')
  const formLabels = useTranslations('projectWorkflow.canvas.workspace.create')
  const adaptiveFrame = canvasUsesAdaptiveFrame(capability, editor.references)
  const roleLabels = useTranslations('projectWorkflow.canvas.workspace.create.referenceRole')
  const ratioChoices = resolveCanvasAspectRatioChoices(capability, editor.aspectRatio).choices
  const durationChoices = capability?.mediaType === 'video' ? capability.view.durationsSeconds : []
  return (
    <section className={`rounded-[16px] bg-slate-50 p-3 ring-1 transition-shadow ${dropHighlighted ? 'ring-2 ring-slate-500' : 'ring-slate-100'}`}>
      <PromptHeader title={labels('generationPrompt')} modelName={capability?.view.modelName ?? modelName} prompt={editor.edits.prompt} />
      <label className="mt-2 block text-xs text-slate-700">
        {t('newName')}
        <input
          type="text"
          value={editor.name}
          disabled={disabled}
          placeholder={t('newNameHint')}
          className="nodrag mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 outline-none focus:border-slate-400"
          onMouseDown={(event) => event.stopPropagation()}
          onChange={(event) => editor.setName(event.target.value)}
        />
      </label>
      {editor.edits.name === template.name ? (
        <p className="mt-1 text-xs text-[var(--glass-tone-danger-fg)]">{t('differentNameRequired')}</p>
      ) : null}
      <textarea
        {...workspaceCanvasScrollableRegionProps<HTMLTextAreaElement>()}
        value={editor.prompt}
        disabled={disabled}
        maxLength={PROMPT_MAX_LENGTH}
        rows={4}
        placeholder={t('promptPlaceholder')}
        aria-label={labels('generationPrompt')}
        className="nodrag nowheel mt-2 max-h-56 min-h-[5.5rem] w-full resize-y rounded-[12px] border border-transparent bg-white/80 px-2.5 py-2 text-xs leading-5 text-slate-700 outline-none transition placeholder:text-[var(--glass-text-tertiary)] focus:border-slate-300 focus:bg-white disabled:opacity-60"
        onMouseDown={(event) => event.stopPropagation()}
        onChange={(event) => editor.setPrompt(event.target.value)}
      />
      {!capability ? (
        <p className="mt-2 rounded-[12px] bg-[var(--glass-tone-danger-bg)] px-3 py-2 text-[11px] leading-4 text-[var(--glass-tone-danger-fg)]">
          {t('modelMissing')}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        {!template.aspectRatioLocked && !adaptiveFrame && ratioChoices.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className={`${SELECTABLE_TEXT_CLASS} text-[11px] font-medium text-[var(--glass-text-secondary)]`}>
              {t('aspectRatio')}
            </span>
            <AspectRatioPicker
              choices={ratioChoices}
              value={editor.aspectRatio}
              disabled={disabled}
              label={t('aspectRatio')}
              onChange={editor.setAspectRatio}
            />
          </div>
        ) : null}
        {template.mediaType === 'video' && durationChoices.length > 0 ? (
          <label className="flex items-center gap-2 text-[11px] font-medium text-[var(--glass-text-secondary)]">
            <span className={SELECTABLE_TEXT_CLASS}>{t('duration')}</span>
            <select
              disabled={disabled}
              value={editor.durationSeconds !== null && durationChoices.includes(editor.durationSeconds) ? editor.durationSeconds : ''}
              className="nodrag h-8 rounded-[9px] border border-transparent bg-white/80 px-2 text-xs tabular-nums text-slate-700 outline-none transition focus:border-slate-300 focus:bg-white disabled:opacity-60"
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10)
                editor.setDurationSeconds(Number.isInteger(next) && next > 0 ? next : null)
              }}
            >
              <option value="" disabled>{formLabels('parameterRequired')}</option>
              {durationChoices.map((seconds) => (
                <option key={seconds} value={seconds}>{seconds}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {adaptiveFrame ? <p className="mt-2 text-xs text-slate-500">{formLabels('adaptiveFrame')}</p> : null}
      <GenerationFormIssues issues={editor.issues} onReviewConfiguration={editor.reviewConfiguration} />
      {capability && capability.view.parameters.length > 0 ? (
        <details className="mt-2" open={editor.issues.includes('PARAMETERS_REQUIRED') || undefined}>
          <summary className="nodrag cursor-pointer text-xs text-slate-600">{formLabels('advanced')}</summary>
          <GenerationParameterFields
            parameters={capability.view.parameters}
            values={editor.parameters}
            disabled={disabled}
            onChange={editor.setParameter}
          />
        </details>
      ) : null}
      <GenerationReferenceLimits capability={capability} />
      {addedReferences.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {addedReferences.map((reference) => (
            <li
              key={`${reference.resourceId}:${String(reference.contentVersion)}:${reference.role}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-[11px] text-[var(--glass-text-secondary)] ring-1 ring-slate-200"
            >
              <AppIcon name="link" className="h-3 w-3" />
              <span>{roleLabels(reference.role)}</span>
              <button
                type="button"
                disabled={disabled}
                aria-label={t('removeAddedReference')}
                title={t('removeAddedReference')}
                className="nodrag inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-slate-100"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  editor.removeReference(reference)
                }}
              >
                <AppIcon name="close" className="h-2.5 w-2.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className={`${SELECTABLE_TEXT_CLASS} mt-2 text-[11px] leading-4 ${dropHighlighted ? 'text-[var(--glass-text-secondary)]' : 'text-[var(--glass-text-tertiary)]'}`}>
        {dropHighlighted ? t('dropActive') : t('hint')}
      </p>
    </section>
  )
}
