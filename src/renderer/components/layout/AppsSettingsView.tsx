import { useState } from 'react'
import { ChevronLeft, Copy, TrashCan } from '@carbon/icons-react'
import { useAppStore } from '../../stores/app-store'
import {
  useApps,
  useCreateApp,
  useDeleteApp,
  useRotateAppKey,
} from '../../hooks/useIssues'
import type { AppPlatform, ReportingApp } from '../../../shared/types'

const PLATFORM_OPTIONS: AppPlatform[] = ['node', 'browser', 'javascript', 'php', 'python', 'other']

export function AppsSettingsView({ projectId }: { projectId: string }) {
  const close = useAppStore((s) => s.closeAppsSettings)
  const { data: apps = [], isLoading } = useApps(projectId)
  const createApp = useCreateApp(projectId)
  const deleteApp = useDeleteApp(projectId)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [platform, setPlatform] = useState<AppPlatform>('node')
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!name.trim()) return
    await createApp.mutateAsync({ name: name.trim(), platform })
    setCreating(false)
    setName('')
    setPlatform('node')
  }

  const selectedApp = apps.find((a) => a.id === selectedAppId) ?? null

  return (
    <div className="flex-1 flex flex-col bg-neutral-950">
      <div className="flex items-center gap-3 px-6 h-12 border-b border-neutral-900">
        <button onClick={close} className="text-neutral-400 hover:text-neutral-200">
          <ChevronLeft size={18} />
        </button>
        <h1 className="text-sm font-semibold text-neutral-200">Error tracking apps</h1>
        <div className="ml-auto">
          <button
            onClick={() => setCreating(true)}
            className="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white"
          >
            + Create app
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* List */}
        <div className="w-72 border-r border-neutral-900 overflow-y-auto shrink-0">
          {isLoading && <div className="p-4 text-xs text-neutral-500">Loading…</div>}
          {!isLoading && apps.length === 0 && !creating && (
            <div className="p-6 text-xs text-neutral-500 text-center">
              No apps yet. Create one to get a DSN.
            </div>
          )}
          <ul>
            {apps.map((a) => (
              <li
                key={a.id}
                onClick={() => setSelectedAppId(a.id)}
                className={`px-4 py-3 border-b border-neutral-900 cursor-pointer ${
                  selectedAppId === a.id ? 'bg-neutral-900' : 'hover:bg-neutral-900/50'
                }`}
              >
                <div className="text-sm text-neutral-200 truncate">{a.name}</div>
                <div className="text-[10px] text-neutral-500 uppercase tracking-wider mt-0.5">
                  {a.platform}
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Detail */}
        <div className="flex-1 overflow-y-auto">
          {creating && (
            <div className="p-6 space-y-4 border-b border-neutral-900 bg-neutral-900/30">
              <div className="text-sm font-semibold text-neutral-200">New app</div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1">Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. web-frontend"
                  className="w-full max-w-md text-sm bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-neutral-200"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1">Platform</label>
                <select
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value as AppPlatform)}
                  className="text-sm bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-neutral-200"
                >
                  {PLATFORM_OPTIONS.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleCreate}
                  disabled={!name.trim() || createApp.isPending}
                  className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white"
                >
                  Create
                </button>
                <button
                  onClick={() => { setCreating(false); setName(''); setPlatform('node') }}
                  className="text-xs px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {selectedApp && !creating && (
            <AppDetail
              key={selectedApp.id}
              app={selectedApp}
              onDelete={async () => {
                if (!confirm(`Delete app "${selectedApp.name}"? All issues and events for this app will be permanently removed.`)) return
                await deleteApp.mutateAsync(selectedApp.id)
                setSelectedAppId(null)
              }}
            />
          )}

          {!selectedApp && !creating && apps.length > 0 && (
            <div className="flex-1 flex items-center justify-center text-xs text-neutral-500 p-12">
              Select an app to see its DSN and installation snippets.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AppDetail({ app, onDelete }: { app: ReportingApp; onDelete: () => void }) {
  const rotate = useRotateAppKey()
  const dsn = app.dsn ?? `https://${app.public_key}@alby.sh/ingest/v1/${app.id}`
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    } catch { /* ignore */ }
  }

  const handleRotate = async () => {
    if (!confirm('Rotate the DSN? The old key will stop working immediately.')) return
    await rotate.mutateAsync(app.id)
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-neutral-200">{app.name}</h2>
          <span className="text-[10px] uppercase tracking-wider text-neutral-500 bg-neutral-900 px-2 py-0.5 rounded">
            {app.platform}
          </span>
        </div>
        <div className="text-xs text-neutral-500 mt-1">
          Created {new Date(app.created_at).toLocaleString()}
        </div>
      </div>

      <section>
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">DSN</div>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-xs font-mono text-neutral-200 break-all">
            {dsn}
          </code>
          <button
            onClick={() => copy('dsn', dsn)}
            className="text-xs px-2 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 flex items-center gap-1"
          >
            <Copy size={14} /> {copied === 'dsn' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="mt-2 text-[11px] text-neutral-500">
          Public key is safe to ship in browser code. Server-side you can use the same DSN.
        </div>
        <button
          onClick={handleRotate}
          disabled={rotate.isPending}
          className="mt-2 text-[11px] text-neutral-400 hover:text-neutral-200 underline"
        >
          Rotate key
        </button>
      </section>

      <section>
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">Install</div>
        <Snippet label="Node.js / TypeScript" code={NODE_SNIPPET(dsn)} copy={copy} copied={copied} />
        <Snippet label="Browser (script tag)" code={BROWSER_SNIPPET(dsn)} copy={copy} copied={copied} />
        <Snippet label="PHP (composer)" code={PHP_SNIPPET(dsn)} copy={copy} copied={copied} />
        <Snippet label="Python (pip)" code={PYTHON_SNIPPET(dsn)} copy={copy} copied={copied} />
      </section>

      <section>
        <button
          onClick={onDelete}
          className="text-xs px-3 py-1.5 rounded bg-red-900/30 hover:bg-red-900/50 text-red-300 flex items-center gap-1"
        >
          <TrashCan size={14} /> Delete app
        </button>
      </section>
    </div>
  )
}

function Snippet({ label, code, copy, copied }: { label: string; code: string; copy: (k: string, v: string) => void; copied: string | null }) {
  const key = 'snip-' + label
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-neutral-400">{label}</span>
        <button
          onClick={() => copy(key, code)}
          className="text-[11px] text-neutral-500 hover:text-neutral-300 flex items-center gap-1"
        >
          <Copy size={12} /> {copied === key ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-xs font-mono text-neutral-300 overflow-x-auto whitespace-pre">
        {code}
      </pre>
    </div>
  )
}

const NODE_SNIPPET = (dsn: string) => `npm install @alby-sh/report

import { Alby } from '@alby-sh/report'
Alby.init({ dsn: '${dsn}', release: '1.0.0' })`

const BROWSER_SNIPPET = (dsn: string) => `<!-- Auto-installed global error handler -->
<script src="https://alby.sh/report.js?key=${encodeURIComponent(dsn)}" defer></script>

<!-- Or via npm: -->
<!-- npm install @alby-sh/browser -->
<!-- import { Alby } from '@alby-sh/browser'; Alby.init({ dsn: '${dsn}' }) -->`

const PHP_SNIPPET = (dsn: string) => `composer require alby/report

use Alby\\Report\\Alby;
Alby::init(['dsn' => '${dsn}', 'release' => '1.0.0']);`

const PYTHON_SNIPPET = (dsn: string) => `pip install alby-report

import alby
alby.init(dsn='${dsn}', release='1.0.0')`
