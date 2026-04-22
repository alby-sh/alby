import { memo, useState } from 'react'
import hljs from 'highlight.js/lib/common'

/**
 * Tool-use cards with viewers tailored to the common Claude Code tools.
 * Falls back to a generic JSON card for tools we don't know about.
 */

interface ToolCardProps {
  name: string
  input: unknown
  result?: string
  isError?: boolean
}

function getStr(obj: unknown, key: string): string {
  if (obj && typeof obj === 'object' && key in obj) {
    const v = (obj as Record<string, unknown>)[key]
    if (typeof v === 'string') return v
  }
  return ''
}

function basename(path: string): string {
  if (!path) return ''
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = p.split('/')
  return parts[parts.length - 1] || path
}

function guessLang(filename: string): string | null {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go',
    rb: 'ruby', php: 'php', java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', cc: 'cpp', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', sh: 'bash',
    bash: 'bash', zsh: 'bash', sql: 'sql', html: 'html', css: 'css',
    scss: 'scss', vue: 'xml',
  }
  return map[ext] ?? null
}

function highlight(code: string, lang: string | null): string {
  if (!code) return ''
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
    return hljs.highlightAuto(code).value
  } catch {
    return code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] ?? c))
  }
}

function ToolShell({
  icon, color, title, subtitle, statusBadge, children, defaultOpen,
}: {
  icon: React.ReactNode
  color: string
  title: React.ReactNode
  subtitle?: React.ReactNode
  statusBadge?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <div className="w-full max-w-[92%] self-start">
      <div
        className={`rounded-lg border border-neutral-800 bg-neutral-950/50 overflow-hidden ${open ? 'bg-neutral-950' : ''}`}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-neutral-900/50 transition-colors"
        >
          <div className="flex items-center justify-center w-5 h-5 shrink-0" style={{ color }}>{icon}</div>
          <div className="min-w-0 flex-1 flex items-center gap-2">
            <span className="text-[12px] font-medium text-neutral-100 truncate">{title}</span>
            {subtitle && <span className="text-[11.5px] text-neutral-500 truncate">{subtitle}</span>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {statusBadge}
            <svg viewBox="0 0 24 24" className={`w-3.5 h-3.5 text-neutral-500 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </button>
        {open && <div className="px-3 pb-3 pt-0 border-t border-neutral-800/70">{children}</div>}
      </div>
    </div>
  )
}

function StatusBadge({ result, isError }: { result?: string; isError?: boolean }) {
  if (isError) return <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 border border-red-900/50">error</span>
  if (result !== undefined) return <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-400 border border-emerald-900/40">done</span>
  return <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 border border-neutral-700">running…</span>
}

/* ============================== viewers ============================== */

function EditViewer({ input, result, isError }: ToolCardProps) {
  const filePath = getStr(input, 'file_path')
  const oldStr = getStr(input, 'old_string')
  const newStr = getStr(input, 'new_string')
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  return (
    <ToolShell
      icon={<svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" strokeLinecap="round" strokeLinejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      color="#facc15"
      title="Edit"
      subtitle={basename(filePath) || '—'}
      statusBadge={<StatusBadge result={result} isError={isError} />}
    >
      {filePath && <div className="text-[11px] font-mono text-neutral-500 mb-2">{filePath}</div>}
      <div className="rounded border border-neutral-800 overflow-hidden text-[12px] font-mono">
        {oldLines.map((l, i) => (
          <div key={`old-${i}`} className="flex bg-red-950/25">
            <span className="w-6 text-center shrink-0 text-red-400/70 select-none border-r border-red-900/30">−</span>
            <span className="px-2 py-0.5 text-red-200 whitespace-pre-wrap break-words flex-1">{l || ' '}</span>
          </div>
        ))}
        {newLines.map((l, i) => (
          <div key={`new-${i}`} className="flex bg-emerald-950/25">
            <span className="w-6 text-center shrink-0 text-emerald-400/70 select-none border-r border-emerald-900/30">+</span>
            <span className="px-2 py-0.5 text-emerald-200 whitespace-pre-wrap break-words flex-1">{l || ' '}</span>
          </div>
        ))}
      </div>
      {result !== undefined && isError && (
        <pre className="mt-2 text-[11.5px] text-red-300 bg-red-950/30 border border-red-900/40 rounded p-2 whitespace-pre-wrap break-words">{result}</pre>
      )}
    </ToolShell>
  )
}

function WriteViewer({ input, result, isError }: ToolCardProps) {
  const filePath = getStr(input, 'file_path')
  const content = getStr(input, 'content')
  const lang = guessLang(filePath)
  const lineCount = content ? content.split('\n').length : 0
  const highlighted = highlight(content, lang)
  return (
    <ToolShell
      icon={<svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" strokeLinecap="round" strokeLinejoin="round"/><path d="M14 2v6h6M12 18v-6M9 15l3 3 3-3" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      color="#34d399"
      title="Write"
      subtitle={`${basename(filePath) || '—'}${lineCount ? ` · ${lineCount} lines` : ''}`}
      statusBadge={<StatusBadge result={result} isError={isError} />}
    >
      {filePath && <div className="text-[11px] font-mono text-neutral-500 mb-2">{filePath}</div>}
      <pre className="overflow-x-auto text-[12px] leading-relaxed p-2.5 m-0 bg-[#0d1117] rounded border border-neutral-800">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
      {result !== undefined && isError && (
        <pre className="mt-2 text-[11.5px] text-red-300 bg-red-950/30 border border-red-900/40 rounded p-2 whitespace-pre-wrap break-words">{result}</pre>
      )}
    </ToolShell>
  )
}

function BashViewer({ input, result, isError }: ToolCardProps) {
  const command = getStr(input, 'command')
  const description = getStr(input, 'description')
  return (
    <ToolShell
      icon={<svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 17l6-5-6-5M12 19h8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      color="#a3a3a3"
      title="Bash"
      subtitle={description || command.split('\n')[0] || ''}
      statusBadge={<StatusBadge result={result} isError={isError} />}
    >
      <pre className="text-[12px] leading-relaxed rounded bg-black/60 border border-neutral-800 p-2.5 m-0 overflow-x-auto whitespace-pre-wrap break-words">
        <span className="text-emerald-500 select-none">$ </span>
        <span className="text-neutral-100">{command}</span>
      </pre>
      {result !== undefined && (
        <pre className={`mt-2 text-[11.5px] leading-relaxed rounded p-2.5 overflow-x-auto whitespace-pre-wrap break-words border ${isError ? 'bg-red-950/30 border-red-900/40 text-red-200' : 'bg-neutral-950 border-neutral-800 text-neutral-300'}`}>{result || '(no output)'}</pre>
      )}
    </ToolShell>
  )
}

function ReadViewer({ input, result, isError }: ToolCardProps) {
  const filePath = getStr(input, 'file_path')
  const offset = (input as { offset?: number } | null)?.offset
  const limit = (input as { limit?: number } | null)?.limit
  const subtitle = [
    basename(filePath) || '—',
    offset ? `from line ${offset}` : null,
    limit ? `${limit} lines` : null,
  ].filter(Boolean).join(' · ')
  const lang = guessLang(filePath)
  // Read's result is `cat -n`-style: "     1\t<content>". Split on the first
  // tab of each line so we can show line numbers in a gutter.
  type Line = { n: string; text: string }
  const lines: Line[] = (result ?? '').split('\n').slice(0, 400).map((l) => {
    const m = /^(\s*\d+)\t(.*)$/.exec(l)
    return m ? { n: m[1].trim(), text: m[2] } : { n: '', text: l }
  })
  const joined = lines.map((l) => l.text).join('\n')
  const highlighted = highlight(joined, lang)
  const highlightedLines = highlighted.split('\n')
  return (
    <ToolShell
      icon={<svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" strokeLinecap="round" strokeLinejoin="round"/><path d="M14 2v6h6M9 13h6M9 17h6M9 9h1" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      color="#60a5fa"
      title="Read"
      subtitle={subtitle}
      statusBadge={<StatusBadge result={result} isError={isError} />}
    >
      {filePath && <div className="text-[11px] font-mono text-neutral-500 mb-2">{filePath}</div>}
      {result === undefined ? null : isError ? (
        <pre className="text-[11.5px] text-red-300 bg-red-950/30 border border-red-900/40 rounded p-2 whitespace-pre-wrap break-words">{result}</pre>
      ) : (
        <div className="rounded border border-neutral-800 bg-[#0d1117] overflow-hidden">
          <div className="overflow-x-auto text-[12px] leading-relaxed max-h-[320px] overflow-y-auto">
            <table className="border-collapse w-full font-mono">
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td className="select-none text-right text-neutral-600 pl-3 pr-2 py-0 align-top w-px whitespace-nowrap">{l.n || i + 1}</td>
                    <td className="pr-3 py-0">
                      <code className="hljs whitespace-pre-wrap break-words" dangerouslySetInnerHTML={{ __html: highlightedLines[i] ?? (l.text || ' ') }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(result?.split('\n').length ?? 0) > 400 && (
            <div className="text-[10.5px] text-neutral-500 px-3 py-1.5 border-t border-neutral-800 bg-neutral-950/80">
              … truncated after 400 lines
            </div>
          )}
        </div>
      )}
    </ToolShell>
  )
}

function GenericToolViewer({ name, input, result, isError }: ToolCardProps) {
  const inputStr = (() => {
    try { return JSON.stringify(input, null, 2) } catch { return String(input) }
  })()
  const subtitle = (() => {
    if (!input || typeof input !== 'object') return ''
    const rec = input as Record<string, unknown>
    // Pick the first short string field as a one-liner — e.g. pattern for Grep,
    // url for WebFetch, description for SlashCommand.
    for (const key of ['file_path', 'path', 'pattern', 'url', 'command', 'query', 'description']) {
      const v = rec[key]
      if (typeof v === 'string' && v.length > 0) return v.length > 80 ? v.slice(0, 80) + '…' : v
    }
    return ''
  })()
  return (
    <ToolShell
      icon={<svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      color="#94a3b8"
      title={name}
      subtitle={subtitle}
      statusBadge={<StatusBadge result={result} isError={isError} />}
    >
      <div className="text-[10.5px] uppercase tracking-wide text-neutral-500 mb-1">input</div>
      <pre className="text-[11.5px] text-neutral-300 bg-neutral-950 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words border border-neutral-800">{inputStr}</pre>
      {result !== undefined && (
        <>
          <div className="text-[10.5px] uppercase tracking-wide text-neutral-500 mt-2 mb-1">
            {isError ? 'error' : 'output'}
          </div>
          <pre className={`text-[11.5px] rounded p-2 overflow-x-auto whitespace-pre-wrap break-words border ${isError ? 'text-red-300 bg-red-950/30 border-red-900/40' : 'text-neutral-300 bg-neutral-950 border-neutral-800'}`}>{result || '(empty)'}</pre>
        </>
      )}
    </ToolShell>
  )
}

/* ============================ dispatcher ============================ */

export const ChatToolCard = memo(function ChatToolCard(props: ToolCardProps) {
  switch (props.name) {
    case 'Edit':
    case 'MultiEdit':
      return <EditViewer {...props} />
    case 'Write':
      return <WriteViewer {...props} />
    case 'Bash':
    case 'BashOutput':
      return <BashViewer {...props} />
    case 'Read':
      return <ReadViewer {...props} />
    default:
      return <GenericToolViewer {...props} />
  }
})
