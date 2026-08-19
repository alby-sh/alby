import { clipboard, ipcMain } from 'electron'

/**
 * Clipboard access for the renderer.
 *
 * `navigator.clipboard` is only defined in a secure context. In development
 * the renderer is served from http://localhost, so it is there; the packaged
 * app loads it with `loadFile`, which means a `file://` origin, and the whole
 * API is missing. Copy did nothing in every shipped build — and because the
 * call sites neither awaited nor caught it, the failure was silent while the
 * selection was cleared right after, so it looked like the copy had worked.
 *
 * Electron's own clipboard module has no such restriction, so everything goes
 * through here rather than the web API.
 */
export function registerClipboardIPC(): void {
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    if (typeof text !== 'string' || text.length === 0) return false
    clipboard.writeText(text)
    return true
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())
}
