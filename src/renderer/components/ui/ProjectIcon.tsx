import { useEffect, useMemo, useState } from 'react'
import { toSvg } from 'jdenticon'

// Real jdenticon (https://jdenticon.com) — geometric identicons with consistent
// look-and-feel across the app. We render the SVG string the library returns.
export function Identicon({ value, size = 32 }: { value: string; size?: number }) {
  const svg = useMemo(() => toSvg(value || ' ', size), [value, size])
  return (
    <span
      className="inline-flex shrink-0 rounded-sm overflow-hidden"
      style={{ width: size, height: size, lineHeight: 0 }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

export function FaviconOrIdenticon({
  url,
  seed,
  size = 24,
  className = '',
}: {
  url: string | null | undefined
  seed: string
  size?: number
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  // Reset failure flag whenever the URL changes (e.g. switching project).
  useEffect(() => {
    setFailed(false)
  }, [url])

  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        className={`rounded-sm shrink-0 ${className}`}
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
        draggable={false}
      />
    )
  }
  return <Identicon value={seed} size={size} />
}
