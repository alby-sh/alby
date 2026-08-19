import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { carbonDeepImports } from './scripts/carbon-deep-imports'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['better-sqlite3', 'ssh2', 'ssh-config', 'node-pty', 'keytar']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer')
      }
    },
    plugins: [carbonDeepImports(), react(), tailwindcss()],
    build: {
      // electron-vite leaves the renderer unminified by default; the bundle
      // ships to disk either way, but parsing ~3 MB of readable JS on every
      // cold start is pure overhead.
      minify: 'esbuild',
      // Minified stacks are unreadable, and error-reporter.ts ships err.stack
      // to the backend. Sourcemaps land next to the bundle inside the asar:
      // they cost disk, never memory, and are only fetched when something
      // actually needs to resolve a frame.
      sourcemap: true,
      // Split the renderer bundle so the first paint doesn't carry the
      // weight of every settings/admin view at once.
      chunkSizeWarningLimit: 1024,
      rollupOptions: {
        output: {
          manualChunks(id: string): string | undefined {
            if (!id.includes('node_modules')) return undefined
            // Heavy single-purpose libraries get their own chunk so they
            // load lazily where possible and stay cached across deploys.
            if (id.includes('@xterm/')) return 'xterm'
            if (id.includes('pusher-js')) return 'pusher'
            if (id.includes('jdenticon')) return 'jdenticon'
            if (id.includes('@carbon/icons-react')) return 'icons'
            // Everything else (react, react-query, radix, zustand, …) goes
            // into a single shared vendor chunk to avoid circular splits.
            return 'vendor'
          }
        }
      }
    }
  }
})
