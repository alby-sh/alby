import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'

export function registerSettingsIPC(db: Database.Database): void {
  ipcMain.handle('settings:get', (_, key: string) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  })

  ipcMain.handle('settings:set', (_, key: string, value: string) => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  })
}
