export const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'remote',
  favicon_url TEXT,
  url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stacks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT,
  kind TEXT NOT NULL DEFAULT 'custom',
  favicon_url TEXT,
  git_remote_url TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  auto_fix_enabled INTEGER NOT NULL DEFAULT 0,
  auto_fix_agent_type TEXT NOT NULL DEFAULT 'claude',
  auto_fix_target_env_id TEXT,
  auto_fix_max_per_day INTEGER NOT NULL DEFAULT 5,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS stacks_project_idx ON stacks (project_id, sort_order);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stack_id TEXT REFERENCES stacks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'remote',
  role TEXT NOT NULL DEFAULT 'operational',
  platform TEXT NOT NULL DEFAULT 'linux',
  ssh_host TEXT NOT NULL DEFAULT '',
  ssh_user TEXT,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  ssh_key_path TEXT,
  ssh_auth_method TEXT NOT NULL DEFAULT 'key',
  ssh_password TEXT,
  remote_path TEXT NOT NULL,
  agent_settings TEXT,
  deploy_config TEXT,
  git_remote_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  context_notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tab_name TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  prompt TEXT,
  exit_code INTEGER,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- For chat-type agents: the claude-code session id, used to resume the
  -- conversation with --resume after the process has exited.
  chat_session_id TEXT
);

-- Per-chat transcript log. Every JSON event the CLI streams is appended
-- here so the ChatPanel can replay the conversation when the tab is
-- re-selected or the app restarts, even after the process has died.
CREATE TABLE IF NOT EXISTS chat_transcripts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS chat_transcripts_agent_idx ON chat_transcripts (agent_id, seq);

CREATE TABLE IF NOT EXISTS custom_ssh_hosts (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL,
  user TEXT NOT NULL DEFAULT 'root',
  port INTEGER NOT NULL DEFAULT 22,
  identity_file TEXT
);

CREATE TABLE IF NOT EXISTS agent_summaries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ui_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  agent_type TEXT NOT NULL DEFAULT 'claude',
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  tmux_session_name TEXT,
  last_run_at TEXT,
  last_exit_code INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Error-tracking: cache mirror of cloud state for fast UI reads + offline view.
-- The backend remains the source of truth; these tables are populated by
-- upsertFromCloud calls in the IPC handlers.
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'other',
  public_key TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS apps_project_idx ON apps (project_id);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  culprit TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_in_release_id TEXT,
  level TEXT NOT NULL DEFAULT 'error',
  occurrences_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT,
  last_seen_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS issues_app_status_idx ON issues (app_id, status, last_seen_at DESC);
`
