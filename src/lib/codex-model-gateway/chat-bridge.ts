/**
 * Responses API <-> Chat Completions bridge for OpenAI-compatible providers
 * that do not implement the OpenAI Responses endpoint.
 *
 * The Codex CLI (0.146) only speaks the Responses wire, so the gateway
 * translates in both directions: the normalized Responses request becomes a
 * Chat Completions request, and the provider's chat stream becomes a
 * Responses event stream with the same vocabulary Codex consumes.
 */

export const ADAPTIVE_STRIP_PARAMS = ['reasoning', 'reasoning_effort', 'stream_options', 'top_p', 'seed'] as const

/** baseUrl::param entries the provider rejected with a 400; learned per process. */
const incompatibleParams = new Set<string>()

export function markChatParamIncompatible(baseUrl: string, param: string): void {
  incompatibleParams.add(`${baseUrl}\u0000${param}`)
}

function paramIncompatible(baseUrl: string, param: string): boolean {
  return incompatibleParams.has(`${baseUrl}\u0000${param}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Request translation: Responses -> Chat Completions
// ---------------------------------------------------------------------------

function messageContentFromParts(parts: readonly unknown[]): string | Array<Record<string, unknown>> {
  const texts: string[] = []
  let allText = true
  for (const part of parts) {
    if (
      isRecord(part)
      && (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text')
      && typeof part.text === 'string'
    ) {
      texts.push(part.text)
    } else {
      allText = false
    }
  }
  if (allText) return texts.join('\n')
  return texts
    .map((text) => ({ type: 'text', text }))
    .filter((part) => part.text.trim())
}

function chatRoleForResponsesRole(role: unknown): string {
  if (role === 'user' || role === 'assistant') return role
  if (role === 'developer' || role === 'system') return role
  return 'user'
}

function inputItemToChatMessages(item: unknown): Array<Record<string, unknown>> {
  if (typeof item === 'string') {
    return [{ role: 'user', content: item }]
  }
  if (!isRecord(item)) return []
  switch (item.type) {
    case 'message': {
      if (!Array.isArray(item.content)) return []
      const content = messageContentFromParts(item.content)
      if (typeof content === 'string' && !content.trim()) return []
      return [{ role: chatRoleForResponsesRole(item.role), content }]
    }
    case 'function_call': {
      if (typeof item.name !== 'string' || !item.name || typeof item.call_id !== 'string') return []
      return [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : '',
          },
        }],
      }]
    }
    case 'function_call_output': {
      if (typeof item.call_id !== 'string') return []
      const output = item.output
      return [{
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
      }]
    }
    // reasoning / item_reference and other item kinds have no Chat
    // Completions equivalent; the provider regenerates its own reasoning.
    default:
      return []
  }
}

function chatToolForResponsesTool(tool: unknown): Record<string, unknown> | null {
  if (!isRecord(tool) || tool.type !== 'function') return null
  if (typeof tool.name !== 'string' || !tool.name) return null
  const parameters = isRecord(tool.parameters)
    ? tool.parameters
    : { type: 'object', properties: {} }
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(typeof tool.description === 'string' && tool.description ? { description: tool.description } : {}),
      parameters,
      ...(tool.strict === true ? { strict: true } : {}),
    },
  }
}

export function translateResponsesToChatRequest(params: {
  readonly body: Record<string, unknown>
  readonly modelId: string
  readonly baseUrl: string
}): string {
  const { body } = params
  const messages: Array<Record<string, unknown>> = []
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions })
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      messages.push(...inputItemToChatMessages(item))
    }
  }

  const chatRequest: Record<string, unknown> = {
    model: params.modelId,
    messages,
    stream: true,
  }
  if (!paramIncompatible(params.baseUrl, 'stream_options')) {
    chatRequest.stream_options = { include_usage: true }
  }
  if (Array.isArray(body.tools)) {
    const tools = body.tools
      .map((tool) => chatToolForResponsesTool(tool))
      .filter((tool): tool is Record<string, unknown> => tool !== null)
    if (tools.length > 0) chatRequest.tools = tools
  }
  const toolChoice = body.tool_choice
  if (typeof toolChoice === 'string' && ['auto', 'none', 'required'].includes(toolChoice)) {
    chatRequest.tool_choice = toolChoice
  } else if (isRecord(toolChoice) && toolChoice.type === 'function' && typeof toolChoice.name === 'string') {
    chatRequest.tool_choice = { type: 'function', function: { name: toolChoice.name } }
  }
  if (typeof body.temperature === 'number') chatRequest.temperature = body.temperature
  if (typeof body.top_p === 'number' && !paramIncompatible(params.baseUrl, 'top_p')) {
    chatRequest.top_p = body.top_p
  }
  if (typeof body.max_output_tokens === 'number') {
    chatRequest.max_tokens = body.max_output_tokens
  }
  if (typeof body.parallel_tool_calls === 'boolean') {
    chatRequest.parallel_tool_calls = body.parallel_tool_calls
  }
  if (typeof body.seed === 'number' && !paramIncompatible(params.baseUrl, 'seed')) {
    chatRequest.seed = body.seed
  }
  const reasoning = body.reasoning
  if (
    isRecord(reasoning)
    && typeof reasoning.effort === 'string'
    && !paramIncompatible(params.baseUrl, 'reasoning')
  ) {
    // DeepSeek-style chat APIs (and OpenAI-compatible servers in general)
    // accept the OpenAI `reasoning` object; effort is clamped to the
    // high/low pair most of them support, with medium passing through for
    // servers that declare it.
    const effort = ['minimal', 'low'].includes(reasoning.effort)
      ? 'low'
      : reasoning.effort === 'medium'
        ? 'medium'
        : 'high'
    chatRequest.reasoning = { effort }
  }
  return JSON.stringify(chatRequest)
}

// ---------------------------------------------------------------------------
// Response translation: Chat Completions stream -> Responses events
// ---------------------------------------------------------------------------

export type ChatToResponsesBridge = {
  readonly stream: ReadableStream<Uint8Array>
  /** Resolves when the provider stream has been fully translated. */
  readonly done: Promise<void>
}

type BridgeParams = {
  readonly response: Response
  readonly modelId: string
  readonly instructions?: string
  readonly tools?: readonly unknown[]
  readonly temperature?: number
  readonly maxOutputTokens?: number
}

export function createResponsesBridgeFromChatResponse(
  params: BridgeParams,
  requestSignal: AbortSignal,
): ChatToResponsesBridge {
  const generator = params.response.headers.get('content-type')?.toLowerCase().includes('application/json')
    && !params.response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')
    ? jsonChatToResponsesEvents(params)
    : sseChatToResponsesEvents(params)
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const upstreamBody = params.response.body
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of generator) {
          controller.enqueue(chunk)
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        resolveDone()
      }
    },
    cancel() {
      void upstreamBody?.cancel().catch(() => undefined)
    },
  })
  if (requestSignal.aborted) void stream.cancel()
  else {
    requestSignal.addEventListener('abort', () => {
      void stream.cancel()
    }, { once: true })
  }
  return { stream, done }
}

let responseIdCounter = 0

function newResponseId(): string {
  responseIdCounter += 1
  return `resp_${Date.now().toString(36)}_${responseIdCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function sseEvent(type: string, payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
}

function baseResponse(
  params: BridgeParams,
  status: 'in_progress' | 'completed' | 'failed',
  id: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: params.modelId,
    status,
    error: null,
    incomplete_reason: null,
    instructions: params.instructions ?? '',
    metadata: {},
    output: [],
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: params.tools ?? [],
    ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
    ...(typeof params.maxOutputTokens === 'number' ? { max_output_tokens: params.maxOutputTokens } : {}),
    top_p: 1,
    usage: null,
    ...extra,
  }
}

function mapChatUsage(usage: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!usage) return null
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : null
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null
  const inputTokens = typeof usage.input_tokens === 'number'
    ? usage.input_tokens
    : typeof usage.prompt_tokens === 'number'
      ? usage.prompt_tokens
      : 0
  const outputTokens = typeof usage.output_tokens === 'number'
    ? usage.output_tokens
    : typeof usage.completion_tokens === 'number'
      ? usage.completion_tokens
      : 0
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : inputTokens + outputTokens,
    input_tokens_details: {
      cached_tokens: typeof inputDetails?.cached_tokens === 'number'
        ? inputDetails.cached_tokens
        : typeof promptDetails?.cached_tokens === 'number'
          ? promptDetails.cached_tokens
          : 0,
    },
    output_tokens_details: {
      reasoning_tokens: typeof completionDetails?.reasoning_tokens === 'number'
        ? completionDetails.reasoning_tokens
        : typeof outputDetails?.reasoning_tokens === 'number'
          ? outputDetails.reasoning_tokens
          : 0,
    },
  }
}

