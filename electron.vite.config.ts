import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

/**
 * Release metadata, read from package.json at BUILD time and inlined into the
 * bundle.
 *
 * Two reasons this is not read at runtime:
 *   - the packaged app has no reliable path back to package.json;
 *   - `version` must come from the same file electron-builder uses, so the About
 *     panel cannot drift from the installer.
 *
 * `__BUILD_DATE__` is captured now, which is the honest answer to "when was this
 * build made" — `releaseDate` in package.json is the declared release and is
 * reported separately.
 */
const pkg = createRequire(import.meta.url)('./package.json') as {
  version?: string
  releaseDate?: string
  homepage?: string
}

const RELEASE = {
  version: pkg.version ?? '0.0.0',
  releaseDate: pkg.releaseDate ?? '',
  buildDate: new Date().toISOString().slice(0, 10),
  homepage: pkg.homepage ?? 'https://www.hertzinno.com',
  supportEmail: 'info@hertzinno.com'
}

/**
 * electron-vite build configuration.
 *
 * Three build targets, matching the process boundary in spec section 3.2:
 *   main     -> Electron Main Process (owns all device + disk access)
 *   preload  -> contextBridge surface (the ONLY bridge into the renderer)
 *   renderer -> Vue 3 SPA (never talks to a device IP directly)
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __RELEASE__: JSON.stringify(RELEASE)
    },
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue()],
    define: {
      // Same metadata as the main process, so the renderer can render the version
      // without a round trip and without a hard-coded string in a component.
      __RELEASE__: JSON.stringify(RELEASE),
      // Inlined at build time. The headless smoke test rebuilds with this set
      // to '1', which enables a read-only self-check probe on `window` so the
      // device-status push chain can be verified from outside the renderer.
      //
      // Defaults to '0': a shipped build contains no probe at all, rather than
      // one that is merely unreachable.
      'import.meta.env.VITE_SMOKE_PROBE': JSON.stringify(process.env.VITE_SMOKE_PROBE ?? '0')
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
