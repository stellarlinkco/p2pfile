import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /worker-share-link\.e2e\.ts/,
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:8788",
    permissions: ["local-network-access"],
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "bun ./local-stun-server.ts",
      url: "http://127.0.0.1:3479",
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command:
        "bun run --filter @p2pfile/web build && bun run --filter @p2pfile/edge dev -- --port 8788",
      env: { VITE_STUN_URL: "stun:127.0.0.1:3478" },
      url: "http://127.0.0.1:8788",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