type FinalItem = {
  readonly id: string
  readonly type: 'message' | 'function_call'
  readonly status: 'completed'
  role?: string
  content?: Array<Record<string, unknown>>
  name?: string
  call_id?: string
  arguments?: string
}

function messageToEvents(params: BridgeParams, message: Record<string, unknown>, usage: Record<string, unknown> | null): Uint8Array[] {
  const id = newResponseId()
  let seq = 0
  const nextSeq = () => seq += 1
  const events: Uint8Array[] = []
  const emit = (type: string, payload: Record<string, unknown>) => {
    events.push(sseEvent(type, { sequence_number: nextSeq(), ...payload }))
  }
  emit('response.created', { response: baseResponse(params, 'in_progress', id) })
  emit('response.in_progress', { response: baseResponse(params, 'in_progress', id) })

  const items: FinalItem[] = []
  let outputIndex = 0
  const content = message.content
  if (typeof content === 'string' && content) {
    const itemId = `msg_${outputIndex}`
    emit('response.output_item.added', {
      output_index: outputIndex,
      item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    })
    emit('response.content_part.added', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    })
    emit('response.output_text.delta', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      delta: content,
    })
    emit('response.output_text.done', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text: content,
    })
    emit('response.content_part.done', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: content, annotations: [] },
    })
    emit('response.output_item.done', {
      item_id: itemId,
      output_index: outputIndex,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: content, annotations: [] }],
      },
    })
    items.push({
      id: itemId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    })
    outputIndex += 1
  }
  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall)) continue
      const fn = isRecord(toolCall.function) ? toolCall.function : null
      const name = fn && typeof fn.name === 'string' ? fn.name : ''
      const argumentsValue = fn && typeof fn.arguments === 'string' ? fn.arguments : ''
      const callId = typeof toolCall.id === 'string' ? toolCall.id : `call_${outputIndex}`
      const itemId = `fc_${outputIndex}`
      emit('response.output_item.added', {
        output_index: outputIndex,
        item: { id: itemId, type: 'function_call', status: 'in_progress', name, call_id: callId, arguments: '' },
      })
      if (argumentsValue) {
        emit('response.function_call_arguments.delta', {
          item_id: itemId,
          output_index: outputIndex,
          delta: argumentsValue,
        })
        emit('response.function_call_arguments.done', {
          item_id: itemId,
          output_index: outputIndex,
          arguments: argumentsValue,
        })
      }
      emit('response.output_item.done', {
        item_id: itemId,
        output_index: outputIndex,
        item: {
          id: itemId,
          type: 'function_call',
          status: 'completed',
          name,
          call_id: callId,
          arguments: argumentsValue,
        },
      })
      items.push({
        id: itemId,
        type: 'function_call',
        status: 'completed',
        name,
        call_id: callId,
        arguments: argumentsValue,
      })
      outputIndex += 1
    }
  }
  emit('response.completed', {
    response: {
      ...baseResponse(params, 'completed', id),
      output: items,
      usage: mapChatUsage(usage),
    },
  })
  return events
}

