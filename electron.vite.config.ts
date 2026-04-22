import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
    plugins: [react(), tailwindcss()],
    build: {
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
