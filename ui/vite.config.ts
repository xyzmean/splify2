import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // ── React -> Preact at BUILD time (source stays plain React) ───────────
      // The dashboard is served by uhttpd, which does NOT gzip: whatever the
      // bundle weighs on disk is what every router client downloads, and it is
      // parsed by a router-class browser client over router-class Wi-Fi. The
      // React 19 vendor chunk alone was 236KB — bigger than the rest of the app,
      // the CSS and every icon combined, for a page whose entire UI is cards,
      // tables and buttons.
      //
      // preact/compat implements the same API surface we use (hooks, StrictMode,
      // createRoot, forwardRef via lucide-react) at roughly a fifth of the size.
      // Aliasing here rather than rewriting imports keeps every source file, and
      // the @types/react typings tsc checks against, exactly as they were — so
      // this is reversible by deleting these four lines.
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react-dom/client": "preact/compat/client",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
  build: {
    // No <link rel=modulepreload> is ever emitted into a LuCI page — the loader
    // shim injects one <script type=module> by hand — so Vite's preload machinery
    // is dead weight here. Disabled outright rather than just skipping the
    // polyfill: it also emits a dependency table of BARE chunk names next to each
    // dynamic import, and those names carry no ?v=, so a stale cache could be
    // asked for the wrong copy of a lazily loaded tab.
    modulePreload: false,
    rollupOptions: {
      // Two independent SPA bundles, one per LuCI view: "Главная" (status
      // dashboard) and "Дополнительно" (settings, formerly a form.Map page).
      // One bundle: the new UI is a single dashboard with tabs, not two LuCI views.
      input: { index: path.resolve(__dirname, "index.html") },
      output: {
        entryFileNames: `splify-[name].js`,
        chunkFileNames: `splify-[name].js`,
        assetFileNames: (info) =>
          info.name?.endsWith('.css') ? 'splify-index.[ext]' : 'splify-[name].[ext]',
        // The shared chunk's NAME IS AN INTERFACE, not an implementation detail:
        // build.sh pins `splify-x.js?v=<version>` inside both entry bundles so a
        // stale HTTP cache can never pair a new entry with an old chunk. Left to
        // rollup, that name is derived from whichever module happens to lead the
        // shared graph (it silently became "splify-notify.js" when a new import
        // was added), and the pinning sed would quietly match nothing. So route
        // everything shared into one explicitly named chunk. scripts/check-dist.mjs
        // fails the build if the emitted file list ever drifts from this.
        manualChunks(id) {
          if (id.includes('node_modules')) return 'x'
          // Modules imported by BOTH the dashboard and the settings entry.
          // `validate` попал сюда в запуске 46: до подключения валидаторов к формам его не
          // импортировал никто, а теперь его читают и главный бандл (VlessPanel, ObfsPanel), и
          // ленивая вкладка правил (RuleEditor) — то есть он стал общим, и rollup выделил его в
          // собственный кусок `splify-validate.js`, у которого нет пина `?v=`. Барьер
          // scripts/check-dist.mjs это и остановил.
          if (/[\\/]src[\\/]lib[\\/](notify|utils|i18n|rpc|uci|tw-merge|validate)\./.test(id)) return 'x'
          if (/[\\/]src[\\/]components[\\/]ui[\\/]/.test(id)) return 'x'
          return undefined
        },
      }
    }
  }
})
