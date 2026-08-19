import { existsSync } from 'fs'
import { createRequire } from 'module'
import type { Plugin } from 'vite'

/**
 * Rewrites `import { Add, Close } from '@carbon/icons-react'` into per-icon
 * deep imports.
 *
 * The package barrel does not re-export the individual icon modules: it pulls
 * them out of 24 `generated/bucket-N.js` files, each holding roughly a hundred
 * icons in a single module. Rollup cannot split a module, so importing one
 * icon from a bucket retains every icon in that bucket. Alby's 45 icons are
 * spread across ~20 buckets, which is how a 45-icon dependency turned into
 * 2070 bundled components and 1.7 MB of dead SVG.
 *
 * Each `es/<Name>.js` module holds exactly one icon and imports only the
 * shared `Icon` wrapper, so going straight to them keeps the buckets out of
 * the graph entirely.
 */
const SPECIFIER = '@carbon/icons-react'

// `export { _4K }` lives in `es/4K.js` — the underscore only exists because an
// identifier cannot start with a digit.
function moduleFor(exportName: string): string {
  const file = /^_\d/.test(exportName) ? exportName.slice(1) : exportName
  return `${SPECIFIER}/es/${file}.js`
}

export function carbonDeepImports(): Plugin {
  const require = createRequire(import.meta.url)
  let root = ''
  const resolvable = new Map<string, boolean>()

  // Only rewrite names that really have their own module; anything else keeps
  // the barrel import so a typo fails the same way it does today.
  const hasModule = (name: string): boolean => {
    const cached = resolvable.get(name)
    if (cached !== undefined) return cached
    let ok = false
    try {
      ok = existsSync(require.resolve(moduleFor(name), { paths: [root] }))
    } catch {
      ok = false
    }
    resolvable.set(name, ok)
    return ok
  }

  return {
    name: 'carbon-deep-imports',
    enforce: 'pre',
    configResolved(config) {
      root = config.root
    },
    transform(code, id) {
      if (!code.includes(SPECIFIER)) return null
      if (!/\.[jt]sx?$/.test(id) || id.includes('node_modules')) return null

      const pattern = new RegExp(
        `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${SPECIFIER}['"]\\s*;?`,
        'g'
      )

      let changed = false
      const out = code.replace(pattern, (match, body: string) => {
        const kept: string[] = []
        const lines: string[] = []

        for (const raw of body.split(',')) {
          const entry = raw.trim()
          if (!entry) continue
          const [exported, local = exported] = entry.split(/\s+as\s+/).map((s) => s.trim())
          if (!hasModule(exported)) {
            kept.push(entry)
            continue
          }
          lines.push(`import ${local} from '${moduleFor(exported)}';`)
        }

        if (!lines.length) return match
        changed = true
        if (kept.length) lines.push(`import { ${kept.join(', ')} } from '${SPECIFIER}';`)
        return lines.join('')
      })

      return changed ? { code: out, map: null } : null
    }
  }
}
