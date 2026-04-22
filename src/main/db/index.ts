import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { SCHEMA } from './schema'

let db: Database.Database | null = null

export function initDatabase(): Database.Database {
  if (db) return db

  const userDataPath = app.getPath('userData')
  mkdirSync(userDataPath, { recursive: true })
  const dbPath = join(userDataPath, 'data.db')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)

  // Migrations for existing databases
  const columns = db.prepare("PRAGMA table_info('projects')").all() as { name: string }[]
  if (!columns.some((c) => c.name === 'favicon_url')) {
    db.exec('ALTER TABLE projects ADD COLUMN favicon_url TEXT')
  }
  if (!columns.some((c) => c.name === 'url')) {
    db.exec('ALTER TABLE projects ADD COLUMN url TEXT')
  }
  if (!columns.some((c) => c.name === 'pinned')) {
    db.exec('ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
  }

  const envColumns = db.prepare("PRAGMA table_info('environments')").all() as { name: string }[]
  if (!envColumns.some((c) => c.name === 'stack_id')) {
    db.exec('ALTER TABLE environments ADD COLUMN stack_id TEXT')
  }
  if (!envColumns.some((c) => c.name === 'agent_settings')) {
    db.exec('ALTER TABLE environments ADD COLUMN agent_settings TEXT')
  }
  if (!envColumns.some((c) => c.name === 'git_remote_url')) {
    db.exec('ALTER TABLE environments ADD COLUMN git_remote_url TEXT')
  }
  if (!envColumns.some((c) => c.name === 'execution_mode')) {
    db.exec("ALTER TABLE environments ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'remote'")
  }
  if (!envColumns.some((c) => c.name === 'role')) {
    db.exec("ALTER TABLE environments ADD COLUMN role TEXT NOT NULL DEFAULT 'operational'")
  }
  if (!envColumns.some((c) => c.name === 'platform')) {
    db.exec("ALTER TABLE environments ADD COLUMN platform TEXT NOT NULL DEFAULT 'linux'")
  }
  if (!envColumns.some((c) => c.name === 'deploy_config')) {
    db.exec('ALTER TABLE environments ADD COLUMN deploy_config TEXT')
  }
  if (!envColumns.some((c) => c.name === 'ssh_auth_method')) {
    db.exec("ALTER TABLE environments ADD COLUMN ssh_auth_method TEXT NOT NULL DEFAULT 'key'")
  }
  if (!envColumns.some((c) => c.name === 'ssh_password')) {
    db.exec('ALTER TABLE environments ADD COLUMN ssh_password TEXT')
  }
  if (!envColumns.some((c) => c.name === 'launch_command')) {
    db.exec('ALTER TABLE environments ADD COLUMN launch_command TEXT')
  }

  const taskColumns = db.prepare("PRAGMA table_info('tasks')").all() as { name: string }[]
  if (!taskColumns.some((c) => c.name === 'is_default')) {
    db.exec('ALTER TABLE tasks ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0')
  }

  // Relax cron_expression / interval_seconds to nullable on existing
  // installations so manual-only routines can be saved (schema above already
  // declares them nullable, but pre-existing tables keep their NOT NULL).
  // SQLite has no ALTER COLUMN, so we detect via PRAGMA and rebuild once.
  const routineCols = db.prepare("PRAGMA table_info('routines')").all() as Array<{ name: string; notnull: number }>
  const cronCol = routineCols.find((c) => c.name === 'cron_expression')
  const intervalCol = routineCols.find((c) => c.name === 'interval_seconds')
  if ((cronCol && cronCol.notnull === 1) || (intervalCol && intervalCol.notnull === 1)) {
    db.exec(`
      CREATE TABLE routines_new (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        cron_expression TEXT,
        interval_seconds INTEGER,
        agent_type TEXT NOT NULL DEFAULT 'claude',
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        tmux_session_name TEXT,
        last_run_at TEXT,
        last_exit_code INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO routines_new
        SELECT id, environment_id, name, cron_expression, interval_seconds,
               agent_type, prompt, enabled, tmux_session_name, last_run_at,
               last_exit_code, sort_order, created_at
        FROM routines;
      DROP TABLE routines;
      ALTER TABLE routines_new RENAME TO routines;
    `)
  }

  const agentColumns = db.prepare("PRAGMA table_info('agents')").all() as { name: string }[]
  if (!agentColumns.some((c) => c.name === 'chat_session_id')) {
    db.exec('ALTER TABLE agents ADD COLUMN chat_session_id TEXT')
  }
  if (!agentColumns.some((c) => c.name === 'sort_order')) {
    db.exec('ALTER TABLE agents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
    // Backfill existing rows so they keep their creation order instead of all
    // collapsing to sort_order=0 (which would make every new reorder start
    // from a messy mixed state).
    db.exec(`
      WITH ordered AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY created_at) - 1 AS n
        FROM agents
      )
      UPDATE agents SET sort_order = (SELECT n FROM ordered WHERE ordered.id = agents.id)
    `)
  }

  return db
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}
