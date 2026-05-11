// Bundler configuration for the desktop app.
//
// Chosen tool: `electron-vite` (see README.md § "Bundler choice"). It
// gives us three Vite roots — main, preload, renderer — wired into one
// `electron-vite build` step, with HMR for the renderer and watch
// rebuilds for main/preload during `electron-vite dev`. Compared to
// "Vite + Electron Forge" this is the lower-config option (no Forge
// makers/publishers to declare at M0) and matches the canonical
// electron-vite project layout the team is most likely to recognize.
//
// M0 ships only the entrypoint mapping — no plugins yet. Phase 1
// will add `@vitejs/plugin-react` for fast refresh and any
// renderer-side aliases needed by the dashboard.
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: "src/main/index.ts",
      },
    },
  },
  preload: {
    build: {
      lib: {
        entry: "src/preload/index.ts",
      },
    },
  },
  renderer: {
    // The renderer's `index.html` lives at the desktop-app root
    // (`apps/desktop/index.html`), not under `src/renderer/`.
    // electron-vite's default renderer root is `<pkg>/src/renderer/`,
    // which would resolve `index.html` to a path that escapes the
    // renderer root and trips Rollup's "fileName must not be relative"
    // check. Pinning `root` to the package directory lines the bundler
    // up with the actual on-disk layout. Phase 1 will register
    // `@vitejs/plugin-react` here for fast refresh + the React JSX
    // runtime once the renderer body grows past pure re-exports.
    root: ".",
    build: {
      rollupOptions: {
        input: "index.html",
      },
    },
  },
});