async function* jsonChatToResponsesEvents(params: BridgeParams): AsyncGenerator<Uint8Array> {
  const raw = await params.response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    yield sseEvent('response.failed', {
      response: {
        ...baseResponse(params, 'failed', newResponseId()),
        error: { code: 'provider_invalid_json', message: raw.slice(0, 500) },
      },
    })
    return
  }
  if (isRecord(parsed) && isRecord(parsed.error)) {
    yield sseEvent('response.failed', {
      response: {
        ...baseResponse(params, 'failed', newResponseId()),
        error: {
          code: typeof parsed.error.code === 'string' ? parsed.error.code : 'provider_error',
          message: typeof parsed.error.message === 'string' ? parsed.error.message : raw.slice(0, 500),
        },
      },
    })
    return
  }
  const choice = isRecord(parsed) && Array.isArray(parsed.choices) && isRecord(parsed.choices[0])
    ? parsed.choices[0]
    : null
  const message = choice && isRecord(choice.message) ? choice.message : null
  if (!message) {
    yield sseEvent('response.failed', {
      response: {
        ...baseResponse(params, 'failed', newResponseId()),
        error: { code: 'provider_missing_message', message: raw.slice(0, 500) },
      },
    })
    return
  }
  const usage = isRecord(parsed) && isRecord(parsed.usage) ? parsed.usage : null
  for (const event of messageToEvents(params, message, usage)) yield event
}

