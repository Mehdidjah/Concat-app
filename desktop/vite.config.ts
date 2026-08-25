import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  // Tailwind v4 runs as a Vite plugin. There is no tailwind.config.js and no
  // PostCSS step: the theme lives in src/styles.css under @theme.
  plugins: [react(), tailwindcss()],

  // Do not let Vite's screen-clearing hide Rust compiler errors.
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // We ship inside WebView2 / WKWebView / WebKitGTK, all of which are modern.
    // Targeting them directly means no legacy transpilation and smaller output.
    target: "esnext",
    minify: "esbuild",
    // Source maps in debug builds only - they double the bundle otherwise.
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 1500,
  },

  // Vite pre-bundles these once instead of re-resolving them on every reload.
  optimizeDeps: {
    include: ["react", "react-dom", "@tauri-apps/api/core"],
  },
}));
