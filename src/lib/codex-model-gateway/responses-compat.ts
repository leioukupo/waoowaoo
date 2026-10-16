/**
 * Responses-wire tool compatibility for OpenAI-compatible providers.
 *
 * Some /responses implementations deviate from the OpenAI API surface
 * (DeepSeek native is the known case, probed 2026-10-11):
 *   - the custom tool allowlist is exactly `apply_patch`; Codex's
 *     grammar-based `exec` gets a 400, while every function tool (including
 *     `exec_command`/`write_stdin`/`wait`, which cover the same shell work)
 *     and namespace groups with function children are accepted;
 *   - `tool_choice` only accepts named function/custom references, not
 *     `auto`/`none`/`required`;
 *   - `reasoning.summary` only accepts auto/concise/detailed, not `none`.
 *
 * `proactive` (OpenAI-compatible channels) applies the full baseline up
 * front so no request is ever wasted; otherwise only the adjustments a
 * specific provider previously proved through a 400/422 are applied. The
 * marks are in-memory per normalized base URL, like the chat bridge's
 * parameter marks.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '')
}

type ProviderCompatState = {
  readonly droppedToolNames: Set<string>
  readonly droppedToolVariants: Map<number, string>
  summaryAuto: boolean
  toolChoiceStripped: boolean
}

const stateByBaseUrl = new Map<string, ProviderCompatState>()

function getProviderState(baseUrl: string): ProviderCompatState {
  const key = normalizeBaseUrl(baseUrl)
  let state = stateByBaseUrl.get(key)
  if (!state) {
    state = {
      droppedToolNames: new Set<string>(),
      droppedToolVariants: new Map<number, string>(),
      summaryAuto: false,
      toolChoiceStripped: false,
    }
    stateByBaseUrl.set(key, state)
  }
  return state
}

export type ResponsesAdjustment =
  | { readonly kind: 'dropTool'; readonly name: string }
  | { readonly kind: 'dropToolIndex'; readonly index: number; readonly variant: string }
  | { readonly kind: 'reasoningSummaryAuto' }
  | { readonly kind: 'stripToolChoice' }

/**
 * Parses a provider 400/422 body into the adjustments it implicitly
 * demands. Recognized forms (DeepSeek native):
 *   - "Unsupported custom tool: 'exec'. Only 'apply_patch' is supported."
 *   - "tools[4]: unknown variant `web_search`, expected `function` or `custom`"
 *   - "tool_choice: unknown variant `auto`, expected one of ..."
 *   - "reasoning.summary: unknown variant `none`, expected one of ..."
 */
export function parseResponsesAdjustments(errorText: string): ResponsesAdjustment[] {
  const adjustments: ResponsesAdjustment[] = []
  for (const match of errorText.matchAll(/unsupported\s+custom\s+tool\s*:?\s*['"]?([A-Za-z0-9_.\-/]+)/giu)) {
    adjustments.push({ kind: 'dropTool', name: match[1] })
  }
  for (const match of errorText.matchAll(/tools\[(\d+)\]\s*:\s*unknown variant\s*`([^`]+)`/giu)) {
    adjustments.push({ kind: 'dropToolIndex', index: Number(match[1]), variant: match[2] })
  }
  if (/tool_choice\s*:\s*unknown variant/iu.test(errorText)) {
    adjustments.push({ kind: 'stripToolChoice' })
  }
  if (/reasoning\s*\.\s*summary\s*:\s*unknown variant/iu.test(errorText)) {
    adjustments.push({ kind: 'reasoningSummaryAuto' })
  }
  return adjustments
}

/** Remembers adjustments so later requests apply them without another 400. */
export function markResponsesAdjustments(
  baseUrl: string,
  adjustments: readonly ResponsesAdjustment[],
): void {
  const state = getProviderState(baseUrl)
  for (const adjustment of adjustments) {
    if (adjustment.kind === 'dropTool') state.droppedToolNames.add(adjustment.name)
    if (adjustment.kind === 'dropToolIndex') state.droppedToolVariants.set(adjustment.index, adjustment.variant)
    if (adjustment.kind === 'reasoningSummaryAuto') state.summaryAuto = true
    if (adjustment.kind === 'stripToolChoice') state.toolChoiceStripped = true
  }
}

/**
 * Normalizes the Responses request body in place. `changes` receives
 * human-readable descriptions of what was altered (for logging).
 */
export function normalizeResponsesRequestCompat(params: {
  readonly parsed: Record<string, unknown>
  readonly baseUrl: string
  readonly proactive: boolean
  readonly changes: string[]
}): void {
  const state = getProviderState(params.baseUrl)
  const { parsed, changes } = params
  const proactive = params.proactive

  if (Array.isArray(parsed.tools)) {
    const tools = parsed.tools
    const next: unknown[] = []
    let changed = false
    for (const tool of tools) {
      const record = isRecord(tool) ? tool : null
      const type = record && typeof record.type === 'string' ? record.type : null
      const name = record && typeof record.name === 'string' ? record.name : null

      if (type === 'custom') {
        if (name !== 'apply_patch' && (proactive || (name !== null && state.droppedToolNames.has(name)))) {
          changes.push(proactive ? `dropped custom tool ${name}` : `dropped custom tool ${name} (marked)`)
          changed = true
          continue
        }
        next.push(tool)
        continue
      }

      if (type === 'namespace' && isRecord(record) && Array.isArray(record.tools)) {
        const children = record.tools
        const keptChildren = children.filter((child) => {
          const childRecord = isRecord(child) ? child : null
          const childType = childRecord && typeof childRecord.type === 'string' ? childRecord.type : null
          return childType === 'function' || childType === 'custom'
        })
        if (proactive) {
          if (keptChildren.length === 0) {
            changes.push(`dropped namespace ${String(name)}`)
            changed = true
            continue
          }
          if (keptChildren.length !== children.length) {
            record.tools = keptChildren
            changes.push(`filtered namespace ${String(name)} children to function/custom`)
            changed = true
          }
        }
        next.push(tool)
        continue
      }

      if (type !== 'function' && type !== null) {
        // Learned index-based drops: the provider named a position and
        // variant; only honor it when the current occupant (or one of a
        // namespace's children) still matches, so a shifted array can
        // never drop the wrong tool.
        if (!proactive) {
          const markedVariant = state.droppedToolVariants.get(next.length)
          const childTypes = isRecord(record) && Array.isArray(record.tools)
            ? record.tools.map((child) => isRecord(child) && typeof child.type === 'string' ? child.type : null)
            : []
          if (markedVariant && (type === markedVariant || childTypes.includes(markedVariant))) {
            changes.push(`dropped tool ${String(name ?? type)} at index ${next.length} (marked)`)
            changed = true
            continue
          }
        }
      }
      next.push(tool)
    }
    if (changed) parsed.tools = next
  }

  if (parsed.tool_choice !== undefined) {
    const choice = parsed.tool_choice
    const namedReference =
      (typeof choice === 'string' && choice !== 'auto' && choice !== 'none' && choice !== 'required')
      || (isRecord(choice) && (choice.type === 'function' || choice.type === 'custom') && typeof choice.name === 'string')
    if (state.toolChoiceStripped || (proactive && !namedReference)) {
      delete parsed.tool_choice
      changes.push('stripped tool_choice')
    }
  }

  if (isRecord(parsed.reasoning)) {
    const reasoning = parsed.reasoning
    if ((proactive || state.summaryAuto) && reasoning.summary === 'none') {
      reasoning.summary = 'auto'
      changes.push('reasoning.summary none -> auto')
    }
  }
}
