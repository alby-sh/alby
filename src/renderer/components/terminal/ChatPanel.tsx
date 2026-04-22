import { useEffect, useRef, useState, useCallback, memo } from 'react'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatToolCard } from './ChatToolCards'
import { PromptInputBox } from '../ui/ai-prompt-box'

interface ChatPanelProps {
  agentId: string
  visible?: boolean
}

type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant-text'; id: string; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: 'system'; id: string; text: string }
  | { kind: 'result'; id: string; text: string; isError?: boolean }
  | { kind: 'stderr'; id: string; text: string }

interface AssistantContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

interface ToolResultBlock {
  type: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object' && 'text' in c) return String((c as { text: string }).text ?? '')
        return ''
      })
      .join('\n')
  }
  return ''
}

let autoId = 0
const nextId = (): string => `i${++autoId}`

export const ChatPanel = memo(function ChatPanel({ agentId, visible: _visible = true }: ChatPanelProps) {
  const [items, setItems] = useState<Item[]>([])
  const [isBusy, setIsBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // When `--include-partial-messages` is on, claude emits `stream_event`
  // blocks for every token/input delta. We render from those and ignore the
  // final consolidated `assistant` event (it carries the same content).
  const streamingActiveRef = useRef(false)
  // Maps content-block index → item id for the block currently streaming.
  // Keyed by "<message_id>:<index>" so messages don't collide.
  const streamIndexRef = useRef<Map<string, string>>(new Map())
  const currentMessageIdRef = useRef<string | null>(null)
  // Per tool_use, we accumulate the partial JSON string and parse at stop.
  const toolInputBufRef = useRef<Map<string, string>>(new Map())

  const handleStreamEvent = useCallback((evt: Record<string, unknown>) => {
    const subType = evt.type as string
    if (subType === 'message_start') {
      const mid = (evt as { message?: { id?: string } }).message?.id ?? null
      currentMessageIdRef.current = mid
      streamingActiveRef.current = true
      return
    }
    if (subType === 'content_block_start') {
      const idx = (evt as { index: number }).index
      const block = (evt as { content_block?: AssistantContentBlock }).content_block
      if (!block) return
      const key = `${currentMessageIdRef.current ?? 'm'}:${idx}`
      if (block.type === 'text') {
        const itemId = nextId()
        streamIndexRef.current.set(key, itemId)
        setItems((prev) => [...prev, { kind: 'assistant-text', id: itemId, text: '' }])
      } else if (block.type === 'tool_use' && block.id && block.name) {
        streamIndexRef.current.set(key, block.id)
        toolInputBufRef.current.set(block.id, '')
        setItems((prev) => [...prev, { kind: 'tool-use', id: block.id!, name: block.name!, input: {} }])
      }
      return
    }
    if (subType === 'content_block_delta') {
      const idx = (evt as { index: number }).index
      const delta = (evt as { delta?: { type?: string; text?: string; partial_json?: string } }).delta
      if (!delta) return
      const key = `${currentMessageIdRef.current ?? 'm'}:${idx}`
      const itemId = streamIndexRef.current.get(key)
      if (!itemId) return
      if (delta.type === 'text_delta' && delta.text) {
        setItems((prev) =>
          prev.map((it) =>
            it.kind === 'assistant-text' && it.id === itemId ? { ...it, text: it.text + delta.text } : it
          )
        )
      } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
        const buf = (toolInputBufRef.current.get(itemId) ?? '') + delta.partial_json
        toolInputBufRef.current.set(itemId, buf)
        // Try to parse eagerly so the card shows something structured; fall
        // back to raw string if we're mid-object.
        let parsed: unknown = buf
        try { parsed = JSON.parse(buf) } catch { /* partial — keep string */ }
        setItems((prev) =>
          prev.map((it) => (it.kind === 'tool-use' && it.id === itemId ? { ...it, input: parsed } : it))
        )
      }
      return
    }
    if (subType === 'content_block_stop') {
      // Finalize: nothing special needed for text; for tool_use, ensure input
      // is parsed one last time.
      const idx = (evt as { index: number }).index
      const key = `${currentMessageIdRef.current ?? 'm'}:${idx}`
      const itemId = streamIndexRef.current.get(key)
      if (itemId && toolInputBufRef.current.has(itemId)) {
        const buf = toolInputBufRef.current.get(itemId) ?? ''
        try {
          const parsed = JSON.parse(buf)
          setItems((prev) =>
            prev.map((it) => (it.kind === 'tool-use' && it.id === itemId ? { ...it, input: parsed } : it))
          )
        } catch { /* keep partial */ }
        toolInputBufRef.current.delete(itemId)
      }
      streamIndexRef.current.delete(key)
      return
    }
    if (subType === 'message_stop') {
      currentMessageIdRef.current = null
      return
    }
    // message_delta and others: ignore for now.
  }, [])

  // Stable append that updates tool-use cards when a tool_result arrives later.
  const appendEvent = useCallback((event: Record<string, unknown>) => {
    const type = event.type as string
    if (type === 'stream_event') {
      const inner = (event as { event?: Record<string, unknown> }).event
      if (inner) handleStreamEvent(inner)
      return
    }

    setItems((prev) => {
      if (type === 'system') {
        // Claude Code emits a blizzard of internal `system` events during a
        // turn — task_started / task_progress (x20-50 per turn) / task_notification
        // / status — none of which are useful to a human reading the chat.
        // We keep them in the DB transcript for debugging and just drop
        // them from the UI.
        return prev
      }

      if (type === 'assistant') {
        // If streaming is feeding the bubbles already, the consolidated
        // `assistant` event is redundant — skip it to avoid duplicates.
        if (streamingActiveRef.current) return prev
        const msg = (event as { message?: { content?: AssistantContentBlock[] } }).message
        const blocks = msg?.content ?? []
        const next = [...prev]
        for (const b of blocks) {
          if (b.type === 'text' && b.text) {
            next.push({ kind: 'assistant-text', id: nextId(), text: b.text })
          } else if (b.type === 'tool_use' && b.id && b.name) {
            next.push({ kind: 'tool-use', id: b.id, name: b.name, input: b.input })
          }
        }
        return next
      }

      if (type === 'user') {
        // In stream-json, `user` events arriving from the CLI are tool_result
        // blocks (the agent's own responses to its tool_use). We attach them
        // to the matching tool-use card instead of rendering a new bubble.
        const msg = (event as { message?: { content?: ToolResultBlock[] } }).message
        const blocks = msg?.content ?? []
        let next = prev
        for (const b of blocks) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            next = next.map((it) =>
              it.kind === 'tool-use' && it.id === b.tool_use_id
                ? { ...it, result: extractText(b.content), isError: !!b.is_error }
                : it
            )
          }
        }
        return next
      }

      if (type === 'user_input') {
        // Synthetic event emitted by ChatAgent when the user submits a
        // message — the CLI doesn't echo it so we'd otherwise miss both the
        // live bubble and the transcript entry. Dedup by exact text + adjacency
        // so replay over the live stream doesn't double-render.
        const text = String((event as { text?: string }).text ?? '')
        if (!text) return prev
        const last = prev[prev.length - 1]
        if (last && last.kind === 'user' && last.text === text) return prev
        return [...prev, { kind: 'user', id: nextId(), text }]
      }

      if (type === 'result') {
        const subtype = (event as { subtype?: string }).subtype ?? ''
        const text = String((event as { result?: unknown }).result ?? '')
        const isError = subtype.includes('error')
        // Don't duplicate text — the assistant bubble already rendered it.
        // Just surface a small footer when the turn finished with an error.
        if (isError) {
          return [...prev, { kind: 'result', id: nextId(), text: text || subtype, isError: true }]
        }
        return prev
      }

      if (type === 'error') {
        const text = String((event as { error?: string; message?: string }).error ??
          (event as { message?: string }).message ?? 'error')
        return [...prev, { kind: 'result', id: nextId(), text, isError: true }]
      }

      if (type === 'stderr') {
        const text = String((event as { data?: string }).data ?? '')
        return [...prev, { kind: 'stderr', id: nextId(), text }]
      }

      return prev
    })

    // Busy off on result / error; on otherwise.
    if (type === 'result' || type === 'error') setIsBusy(false)
    if (type === 'assistant' || type === 'tool_use' || type === 'user') setIsBusy(true)
  }, [])

  useEffect(() => {
    const unsub = window.electronAPI.agents.onChatEvent((data) => {
      if (data.agentId !== agentId) return
      appendEvent(data.event)
    })
    return unsub
  }, [agentId, appendEvent])

  // Replay persisted transcript on mount: the ChatAgent saves every JSON
  // event to SQLite so the conversation survives tab unmount and app restart.
  // Clicking a chat tab after reopening the app should show the whole
  // history before (optionally) sending a new message resumes the session.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const history = await window.electronAPI.agents.chatHistory(agentId)
        if (cancelled || !history || history.length === 0) return
        for (const ev of history) appendEvent(ev)
      } catch (err) {
        console.warn('[ChatPanel] failed to load history:', err)
      }
    })()
    return () => { cancelled = true }
  }, [agentId, appendEvent])

  // Keep stuck-to-bottom unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [items])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinnedRef.current = nearBottom
  }, [])

  // PromptInputBox owns its own input state + submit handling; `send` just
  // takes the composed text and forwards it to the chat agent.
  const send = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setIsBusy(true)
    try {
      // Idempotent: if the chat process is already alive, this is a no-op.
      // Otherwise it respawns with --resume <session_id> so the conversation
      // continues where it left off across tab close / app restart.
      await window.electronAPI.agents.chatRestart(agentId)
      const res = await window.electronAPI.agents.chatSend(agentId, trimmed)
      if (!res?.ok) {
        setItems((prev) => [...prev, { kind: 'stderr', id: nextId(), text: 'Chat is not running — try reopening the tab.' }])
        setIsBusy(false)
      }
      // NOTE: we don't add the user bubble optimistically — the ChatAgent
      // emits a synthetic `user_input` event that arrives via onChatEvent
      // and also gets persisted to the transcript, keeping live + replay in
      // sync.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setItems((prev) => [...prev, { kind: 'stderr', id: nextId(), text: `send failed: ${msg}` }])
      setIsBusy(false)
    }
  }, [agentId])

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-6 py-4 scrollbar-thin"
      >
        <div className="max-w-[760px] mx-auto flex flex-col gap-3">
          {items.length === 0 && (
            <div className="text-center text-neutral-500 text-[13px] py-12">
              <div className="mb-1">Chat session ready.</div>
              <div className="text-neutral-600 text-[12px]">Ask Claude anything about this project.</div>
            </div>
          )}

          {items.map((it) => {
            if (it.kind === 'user') {
              return (
                <div key={it.id} className="self-end max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-[#c084fc]/15 border border-[#c084fc]/25 text-[13.5px] text-neutral-100 whitespace-pre-wrap break-words">
                  {it.text}
                </div>
              )
            }
            if (it.kind === 'assistant-text') {
              return (
                <div key={it.id} className="self-start max-w-[92%] px-4 py-2 rounded-2xl rounded-bl-md bg-neutral-900 border border-neutral-800">
                  <ChatMarkdown text={it.text} />
                </div>
              )
            }
            if (it.kind === 'tool-use') {
              return (
                <div key={it.id}>
                  <ChatToolCard name={it.name} input={it.input} result={it.result} isError={it.isError} />
                </div>
              )
            }
            if (it.kind === 'system') {
              return (
                <div key={it.id} className="self-center text-[11px] text-neutral-600 italic py-1">{it.text}</div>
              )
            }
            if (it.kind === 'result') {
              return (
                <div key={it.id} className={`self-center text-[12px] px-3 py-1.5 rounded-md ${it.isError ? 'bg-red-950/40 border border-red-900/50 text-red-300' : 'text-neutral-500'}`}>
                  {it.text}
                </div>
              )
            }
            if (it.kind === 'stderr') {
              return (
                <div key={it.id} className="self-stretch text-[11.5px] text-red-300 font-mono bg-red-950/30 border border-red-900/40 rounded px-2.5 py-1.5 whitespace-pre-wrap break-words">
                  {it.text}
                </div>
              )
            }
            return null
          })}

          {isBusy && (
            <div className="self-start flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-neutral-500">
              <span className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-pulse" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-pulse" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-pulse" style={{ animationDelay: '300ms' }} />
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-neutral-800 bg-[var(--bg-primary)] px-6 py-3">
        <div className="max-w-[760px] mx-auto">
          <PromptInputBox
            onSend={(message) => void send(message)}
            isLoading={isBusy}
            placeholder="Message Claude…"
          />
          <div className="text-[10.5px] text-neutral-600 mt-1.5 px-1 text-center">
            Enter to send · Shift+Enter for newline
          </div>
        </div>
      </div>
    </div>
  )
})
