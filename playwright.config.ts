import { defineConfig, devices } from "@playwright/test";

const webPort = process.env.P2PFILE_E2E_WEB_PORT ?? "4173";
const webOrigin = `http://127.0.0.1:${webPort}`;
const signalOrigin = process.env.P2PFILE_E2E_SIGNAL_ORIGIN ?? "http://127.0.0.1:3001";
const signalPort = new URL(signalOrigin).port || "3001";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.e2e\.ts/,
  testIgnore: /worker-share-link\.e2e\.ts/,
  timeout: 30_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: webOrigin,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "bun run --filter @p2pfile/signal dev",
      url: `${signalOrigin}/api/status`,
      // Always own the signal process for this suite so a stale/wrong listener
      // on :3001 cannot answer /api/status while returning 404 for /api/sessions.
      reuseExistingServer: false,
      timeout: 120_000,
      env: { PORT: signalPort },
    },
    {
      command: `bun run --filter @p2pfile/web dev -- --port ${webPort} --strictPort`,
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        // Proxy target only (non-VITE_). Browser stays same-origin; Vite proxies
        // /api and /ws so createSession never hits a plain Vite 404.
        P2PFILE_SIGNAL_ORIGIN: signalOrigin,
      },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
