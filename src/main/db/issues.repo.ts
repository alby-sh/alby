import Database from 'better-sqlite3'
import type { Issue } from '../../shared/types'

/**
 * Write-through cache for the error-tracking `issues` table. Only issue
 * aggregates are cached; full events stream straight through cloudClient
 * (they're append-only and too large to mirror locally without pressure).
 */
export class IssuesRepo {
  constructor(private db: Database.Database) {}

  listForApp(appId: string): Issue[] {
    return this.db
      .prepare(
        `SELECT * FROM issues WHERE app_id = ? ORDER BY last_seen_at DESC NULLS LAST`
      )
      .all(appId) as Issue[]
  }

  get(id: string): Issue | null {
    return (this.db.prepare(`SELECT * FROM issues WHERE id = ?`).get(id) as Issue | undefined) ?? null
  }

  upsertFromCloud(issue: Issue): void {
    this.db
      .prepare(
        `INSERT INTO issues
           (id, app_id, fingerprint, title, culprit, description, kind, analysis,
            source, created_by_user_id, status, resolved_in_release_id,
            level, occurrences_count, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES
           (@id, @app_id, @fingerprint, @title, @culprit, @description, @kind, @analysis,
            @source, @created_by_user_id, @status, @resolved_in_release_id,
            @level, @occurrences_count, @first_seen_at, @last_seen_at, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           culprit = excluded.culprit,
           description = excluded.description,
           kind = excluded.kind,
           analysis = excluded.analysis,
           source = excluded.source,
           created_by_user_id = excluded.created_by_user_id,
           status = excluded.status,
           resolved_in_release_id = excluded.resolved_in_release_id,
           level = excluded.level,
           occurrences_count = excluded.occurrences_count,
           first_seen_at = excluded.first_seen_at,
           last_seen_at = excluded.last_seen_at,
           updated_at = excluded.updated_at`
      )
      .run({
        id: issue.id,
        app_id: issue.app_id,
        fingerprint: issue.fingerprint,
        title: issue.title,
        culprit: issue.culprit ?? null,
        description: issue.description ?? null,
        kind: issue.kind ?? 'bug',
        analysis: issue.analysis ?? null,
        source: issue.source ?? 'sdk',
        created_by_user_id: issue.created_by_user_id ?? null,
        status: issue.status,
        resolved_in_release_id: issue.resolved_in_release_id ?? null,
        level: issue.level,
        occurrences_count: issue.occurrences_count ?? 0,
        first_seen_at: issue.first_seen_at ?? null,
        last_seen_at: issue.last_seen_at ?? null,
        created_at: issue.created_at ?? null,
        updated_at: issue.updated_at ?? null,
      })
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM issues WHERE id = ?`).run(id)
  }

  replaceAllForApp(appId: string, issues: Issue[]): void {
    const tx = this.db.transaction((items: Issue[]) => {
      this.db.prepare(`DELETE FROM issues WHERE app_id = ?`).run(appId)
      for (const i of items) this.upsertFromCloud(i)
    })
    tx(issues)
  }

  /** Fast count of unresolved issues per app — used by sidebar badge. */
  openCountByApp(appIds: string[]): Map<string, number> {
    const out = new Map<string, number>()
    if (!appIds.length) return out
    const placeholders = appIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT app_id, COUNT(*) AS n FROM issues
         WHERE status IN ('open','resolved_in_next_release') AND app_id IN (${placeholders})
         GROUP BY app_id`
      )
      .all(...appIds) as Array<{ app_id: string; n: number }>
    for (const r of rows) out.set(r.app_id, r.n)
    return out
  }
}