async function* sseChatToResponsesEvents(params: BridgeParams): AsyncGenerator<Uint8Array> {
  const body = params.response.body
  const id = newResponseId()
  if (!body) {
    yield sseEvent('response.created', { response: baseResponse(params, 'in_progress', id) })
    yield sseEvent('response.failed', {
      response: {
        ...baseResponse(params, 'failed', id),
        error: { code: 'provider_empty_body', message: 'provider returned no stream body' },
      },
    })
    return
  }
  yield sseEvent('response.created', { response: baseResponse(params, 'in_progress', id) })
  yield sseEvent('response.in_progress', { response: baseResponse(params, 'in_progress', id) })

  const decoder = new TextDecoder()
  let buffer = ''
  let sawAnyChunk = false
  let usage: Record<string, unknown> | null = null
  const items: FinalItem[] = []
  let openText: { itemId: string; outputIndex: number; text: string } | null = null
  const openTools = new Map<number, {
    itemId: string
    outputIndex: number
    callId: string
    name: string
    arguments: string
  }>()
  let outputIndex = 0
  let seq = 0
  let failed = false

  const emit = (type: string, payload: Record<string, unknown>): Uint8Array =>
    sseEvent(type, { sequence_number: seq++, ...payload })

  const closeText = (): Uint8Array[] => {
    if (!openText) return []
    const text = openText
    openText = null
    const events: Uint8Array[] = []
    events.push(emit('response.output_text.done', {
      item_id: text.itemId,
      output_index: text.outputIndex,
      content_index: 0,
      text: text.text,
    }))
    events.push(emit('response.content_part.done', {
      item_id: text.itemId,
      output_index: text.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: text.text, annotations: [] },
    }))
    events.push(emit('response.output_item.done', {
      item_id: text.itemId,
      output_index: text.outputIndex,
      item: {
        id: text.itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: text.text, annotations: [] }],
      },
    }))
    items.push({
      id: text.itemId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: text.text, annotations: [] }],
    })
    return events
  }

  const closeTool = (index: number): Uint8Array[] => {
    const tool = openTools.get(index)
    if (!tool) return []
    openTools.delete(index)
    const events: Uint8Array[] = []
    events.push(emit('response.function_call_arguments.done', {
      item_id: tool.itemId,
      output_index: tool.outputIndex,
      arguments: tool.arguments,
    }))
    events.push(emit('response.output_item.done', {
      item_id: tool.itemId,
      output_index: tool.outputIndex,
      item: {
        id: tool.itemId,
        type: 'function_call',
        status: 'completed',
        name: tool.name,
        call_id: tool.callId,
        arguments: tool.arguments,
      },
    }))
    items.push({
      id: tool.itemId,
      type: 'function_call',
      status: 'completed',
      name: tool.name,
      call_id: tool.callId,
      arguments: tool.arguments,
    })
    return events
  }

  const handleChunk = (chunk: Record<string, unknown>): Uint8Array[] => {
    const events: Uint8Array[] = []
    sawAnyChunk = true
    if (isRecord(chunk.error)) {
      failed = true
      const error = chunk.error
      const message = typeof error.message === 'string' ? error.message : JSON.stringify(error)
      events.push(emit('response.failed', {
        response: {
          ...baseResponse(params, 'failed', id),
          error: {
            code: typeof error.code === 'string' ? error.code : 'provider_stream_error',
            message,
          },
          output: items,
        },
      }))
      return events
    }
    if (isRecord(chunk.usage)) usage = { ...chunk.usage }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      const delta = isRecord(choice.delta) ? choice.delta : null
      if (delta) {
        // DeepSeek-style providers emit reasoning_content before content. It
        // has no Responses equivalent this bridge synthesizes, so it is
        // dropped; the provider regenerates it server-side.
        if (typeof delta.content === 'string' && delta.content) {
          for (const index of [...openTools.keys()]) events.push(...closeTool(index))
          if (!openText) {
            openText = {
              itemId: `msg_${outputIndex}`,
              outputIndex,
              text: '',
            }
            outputIndex += 1
            events.push(emit('response.output_item.added', {
              output_index: openText.outputIndex,
              item: {
                id: openText.itemId,
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: [],
              },
            }))
            events.push(emit('response.content_part.added', {
              item_id: openText.itemId,
              output_index: openText.outputIndex,
              content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] },
            }))
          }
          openText.text += delta.content
          events.push(emit('response.output_text.delta', {
            item_id: openText.itemId,
            output_index: openText.outputIndex,
            content_index: 0,
            delta: delta.content,
          }))
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const toolDelta of delta.tool_calls) {
            if (!isRecord(toolDelta)) continue
            const index = typeof toolDelta.index === 'number' ? toolDelta.index : 0
            let tool = openTools.get(index)
            if (!tool) {
              events.push(...closeText())
              tool = {
                itemId: `fc_${outputIndex}`,
                outputIndex,
                callId: typeof toolDelta.id === 'string' ? toolDelta.id : `call_${index}`,
                name: '',
                arguments: '',
              }
              outputIndex += 1
              openTools.set(index, tool)
              events.push(emit('response.output_item.added', {
                output_index: tool.outputIndex,
                item: {
                  id: tool.itemId,
                  type: 'function_call',
                  status: 'in_progress',
                  name: tool.name,
                  call_id: tool.callId,
                  arguments: '',
                },
              }))
            }
            const fn = isRecord(toolDelta.function) ? toolDelta.function : null
            if (fn) {
              if (typeof fn.name === 'string' && fn.name) tool.name = fn.name
              if (typeof fn.arguments === 'string' && fn.arguments) {
                tool.arguments += fn.arguments
                events.push(emit('response.function_call_arguments.delta', {
                  item_id: tool.itemId,
                  output_index: tool.outputIndex,
                  delta: fn.arguments,
                }))
              }
            }
          }
        }
      }
      if (choice.finish_reason) {
        events.push(...closeText())
        for (const index of [...openTools.keys()]) events.push(...closeTool(index))
      }
    }
    return events
  }

  const handleBlock = (block: string): Uint8Array[] => {
    const events: Uint8Array[] = []
    for (const line of block.split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trimStart()
      if (!data || data === '[DONE]') continue
      try {
        events.push(...handleChunk(JSON.parse(data) as Record<string, unknown>))
      } catch {
        // Non-JSON data line (keepalive or provider noise); ignore.
      }
    }
    return events
  }

  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/u.exec(buffer)) !== null) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        for (const event of handleBlock(block)) yield event
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      for (const event of handleBlock(buffer)) yield event
    }
  } catch (error) {
    if (!failed) {
      failed = true
      const message = error instanceof Error ? error.message : String(error)
      yield sseEvent('response.failed', {
        response: {
          ...baseResponse(params, 'failed', id),
          error: { code: 'provider_stream_interrupted', message },
          output: items,
        },
      })
    }
  } finally {
    reader.releaseLock()
  }

  if (failed) return
  for (const event of closeText()) yield event
  for (const index of [...openTools.keys()]) {
    for (const event of closeTool(index)) yield event
  }
  yield sseEvent('response.completed', {
    sequence_number: seq++,
    type: 'response.completed',
    response: {
      ...baseResponse(params, 'completed', id),
      output: items,
      usage: mapChatUsage(usage),
    },
  })
}
