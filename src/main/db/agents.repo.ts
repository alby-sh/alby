import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import type { Agent, AgentStatus } from '../../shared/types'

export class AgentsRepo {
  constructor(private db: Database.Database) {}

  list(taskId: string): Agent[] {
    return this.db
      .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY sort_order, created_at')
      .all(taskId) as Agent[]
  }

  get(id: string): Agent | undefined {
    return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined
  }

  create(data: {
    task_id: string
    tab_name: string
    status: AgentStatus
    prompt: string
    started_at: string
    /** v0.8.3: device ownership fields. Always populated by AgentManager
     *  when it creates a new agent — identifies which Mac owns the PTY so
     *  other devices can render the row as read-only. */
    device_id?: string
    device_name?: string
    execution_mode?: 'local' | 'remote'
  }): Agent {
    const id = uuid()
    // New agents go to the bottom of the task's list — same convention as
    // RoutinesRepo.create. Without this, back-to-back spawns all share
    // sort_order=0 and the reorder operation can't tell them apart.
    const nextOrder = (
      this.db
        .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM agents WHERE task_id = ?')
        .get(data.task_id) as { m: number }
    ).m + 1
    this.db
      .prepare(
        `INSERT INTO agents (id, task_id, tab_name, status, prompt, started_at, sort_order, device_id, device_name, execution_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.task_id,
        data.tab_name,
        data.status,
        data.prompt,
        data.started_at,
        nextOrder,
        data.device_id ?? null,
        data.device_name ?? null,
        data.execution_mode ?? null,
      )
    return this.get(id)!
  }

  updateTabName(id: string, tabName: string): void {
    this.db.prepare('UPDATE agents SET tab_name = ? WHERE id = ?').run(tabName, id)
  }

  updateStatus(id: string, status: AgentStatus, exitCode?: number): void {
    if (status === 'completed' || status === 'error') {
      this.db
        .prepare(
          'UPDATE agents SET status = ?, exit_code = ?, finished_at = datetime(\'now\') WHERE id = ?'
        )
        .run(status, exitCode ?? null, id)
    } else {
      this.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id)
    }
  }

  countByTask(taskId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) as c FROM agents WHERE task_id = ?').get(taskId) as {
        c: number
      }
    ).c
  }

  listAll(): Agent[] {
    // JOIN so each agent carries project_id — renderer needs it to filter per-project
    return this.db
      .prepare(
        `SELECT a.*, e.project_id AS project_id
         FROM agents a
         JOIN tasks t ON t.id = a.task_id
         JOIN environments e ON e.id = t.environment_id
         ORDER BY a.sort_order, a.created_at`
      )
      .all() as Agent[]
  }

  listRunning(): Agent[] {
    return this.db
      .prepare("SELECT * FROM agents WHERE status = 'running' ORDER BY created_at")
      .all() as Agent[]
  }

  markAllRunningAsDisconnected(): void {
    this.db
      .prepare("UPDATE agents SET status = 'error', exit_code = -2 WHERE status = 'running'")
      .run()
  }

  /** Mirror a cloud-sourced agent into the local cache.
   *
   * sort_order is intentionally NOT copied from the cloud payload — the
   * cloud API doesn't track per-user sidebar order yet (Phase 2 will add
   * that). We leave the local column untouched on update so user-initiated
   * reorders survive subsequent cloud sync pulls. New inserts fall back to
   * the bottom of the task via a COALESCE over the existing max.
   */
  upsertFromCloud(agent: Agent): void {
    const nextOrder = (
      this.db
        .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM agents WHERE task_id = ?')
        .get(agent.task_id) as { m: number }
    ).m + 1
    this.db
      .prepare(
        `INSERT INTO agents (id, task_id, tab_name, status, prompt, exit_code, started_at, finished_at, sort_order, device_id, device_name, execution_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id,
           tab_name = excluded.tab_name,
           status = excluded.status,
           prompt = excluded.prompt,
           exit_code = excluded.exit_code,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           device_id = COALESCE(excluded.device_id, agents.device_id),
           device_name = COALESCE(excluded.device_name, agents.device_name),
           execution_mode = COALESCE(excluded.execution_mode, agents.execution_mode)`
      )
      .run(
        agent.id,
        agent.task_id,
        agent.tab_name ?? null,
        agent.status,
        agent.prompt ?? null,
        agent.exit_code ?? null,
        agent.started_at ?? null,
        agent.finished_at ?? null,
        nextOrder,
        agent.device_id ?? null,
        agent.device_name ?? null,
        agent.execution_mode ?? null,
      )
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
  }

  /** Rewrite sort_order for every agent in `orderedIds` so their index in the
   *  array becomes their new sort_order. Caller supplies ids that all belong
   *  to the same env (SessionsSubTree scope); we don't enforce that because
   *  agents' env lookup requires a JOIN and reorder happens often.
   */
  reorderAgents(orderedIds: string[]): void {
    const stmt = this.db.prepare('UPDATE agents SET sort_order = ? WHERE id = ?')
    const tx = this.db.transaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id))
    })
    tx()
  }

  /* ======================= Chat-specific helpers ======================= */

  getChatSessionId(agentId: string): string | null {
    const row = this.db
      .prepare('SELECT chat_session_id FROM agents WHERE id = ?')
      .get(agentId) as { chat_session_id: string | null } | undefined
    return row?.chat_session_id ?? null
  }

  setChatSessionId(agentId: string, sessionId: string): void {
    this.db
      .prepare('UPDATE agents SET chat_session_id = ? WHERE id = ?')
      .run(sessionId, agentId)
  }

  /** Returns the next sequence number to use when appending a transcript event. */
  nextTranscriptSeq(agentId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS max_seq FROM chat_transcripts WHERE agent_id = ?')
      .get(agentId) as { max_seq: number }
    return (row?.max_seq ?? -1) + 1
  }

  appendTranscript(agentId: string, seq: number, eventJson: string): void {
    this.db
      .prepare(
        'INSERT INTO chat_transcripts (id, agent_id, seq, event_json) VALUES (?, ?, ?, ?)'
      )
      .run(`${agentId}:${seq}`, agentId, seq, eventJson)
  }

  listTranscript(agentId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare('SELECT event_json FROM chat_transcripts WHERE agent_id = ? ORDER BY seq ASC')
      .all(agentId) as { event_json: string }[]
    return rows.map((r) => {
      try { return JSON.parse(r.event_json) as Record<string, unknown> } catch { return { type: 'stderr', data: r.event_json } }
    })
  }

  /** Delete transcript but leave the agent row intact. */
  clearTranscript(agentId: string): void {
    this.db.prepare('DELETE FROM chat_transcripts WHERE agent_id = ?').run(agentId)
  }
}
