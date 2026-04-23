import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import type { Routine, CreateRoutineDTO, UpdateRoutineDTO } from '../../shared/types'

/** The raw row as SQLite stores it — allowed_users is a JSON string. */
interface RoutineRow extends Omit<Routine, 'allowed_user_ids'> {
  allowed_users: string | null
}

function rowToRoutine(row: RoutineRow | undefined): Routine | undefined {
  if (!row) return undefined
  let allowed: number[] | null = null
  if (row.allowed_users) {
    try {
      const parsed = JSON.parse(row.allowed_users)
      if (Array.isArray(parsed)) allowed = parsed.filter((n) => typeof n === 'number')
    } catch { /* malformed JSON — treat as no allow-list */ }
  }
  // Strip the raw column and expose the parsed array under the canonical name.
  const { allowed_users: _ignored, ...rest } = row
  void _ignored
  return { ...rest, allowed_user_ids: allowed } as Routine
}

function stringifyAllowed(ids: number[] | null | undefined): string | null {
  if (!ids || !Array.isArray(ids) || ids.length === 0) return null
  return JSON.stringify(ids.filter((n) => typeof n === 'number'))
}

export class RoutinesRepo {
  constructor(private db: Database.Database) {}

  list(): Routine[] {
    return (this.db
      .prepare('SELECT * FROM routines ORDER BY environment_id, sort_order, created_at')
      .all() as RoutineRow[])
      .map((r) => rowToRoutine(r)!)
  }

  listByEnvironment(environmentId: string): Routine[] {
    return (this.db
      .prepare('SELECT * FROM routines WHERE environment_id = ? ORDER BY sort_order, created_at')
      .all(environmentId) as RoutineRow[])
      .map((r) => rowToRoutine(r)!)
  }

  get(id: string): Routine | undefined {
    return rowToRoutine(this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined)
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
           agent_type, prompt, enabled, sort_order, allowed_users
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        id,
        data.environment_id,
        data.name,
        data.cron_expression ?? null,
        data.interval_seconds ?? null,
        data.agent_type,
        data.prompt,
        maxOrder + 1,
        stringifyAllowed(data.allowed_user_ids)
      )
    return this.get(id)!
  }

  update(id: string, data: UpdateRoutineDTO): Routine {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue
      if (key === 'allowed_user_ids') {
        // Translate the public field into the internal TEXT column.
        fields.push('allowed_users = ?')
        values.push(stringifyAllowed(value as number[] | null | undefined))
        continue
      }
      fields.push(`${key} = ?`)
      values.push(value)
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
    return (this.db
      .prepare('SELECT * FROM routines WHERE tmux_session_name IS NOT NULL')
      .all() as RoutineRow[])
      .map((r) => rowToRoutine(r)!)
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
           agent_type, prompt, enabled, sort_order, allowed_users
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           environment_id = excluded.environment_id,
           name = excluded.name,
           cron_expression = excluded.cron_expression,
           interval_seconds = excluded.interval_seconds,
           agent_type = excluded.agent_type,
           prompt = excluded.prompt,
           enabled = excluded.enabled,
           sort_order = excluded.sort_order,
           allowed_users = excluded.allowed_users`
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
        routine.sort_order ?? 0,
        stringifyAllowed(routine.allowed_user_ids ?? null)
      )
  }
}
