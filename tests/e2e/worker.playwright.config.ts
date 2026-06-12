import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /worker-share-link\.e2e\.ts/,
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:8788",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "bun run --filter @p2pfile/web build && bun run --filter @p2pfile/edge dev -- --port 8788",
    url: "http://127.0.0.1:8788",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
