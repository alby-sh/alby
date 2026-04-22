import { useState, useEffect } from 'react'

/**
 * Avatar rendering with a robust fallback.
 *
 * Why: Google's `lh3.googleusercontent.com/...=s96-c` URLs periodically
 * stop working — OAuth responses embed a token that Google eventually
 * rotates, and old rows in our DB still reference it. An <img> with a
 * stale URL shows the browser's broken-image glyph forever. The real fix
 * is to re-host the avatar on alby.sh (backend work), but we also need a
 * client-side net so users never see the broken glyph: on load-error we
 * swap in an initials bubble with a deterministic gradient.
 */
export function UserAvatar({
  url,
  name,
  size = 28,
  className = '',
  alt,
  title,
}: {
  url?: string | null
  name?: string | null
  /** Pixel size. Both width + height set to this. */
  size?: number
  /** Extra classes applied to the root element (e.g. `ring-2`). */
  className?: string
  alt?: string
  title?: string
}) {
  const [broken, setBroken] = useState(false)
  // Reset the "broken" flag when the URL changes so a successful update
  // can recover after a prior failure.
  useEffect(() => { setBroken(false) }, [url])

  if (url && !broken) {
    return (
      <img
        src={url}
        alt={alt ?? name ?? ''}
        title={title ?? name ?? undefined}
        onError={() => setBroken(true)}
        className={`rounded-full object-cover bg-neutral-800 ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }
  const initials = (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?'
  // Deterministic gradient per name so the same user keeps the same
  // bubble colour across the app (no jarring re-paint when the image
  // fails on one view but loaded on another).
  const hue = hashToHue(name ?? '?')
  const fontSize = Math.max(9, Math.round(size * 0.42))
  return (
    <span
      title={title ?? name ?? undefined}
      className={`rounded-full text-white font-semibold flex items-center justify-center select-none ${className}`}
      style={{
        width: size,
        height: size,
        fontSize,
        background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 35) % 360} 65% 45%))`,
      }}
    >
      {initials}
    </span>
  )
}

function hashToHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}
