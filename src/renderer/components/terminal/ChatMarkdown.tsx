import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'

interface CodeProps {
  inline?: boolean
  className?: string
  children?: React.ReactNode
}

/**
 * Assistant markdown renderer. Claude's answers are usually markdown with
 * fenced code blocks — render them properly (headings, lists, GFM tables,
 * inline code) and highlight fenced blocks via highlight.js. Inline ``code``
 * gets a subtle pill; block ```lang\n…\n``` gets a full card with a header
 * showing the language + a copy button.
 */
function CodeBlock({ inline, className, children }: CodeProps) {
  const text = String(children ?? '').replace(/\n$/, '')
  const langMatch = /language-([\w+-]+)/.exec(className ?? '')
  const lang = langMatch?.[1] ?? null

  const highlighted = useMemo(() => {
    if (inline || !text) return null
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(text, { language: lang }).value
      }
      // Auto-detect when no language was specified — feels more natural than
      // rendering plain text for snippets like `const x = 1`.
      return hljs.highlightAuto(text).value
    } catch {
      return null
    }
  }, [text, lang, inline])

  if (inline) {
    return (
      <code className="px-1.5 py-0.5 mx-0.5 rounded bg-neutral-800/80 text-[12px] text-[#e6d8a8] border border-neutral-700/50 font-mono">
        {children}
      </code>
    )
  }

  return (
    <div className="my-2 rounded-lg border border-neutral-800 overflow-hidden bg-[#0d1117]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-neutral-950/80 border-b border-neutral-800/60">
        <span className="text-[10.5px] uppercase tracking-wider text-neutral-500 font-medium">
          {lang ?? 'code'}
        </span>
        <button
          onClick={() => navigator.clipboard.writeText(text)}
          className="text-[10.5px] text-neutral-500 hover:text-neutral-300 transition-colors flex items-center gap-1"
          title="Copy"
        >
          <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          copy
        </button>
      </div>
      <pre className="overflow-x-auto text-[12px] leading-relaxed p-3 m-0">
        {highlighted
          ? <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
          : <code className="hljs text-neutral-300">{text}</code>}
      </pre>
    </div>
  )
}

export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="prose-chat text-[13.5px] text-neutral-200 leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CodeBlock,
          a: ({ node: _n, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" className="text-[#c084fc] underline underline-offset-2 hover:text-[#d8a6ff]" />
          ),
          p: ({ node: _n, ...props }) => <p className="my-1.5" {...props} />,
          ul: ({ node: _n, ...props }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5" {...props} />,
          ol: ({ node: _n, ...props }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5" {...props} />,
          li: ({ node: _n, ...props }) => <li className="marker:text-neutral-500" {...props} />,
          h1: ({ node: _n, ...props }) => <h1 className="text-[18px] font-semibold mt-3 mb-1.5" {...props} />,
          h2: ({ node: _n, ...props }) => <h2 className="text-[15.5px] font-semibold mt-3 mb-1" {...props} />,
          h3: ({ node: _n, ...props }) => <h3 className="text-[14px] font-semibold mt-2 mb-1 text-neutral-100" {...props} />,
          blockquote: ({ node: _n, ...props }) => (
            <blockquote className="border-l-2 border-neutral-600 pl-3 my-2 text-neutral-400 italic" {...props} />
          ),
          hr: () => <hr className="my-3 border-neutral-800" />,
          table: ({ node: _n, ...props }) => (
            <div className="overflow-x-auto my-2">
              <table className="border-collapse w-full text-[12.5px]" {...props} />
            </div>
          ),
          th: ({ node: _n, ...props }) => <th className="border border-neutral-800 px-2 py-1 text-left bg-neutral-900" {...props} />,
          td: ({ node: _n, ...props }) => <td className="border border-neutral-800 px-2 py-1" {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
