/**
 * Removes ssh2's optional `cpu-features` dependency before the native rebuild.
 *
 * cpu-features is built on nan, which does not compile against the V8 shipped
 * with Electron 43 (`PropertyCallbackInfo::This()` and friends are gone), and
 * 0.0.10 is the last release. ssh2 declares it optional and falls back to
 * Node's own crypto when it is missing — the only cost is that it stops
 * probing the CPU for accelerated cipher selection, which is not measurable
 * against SSH session setup.
 *
 * npm tolerates an optional dependency that fails to build, but
 * @electron/rebuild treats it as fatal and electron-builder exposes no ignore
 * list, so the package has to be gone before the rebuild runs.
 */
import { rmSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'node_modules', 'cpu-features')

if (existsSync(target)) {
  rmSync(target, { recursive: true, force: true })
  console.log('[strip-cpu-features] removed node_modules/cpu-features (nan is incompatible with Electron 43)')
}
