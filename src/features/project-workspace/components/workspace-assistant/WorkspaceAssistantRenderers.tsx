'use client'

import React from 'react'
import { MessagePrimitive, useMessage } from '@assistant-ui/react'
import type { ComponentProps } from 'react'
import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { AppIcon } from '@/components/ui/icons'
import BillingActionButton from '@/components/billing/BillingActionButton'
import {
  buildBillingActionQuotePreviewFromQuote,
  type BillingActionQuotePreview,
} from '@/lib/billing/action-quote-preview'
import type { OperationPlanView } from '@/lib/operations/plan-contract'
import { MarkdownTextPart } from './MarkdownTextPart'
import { readProjectAssistantTextAttachmentsFromMetadata } from '@/lib/project-agent/text-attachments'
import { copyPlainText } from '@/lib/clipboard'
import { readProjectAssistantMediaAttachmentsFromMetadata } from '@/lib/project-agent/media-attachments'
import { WorkspaceAssistantThinkingStatus, WorkspaceAssistantWorkTrace } from './WorkspaceAssistantWorkTrace'
import type { WorkspaceAssistantWorkTraceView } from './workspace-assistant-message-projection'
import { summarizeBillingActionItems, type BillingActionItemSummary } from './billing-action-items'
import {
  resolveWebSearchSources,
  type WebSearchSource,
} from './WorkspaceAssistantToolCall'
import { WebSourceFavicon } from './WebSourceFavicon'
import {
  AssistantRuntimeGoalDataCard,
  AssistantRuntimeSkillsDataCard,
} from './WorkspaceAssistantNotices'
import { isWorkspaceAssistantHiddenThreadMessageMetadata } from './workspace-assistant-panel-state'
import './workspace-assistant-beautiful.css'

type StandardMessagePartComponents = NonNullable<
  ComponentProps<typeof MessagePrimitive.Parts>['components']
>
type WorkspaceAssistantMessagePartComponents = {
  readonly assistant: StandardMessagePartComponents
  readonly standard: StandardMessagePartComponents
}
type AssistantAgentTranslator = ReturnType<typeof useTranslations<'assistantAgent'>>

export const WORKSPACE_ASSISTANT_USER_MESSAGE_CLASS =
  'wa-assistant-message max-w-full w-fit break-words rounded-xl bg-[var(--bui-field)] px-3 py-2.5 text-[var(--bui-ink)] shadow-[var(--bui-shadow-hairline)] [overflow-wrap:anywhere]'
const WORKSPACE_ASSISTANT_MESSAGE_CLASS =
  'wa-assistant-message flex w-full min-w-0 max-w-full flex-col items-start gap-2.5 text-[var(--glass-text-primary)]'
export function resolveProgressStageLabel(
  raw: string | null,
  progressT: ReturnType<typeof useTranslations<'progress'>>,
): string | null {
  if (!raw) return null
  if (!raw.startsWith('progress.')) return raw
  const key = raw.slice('progress.'.length)
  if (progressT.has(key)) return progressT(key)
  return `MISSING_MESSAGE:${raw}`
}

function translateBillingActionItemSummary(
  item: BillingActionItemSummary,
  t: AssistantAgentTranslator,
): string {
  switch (item.key) {
    case 'image':
      return t('cards.billingActionImageItems', { count: item.quantity })
    case 'video':
      return t('cards.billingActionVideoItems', { count: item.quantity })
    case 'music':
      return t('cards.billingActionMusicItems', { count: item.quantity })
    case 'voiceCharacters':
      return t('cards.billingActionVoiceCharacterItems', { count: item.quantity })
    case 'musicSeconds':
      return t('cards.billingActionMusicSecondItems', { count: item.quantity })
    case 'videoSeconds':
      return t('cards.billingActionVideoSecondItems', { count: item.quantity })
  }
}

function buildBillingActionSummaryLabel(
  quote: OperationPlanView['quote'],
  t: AssistantAgentTranslator,
): string | null {
  const items = summarizeBillingActionItems(quote.items)
  if (items.length === 0) return null
  const separator = t('cards.billingActionListSeparator')
  const label = items.map((item) => translateBillingActionItemSummary(item, t)).join(separator)
  return t('cards.billingActionSummary', { items: label })
}

function buildAssistantBillingQuotePreview(params: {
  readonly quote: OperationPlanView['quote']
  readonly actionLabel: string | null
  readonly t: AssistantAgentTranslator
}): BillingActionQuotePreview | null {
  const { quote, actionLabel, t } = params
  return buildBillingActionQuotePreviewFromQuote({
    quote,
    withCredits: (values) =>
      actionLabel
        ? t('cards.billingActionQuoteWithCredits', { action: actionLabel, cost: values.cost })
        : t('cards.billingQuoteWithCredits', values),
    withoutCredits: (values) =>
      actionLabel
        ? t('cards.billingActionQuoteWithoutCredits', { action: actionLabel })
        : t('cards.billingQuoteWithoutCredits', values),
  })
}

