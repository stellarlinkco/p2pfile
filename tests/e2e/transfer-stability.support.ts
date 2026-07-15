import type { CDPSession, Page } from "@playwright/test";
import { installSenderSocketControl } from "./worker-share-link.support";

export { installSenderSocketControl };

export async function applyNetworkDegradation(
  page: Page,
  options: {
    latencyMs?: number;
    downloadKbps?: number;
    uploadKbps?: number;
  } = {},
): Promise<CDPSession> {
  const client = await page.context().newCDPSession(page);
  await client.send("Network.enable");
  const kbpsToBytesPerSecond = (kbps: number) => Math.floor((kbps * 1024) / 8);
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: options.latencyMs ?? 400,
    downloadThroughput:
      typeof options.downloadKbps === "number" ? kbpsToBytesPerSecond(options.downloadKbps) : -1,
    uploadThroughput:
      typeof options.uploadKbps === "number" ? kbpsToBytesPerSecond(options.uploadKbps) : -1,
    connectionType: "cellular3g",
  });
  return client;
}

export async function clearNetworkDegradation(client: CDPSession) {
  try {
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "none",
    });
  } catch {
    // The page or CDP session may already be closed during teardown.
  }
}

export function observeConsoleErrors(page: Page, errors: string[]) {
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
}

export async function disableOpfsOnPage(page: Page) {
  await page.addInitScript(() => {
    if (!navigator.storage) return;
    Object.defineProperty(navigator.storage, "getDirectory", {
      configurable: true,
      value: undefined,
    });
  });
}

export async function failOpfsWritesOnPage(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    class FaultInjectingWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        const url = new URL(scriptURL, window.location.href);
        if (url.pathname.endsWith("/receiver-opfs.worker.ts")) {
          url.searchParams.set("__p2pfile_fail_opfs_writes", "1");
        }
        super(url, options);
      }
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: FaultInjectingWorker,
    });
  });
}

export function turnSandboxConfigured() {
  return Boolean(
    process.env.VITE_TURN_URL?.trim() &&
      process.env.VITE_TURN_USERNAME?.trim() &&
      process.env.VITE_TURN_CREDENTIAL?.trim(),
  );
}

export function redisServiceConfigured() {
  return Boolean(process.env.REDIS_URL?.trim());
}
