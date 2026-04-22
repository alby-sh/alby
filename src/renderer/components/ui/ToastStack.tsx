import { Close } from '@carbon/icons-react'
import { useToastStore } from '../../stores/toast-store'

/** Bottom-right toast stack. Mounted once at the app root; the store is the
 *  source of truth. Click the action (if any) to run the callback + dismiss,
 *  click the × to dismiss immediately. Auto-dismiss is handled in the store. */
export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-[80] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-3 min-w-[240px] max-w-[420px] rounded-lg border border-neutral-800 bg-neutral-900/95 shadow-xl px-3 py-2 text-[13px] text-neutral-100 backdrop-blur"
        >
          <span className="flex-1 truncate">{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action!.onClick()
                dismiss(t.id)
              }}
              className="shrink-0 text-[12px] font-medium text-blue-300 hover:text-blue-200"
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            className="shrink-0 size-5 flex items-center justify-center rounded hover:bg-neutral-800 text-neutral-500 hover:text-neutral-200"
          >
            <Close size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