function BillingQuoteBlock(props: { preview: BillingActionQuotePreview | null }) {
  const preview = props.preview
  if (!preview) return null
  return (
    <div className="mt-4 flex items-center gap-3 text-xs">
      <span className="shrink-0 whitespace-nowrap tabular-nums text-[var(--glass-text-tertiary)]">
        {preview.fullLabel}
      </span>
      <span className="h-px flex-1 bg-slate-200" />
    </div>
  )
}

type ConfirmationActionDecision = 'idle' | 'confirming' | 'cancelling' | 'settled'

export function ConfirmationActionCard(props: {
  members: readonly {
    operationId: string
    title: string
    operationPlan: OperationPlanView | null
    details?: readonly string[]
  }[]
  subtitle: string
  onConfirm: () => Promise<void>
  onCancel: () => Promise<void>
  retryOnly?: boolean
}) {
  const t = useTranslations('assistantAgent')
  // A pending approval accepts exactly one decision: the first click disables
  // both actions, and any submission failure is consumed here (the panel-level
  // control error shows the localized notice) instead of escaping to React.
  const [decision, setDecision] = React.useState<ConfirmationActionDecision>('idle')
  const members = props.members.map((member) => {
    const quote = member.operationPlan?.quote ?? null
    const quoteActionLabel = quote ? buildBillingActionSummaryLabel(quote, t) : null
    return {
      ...member,
      quotePreview: quote
        ? buildAssistantBillingQuotePreview({
            quote,
            actionLabel: quoteActionLabel,
            t,
          })
        : null,
    }
  })
  const submitDecision = (kind: 'confirm' | 'cancel'): void => {
    setDecision((current) => {
      if (current !== 'idle') return current
      void (async () => {
        try {
          await (kind === 'confirm' ? props.onConfirm() : props.onCancel())
          setDecision('settled')
        } catch {
          // The control layer already surfaced the failure; allow a retry.
          setDecision('idle')
        }
      })()
      return kind === 'confirm' ? 'confirming' : 'cancelling'
    })
  }
  const locked = decision !== 'idle'
  return (
    <div className="rounded-2xl border border-[var(--glass-stroke-base)] bg-white p-3 text-xs text-[var(--glass-text-secondary)]">
      <div className="mt-1 leading-5">{props.subtitle}</div>
      <div className="mt-2 space-y-2">
        {members.map((member) => (
          <div key={`${member.operationId}:${member.operationPlan?.planSnapshotId ?? ''}`}>
            <div className="text-sm font-semibold text-[var(--glass-text-primary)]">
              {member.title}
            </div>
            {member.details?.map((detail, index) => (
              <div
                key={`${String(index)}:${detail}`}
                className="mt-1 break-all rounded-lg bg-neutral-100 px-2 py-1 font-mono text-[11px] leading-4 text-[var(--glass-text-tertiary)]"
              >
                {detail}
              </div>
            ))}
            <BillingQuoteBlock preview={member.quotePreview} />
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <BillingActionButton
          type="button"
          icon="arrowRight"
          label={decision === 'confirming' || props.retryOnly
            ? t('cards.interactionSubmitting')
            : t('cards.confirmContinue')}
          quote={members.length === 1 ? (members[0]?.quotePreview ?? null) : null}
          className="flex-1 rounded-xl py-2 text-sm"
          disabled={locked || props.retryOnly}
          onClick={() => {
            submitDecision('confirm')
          }}
        />
        {!props.retryOnly ? <button
          type="button"
          disabled={locked}
          className="shrink-0 whitespace-nowrap rounded-xl border border-[var(--glass-stroke-base)] bg-white px-3 py-2 text-sm font-medium text-[var(--glass-text-primary)] transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
            submitDecision('cancel')
          }}
        >
          {decision === 'cancelling' ? t('cards.interactionSubmitting') : t('cards.cancelAction')}
        </button> : null}
      </div>
    </div>
  )
}

export function useWorkspaceAssistantMessagePartComponents(): WorkspaceAssistantMessagePartComponents {
  return useMemo<WorkspaceAssistantMessagePartComponents>(() => {
    const data = {
      by_name: {
        'assistant-work-trace': WorkspaceAssistantWorkTrace,
        'assistant-runtime-goal': AssistantRuntimeGoalDataCard,
        'assistant-runtime-skills': AssistantRuntimeSkillsDataCard,
      },
    }
    return {
      assistant: {
        Text: MarkdownTextPart,
        data,
      },
      standard: {
        Text: MarkdownTextPart,
        data,
      },
    }
  }, [])
}

function HiddenWorkspaceAssistantInternalMessage(props: { children: React.ReactNode }) {
  const shouldHide = useMessage((state) =>
    isWorkspaceAssistantHiddenThreadMessageMetadata(state.metadata),
  )
  if (shouldHide) return null
  return <>{props.children}</>
}

/** Beautiful UI chat grammar: attachments in the sent bubble are quiet mono chips. */
function WorkspaceAssistantBubbleAttachmentChip(props: { readonly name: string }) {
  return (
    <span
      title={props.name}
      className="mr-1 mt-2 inline-flex h-7 max-w-full items-center truncate rounded-[6px] bg-[var(--bui-surface)] px-2 font-mono text-[11.5px] text-[var(--bui-ink-2)] shadow-[var(--bui-shadow-btn)]"
    >
      <span className="truncate">{props.name}</span>
    </span>
  )
}

function WorkspaceAssistantUserTextAttachments() {
  const metadata = useMessage((state) => state.metadata)
  const attachments = readProjectAssistantTextAttachmentsFromMetadata(metadata)
  const mediaAttachments = readProjectAssistantMediaAttachmentsFromMetadata(metadata)
  if (attachments.length === 0 && mediaAttachments.length === 0) return null
  return (
    <div className="flex max-w-full flex-wrap items-center">
      {attachments.map((attachment) => (
        <WorkspaceAssistantBubbleAttachmentChip key={attachment.id} name={attachment.fileName} />
      ))}
      {mediaAttachments.map((attachment) => (
        attachment.mediaType === 'image' && attachment.href ? (
          <span
            key={attachment.resourceId}
            className="mr-1 mt-2 inline-block h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-[var(--bui-inset)] shadow-[var(--bui-shadow-hairline)]"
            title={attachment.name}
          >
            {/* Protected same-origin media route; the session cookie authorizes the read. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={attachment.href}
              alt={attachment.name}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </span>
        ) : (
          <WorkspaceAssistantBubbleAttachmentChip
            key={attachment.resourceId}
            name={attachment.name}
          />
        )
      ))}
    </div>
  )
}

/**
 * "Undelivered" tag under the user bubble whose failed run rolled it back
 * from the model history. Pure projection (AR-07): the id is derived by the
 * panel from the persisted session run plus message order (see
 * resolveWorkspaceAssistantUndeliveredUserMessage in
 * workspace-assistant-panel-state.ts); this component stores no client-side
 * send state of its own.
 */
function WorkspaceAssistantUserUndeliveredMarker(props: {
  undeliveredUserMessageId: string | null
}) {
  const t = useTranslations('assistantAgent')
  const isUndelivered = useMessage(
    (state) =>
      props.undeliveredUserMessageId !== null && state.id === props.undeliveredUserMessageId,
  )
  if (!isUndelivered) return null
  return (
    <div className="mt-1 flex items-center gap-1 text-[11px] leading-4 text-[var(--glass-tone-warning-fg)]">
      <AppIcon name="alert" className="h-3 w-3 shrink-0" />
      <span>{t('panel.undelivered')}</span>
    </div>
  )
}

/**
 * Beautiful UI StreamingText footer: a quiet copy action plus the message's
 * aggregated search sources (avatar stack + count, expanding to a source
 * list). Pure projection over the settled message content — no new state
 * source; it renders only after the message stops running.
 */
function WorkspaceAssistantAssistantMessageFooter() {
  const t = useTranslations('assistantAgent')
  const [copied, setCopied] = React.useState(false)
  const [sourcesOpen, setSourcesOpen] = React.useState(false)
  const running = useMessage((state) => state.status?.type === 'running')
  const content = useMessage((state) => state.content)
  const text = content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n\n')
    .trim()
  const sources = React.useMemo(() => {
    const byUrl = new Map<string, WebSearchSource>()
    for (const part of content) {
      if (part.type !== 'data' || part.name !== 'assistant-work-trace') continue
      const trace = part.data as WorkspaceAssistantWorkTraceView
      for (const entry of trace.entries) {
        if (entry.kind !== 'tool' || entry.toolName !== 'web_search') continue
        for (const source of resolveWebSearchSources(entry.result)) {
          if (!byUrl.has(source.url)) byUrl.set(source.url, source)
        }
      }
    }
    return [...byUrl.values()]
  }, [content])
  if (running || !text) return null

  const copyAnswer = (): void => {
    void copyPlainText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="-mt-2">
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label={copied ? t('panel.copiedAnswer') : t('panel.copyAnswer')}
          title={copied ? t('panel.copiedAnswer') : t('panel.copyAnswer')}
          onClick={copyAnswer}
          className={`flex size-6 items-center justify-center rounded-[6px] transition-colors duration-100 hover:bg-[var(--bui-hover-2)] ${copied ? 'text-[var(--bui-green)]' : 'text-[var(--bui-ink-3)] hover:text-[var(--bui-ink)]'}`}
        >
          {/* eslint-disable no-restricted-syntax -- Beautiful UI's copied action glyphs, preserved exactly. */}
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
          {/* eslint-enable no-restricted-syntax */}
        </button>
        {sources.length > 0 ? (
          <button
            type="button"
            aria-expanded={sourcesOpen}
            onClick={() => setSourcesOpen((current) => !current)}
            className="ml-1.5 flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left transition-colors duration-150 hover:bg-[var(--bui-hover)]"
          >
            <span className="flex -space-x-1">
              {sources.slice(0, 3).map((source) => (
                <span
                  key={source.url}
                  className="flex size-3.5 items-center justify-center rounded-full bg-[var(--bui-surface)] shadow-[0_0_0_1.5px_var(--bui-surface)]"
                >
                  <WebSourceFavicon domain={source.domain} className="h-2.5 w-2.5 rounded-full" />
                </span>
              ))}
            </span>
            <span className="text-[13px] text-[var(--bui-ink-2)]">
              {t('panel.sourceCount', { count: sources.length })}
            </span>
          </button>
        ) : null}
      </div>
      {sources.length > 0 && sourcesOpen ? (
        <div
          className="grid transition-[grid-template-rows,opacity] duration-300"
          style={{
            gridTemplateRows: sourcesOpen ? '1fr' : '0fr',
            opacity: sourcesOpen ? 1 : 0,
            transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
          }}
        >
          <div className="overflow-hidden">
            <div className="mt-1.5 flex flex-col rounded-[10px] bg-[var(--bui-inset)] p-1 shadow-[var(--bui-shadow-hairline)]">
              {sources.map((source) => (
                <a
                  key={source.url}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[13px] text-[var(--bui-ink-2)] transition-colors duration-150 hover:bg-[var(--bui-hover)] hover:text-[var(--bui-ink)]"
                >
                  <WebSourceFavicon domain={source.domain} className="h-4 w-4 rounded-[4px]" />
                  <span className="wa-bui-underline min-w-0 truncate">{source.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11.5px] text-[var(--bui-ink-3)]">
                    {source.domain}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function WorkspaceAssistantThreadMessage(props: {
  messagePartComponents: WorkspaceAssistantMessagePartComponents
  undeliveredUserMessageId?: string | null
}) {
  return (
    <>
      <MessagePrimitive.If user>
        <HiddenWorkspaceAssistantInternalMessage>
          <div className="mb-[26px] ml-auto flex w-full max-w-[88%] flex-col items-end">
            <MessagePrimitive.Root className={WORKSPACE_ASSISTANT_USER_MESSAGE_CLASS}>
              <MessagePrimitive.Parts />
              <WorkspaceAssistantUserTextAttachments />
            </MessagePrimitive.Root>
            <WorkspaceAssistantUserUndeliveredMarker
              undeliveredUserMessageId={props.undeliveredUserMessageId ?? null}
            />
          </div>
        </HiddenWorkspaceAssistantInternalMessage>
      </MessagePrimitive.If>

      <MessagePrimitive.If assistant>
        <div className="mb-[30px] space-y-1">
          <MessagePrimitive.Root className={WORKSPACE_ASSISTANT_MESSAGE_CLASS}>
            <MessagePrimitive.Parts components={props.messagePartComponents.assistant} />
            <WorkspaceAssistantAssistantMessageFooter />
          </MessagePrimitive.Root>
        </div>
      </MessagePrimitive.If>

      <MessagePrimitive.If system>
        <HiddenWorkspaceAssistantInternalMessage>
          <div className="space-y-1">
            <MessagePrimitive.Root className="space-y-2 px-1 py-1 text-sm leading-5 text-[var(--glass-text-tertiary)]">
              <MessagePrimitive.Parts components={props.messagePartComponents.standard} />
            </MessagePrimitive.Root>
          </div>
        </HiddenWorkspaceAssistantInternalMessage>
      </MessagePrimitive.If>
    </>
  )
}

export function WorkspaceAssistantPendingTurnPlaceholder(props: { readonly label?: string }) {
  return (
    <div className="space-y-1">
      <div className={WORKSPACE_ASSISTANT_MESSAGE_CLASS}>
        <div className="flex items-center gap-2 text-sm text-[var(--glass-text-secondary)]">
          <WorkspaceAssistantThinkingStatus label={props.label} />
        </div>
      </div>
    </div>
  )
}
