import Database from 'better-sqlite3'
import type { AppPlatform, ReportingApp } from '../../shared/types'

/** Shape of a row as stored in SQLite (is_active is an int). */
interface AppRow {
  id: string
  project_id: string
  name: string
  platform: AppPlatform
  public_key: string
  is_active: number
  created_at: string | null
  updated_at: string | null
}

/**
 * Write-through cache for the error-tracking `apps` table.
 * The backend at alby.sh is authoritative — this repo exists so the renderer
 * can render something immediately on cold start and while offline.
 */
export class AppsRepo {
  constructor(private db: Database.Database) {}

  list(projectId: string): ReportingApp[] {
    const rows = this.db
      .prepare(`SELECT * FROM apps WHERE project_id = ? ORDER BY created_at DESC`)
      .all(projectId) as AppRow[]
    return rows.map(coerce)
  }

  get(id: string): ReportingApp | null {
    const row = this.db.prepare(`SELECT * FROM apps WHERE id = ?`).get(id) as AppRow | undefined
    return row ? coerce(row) : null
  }

  upsertFromCloud(app: ReportingApp): void {
    this.db
      .prepare(
        `INSERT INTO apps (id, project_id, name, platform, public_key, is_active, created_at, updated_at)
         VALUES (@id, @project_id, @name, @platform, @public_key, @is_active, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           name = excluded.name,
           platform = excluded.platform,
           public_key = excluded.public_key,
           is_active = excluded.is_active,
           updated_at = excluded.updated_at`
      )
      .run({
        id: app.id,
        project_id: app.project_id,
        name: app.name,
        platform: app.platform,
        public_key: app.public_key,
        is_active: app.is_active ? 1 : 0,
        created_at: app.created_at ?? null,
        updated_at: app.updated_at ?? null,
      })
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM apps WHERE id = ?`).run(id)
  }

  replaceAllForProject(projectId: string, apps: ReportingApp[]): void {
    const tx = this.db.transaction((items: ReportingApp[]) => {
      this.db.prepare(`DELETE FROM apps WHERE project_id = ?`).run(projectId)
      for (const a of items) this.upsertFromCloud(a)
    })
    tx(apps)
  }
}

function coerce(row: AppRow): ReportingApp {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    platform: row.platform,
    public_key: row.public_key,
    is_active: !!row.is_active,
    created_at: row.created_at ?? '',
    updated_at: row.updated_at ?? '',
  }
}
