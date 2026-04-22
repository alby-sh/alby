import { cloneElement, forwardRef, useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type Side = 'right' | 'top' | 'bottom' | 'left'

interface TriggerProps {
  onEnter: () => void
  onLeave: () => void
  children: React.ReactElement
}

const TooltipTrigger = forwardRef<HTMLElement, TriggerProps>(
  function TooltipTrigger({ onEnter, onLeave, children }, ref) {
    const child = children as React.ReactElement<{
      ref?: React.Ref<HTMLElement>
      onMouseEnter?: (e: React.MouseEvent) => void
      onMouseLeave?: (e: React.MouseEvent) => void
    }>
    return cloneElement(child, {
      ref: ref as React.Ref<HTMLElement>,
      onMouseEnter: (e: React.MouseEvent) => {
        child.props.onMouseEnter?.(e)
        onEnter()
      },
      onMouseLeave: (e: React.MouseEvent) => {
        child.props.onMouseLeave?.(e)
        onLeave()
      },
    })
  }
)

interface Props {
  label: string
  side?: Side
  children: React.ReactElement
}

// Zero-delay tooltip rendered through a body portal so it is never clipped by
// scrolling parents (e.g. the icon sidebar's scrollable project list).
// Wraps a single child and forwards mouse events via cloneElement so we don't
// add an extra DOM box that would change layout.
export function InstantTooltip({ label, side = 'right', children }: Props) {
  const triggerRef = useRef<HTMLElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const updatePos = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let top = r.top + r.height / 2
    let left = r.right + 8
    if (side === 'left') { left = r.left - 8 }
    if (side === 'top') { top = r.top - 8; left = r.left + r.width / 2 }
    if (side === 'bottom') { top = r.bottom + 8; left = r.left + r.width / 2 }
    setPos({ top, left })
  }, [side])

  const onEnter = useCallback(() => updatePos(), [updatePos])
  const onLeave = useCallback(() => setPos(null), [])

  const transform =
    side === 'left' ? 'translate(-100%, -50%)'
    : side === 'top' ? 'translate(-50%, -100%)'
    : side === 'bottom' ? 'translate(-50%, 0)'
    : 'translateY(-50%)'

  return (
    <>
      <TooltipTrigger ref={triggerRef} onEnter={onEnter} onLeave={onLeave}>
        {children}
      </TooltipTrigger>
      {pos && createPortal(
        <div
          className="fixed z-[100] pointer-events-none px-2 py-1 rounded-md bg-neutral-800 text-neutral-50 text-[12px] font-medium shadow-lg border border-neutral-700/60 whitespace-nowrap"
          style={{ top: pos.top, left: pos.left, transform }}
        >
          {label}
        </div>,
        document.body
      )}
    </>
  )
}
