import { defineConfig, devices } from "@playwright/test";

const webPort = process.env.P2PFILE_E2E_WEB_PORT ?? "4173";
const webOrigin = `http://127.0.0.1:${webPort}`;
const signalOrigin = process.env.P2PFILE_E2E_SIGNAL_ORIGIN ?? "http://127.0.0.1:3001";
const defaultSignalOrigin = "http://127.0.0.1:3001";
const signalPort = new URL(signalOrigin).port || "3001";
const useCustomSignalOrigin = signalOrigin !== defaultSignalOrigin;
const useCustomWebPort = webPort !== "4173";

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
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { PORT: signalPort },
    },
    {
      command: `bun run --filter @p2pfile/web dev -- --port ${webPort}`,
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
      env:
        useCustomWebPort || useCustomSignalOrigin
          ? {
              VITE_SIGNAL_ORIGIN: signalOrigin,
            }
          : undefined,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
