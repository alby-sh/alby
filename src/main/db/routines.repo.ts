import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import type { Routine, CreateRoutineDTO, UpdateRoutineDTO } from '../../shared/types'

export class RoutinesRepo {
  constructor(private db: Database.Database) {}

  list(): Routine[] {
    return this.db
      .prepare('SELECT * FROM routines ORDER BY environment_id, sort_order, created_at')
      .all() as Routine[]
  }

  listByEnvironment(environmentId: string): Routine[] {
    return this.db
      .prepare('SELECT * FROM routines WHERE environment_id = ? ORDER BY sort_order, created_at')
      .all(environmentId) as Routine[]
  }

  get(id: string): Routine | undefined {
    return this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Routine | undefined
  }

  create(data: CreateRoutineDTO): Routine {
    const id = uuid()
    const maxOrder = (
      this.db
        .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM routines WHERE environment_id = ?')
        .get(data.environment_id) as { m: number }
    ).m
    this.db
      .prepare(
        `INSERT INTO routines (
           id, environment_id, name, cron_expression, interval_seconds,
           agent_type, prompt, enabled, sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        id,
        data.environment_id,
        data.name,
        data.cron_expression ?? null,
        data.interval_seconds ?? null,
        data.agent_type,
        data.prompt,
        maxOrder + 1
      )
    return this.get(id)!
  }

  update(id: string, data: UpdateRoutineDTO): Routine {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`)
        values.push(value)
      }
    }
    if (fields.length > 0) {
      values.push(id)
      this.db.prepare(`UPDATE routines SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }
    return this.get(id)!
  }

  markRunning(id: string, tmuxSessionName: string): void {
    this.db
      .prepare('UPDATE routines SET tmux_session_name = ?, last_run_at = datetime(\'now\') WHERE id = ?')
      .run(tmuxSessionName, id)
  }

  markStopped(id: string, exitCode?: number | null): void {
    this.db
      .prepare('UPDATE routines SET tmux_session_name = NULL, last_exit_code = ? WHERE id = ?')
      .run(exitCode ?? null, id)
  }

  listRunning(): Routine[] {
    return this.db
      .prepare('SELECT * FROM routines WHERE tmux_session_name IS NOT NULL')
      .all() as Routine[]
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM routines WHERE id = ?').run(id)
  }

  /** Rewrite sort_order for every routine in `orderedIds` so their index in
   *  the array becomes their new sort_order. `environmentId` is used both as
   *  a safety scope (only rows in that env are touched) and to match how the
   *  projects.repo reorder helpers are shaped.
   */
  reorderRoutines(environmentId: string, orderedIds: string[]): void {
    const stmt = this.db.prepare(
      'UPDATE routines SET sort_order = ? WHERE id = ? AND environment_id = ?'
    )
    const tx = this.db.transaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id, environmentId))
    })
    tx()
  }

  /**
   * Mirror a routine fetched from the cloud API into the local cache so the
   * RoutineManager (which still reads local SQLite for runtime state) stays
   * in sync with cross-device edits.
   */
  upsertFromCloud(routine: Routine): void {
    this.db
      .prepare(
        `INSERT INTO routines (
           id, environment_id, name, cron_expression, interval_seconds,
           agent_type, prompt, enabled, sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           environment_id = excluded.environment_id,
           name = excluded.name,
           cron_expression = excluded.cron_expression,
           interval_seconds = excluded.interval_seconds,
           agent_type = excluded.agent_type,
           prompt = excluded.prompt,
           enabled = excluded.enabled,
           sort_order = excluded.sort_order`
      )
      .run(
        routine.id,
        routine.environment_id,
        routine.name,
        routine.cron_expression ?? null,
        routine.interval_seconds ?? null,
        routine.agent_type,
        routine.prompt,
        routine.enabled ? 1 : 0,
        routine.sort_order ?? 0
      )
  }
}
