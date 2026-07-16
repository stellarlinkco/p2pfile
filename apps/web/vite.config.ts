import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const DEFAULT_SIGNAL_ORIGIN = "http://127.0.0.1:3001";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Proxy target only. Prefer non-VITE_ so the browser keeps same-origin and
  // does not bypass the proxy via import.meta.env.VITE_SIGNAL_ORIGIN.
  const signalOrigin =
    env.P2PFILE_SIGNAL_ORIGIN ||
    process.env.P2PFILE_SIGNAL_ORIGIN ||
    env.VITE_SIGNAL_ORIGIN ||
    process.env.VITE_SIGNAL_ORIGIN ||
    DEFAULT_SIGNAL_ORIGIN;

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: "127.0.0.1",
      port: 4173,
      // Fail closed when the E2E/dev port is already taken instead of silently
      // binding another port that breaks the local signal proxy assumption.
      strictPort: true,
      proxy: {
        // Keep browser API/WS same-origin in local signal+web mode. Without this,
        // a port-rewrite miss hits Vite and surfaces as plain "404 Not Found".
        "/api": {
          target: signalOrigin,
          changeOrigin: true,
        },
        "/ws": {
          target: signalOrigin,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
    },
  };
});
