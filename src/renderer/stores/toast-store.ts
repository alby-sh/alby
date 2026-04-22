import { create } from 'zustand'

/** Minimal in-memory toast queue. Toasts auto-dismiss after `durationMs` unless
 *  the user clicks the action button or explicitly dismisses.
 *
 *  Used today mostly for "Sessions unpinned · Undo" style reversible actions,
 *  but generic enough to host any short non-blocking notice. Not persisted. */
export interface Toast {
  id: string
  message: string
  action?: { label: string; onClick: () => void }
  durationMs?: number
}

interface ToastState {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'id'>) => string
  dismiss: (id: string) => void
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const durationMs = toast.durationMs ?? 5000
    set((s) => ({ toasts: [...s.toasts, { ...toast, id, durationMs }] }))
    if (durationMs > 0) {
      setTimeout(() => {
        useToastStore.getState().dismiss(id)
      }, durationMs)
    }
    return id
  },
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))
