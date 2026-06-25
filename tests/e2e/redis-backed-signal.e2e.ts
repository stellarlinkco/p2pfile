import { expect, test } from "@playwright/test";
import { redisServiceConfigured } from "./transfer-stability.support";

const REDIS_SESSION_KEY_PREFIX = "p2pfile:session:";

test.describe("redis-backed signal e2e", () => {
  test("redis-backed signal service persists sessions in Redis when REDIS_URL is configured", async ({
    request,
  }) => {
    test.skip(
      !redisServiceConfigured(),
      "Blocked until REDIS_URL points at a reachable Redis service.",
    );
    const signalBaseUrl = process.env.QA_E2E_SIGNAL_URL?.trim() || "http://127.0.0.1:3001";
    const redisUrl = process.env.REDIS_URL?.trim();
    if (!redisUrl) {
      throw new Error("REDIS_URL is required for redis-backed signal e2e.");
    }

    const statusResponse = await request.get(`${signalBaseUrl}/api/status`);
    expect(statusResponse.ok()).toBe(true);

    const createResponse = await request.post(`${signalBaseUrl}/api/sessions`, {
      data: {
        manifest: [{ id: "file-1", name: "redis-backed.txt", size: 32, mimeType: "text/plain" }],
      },
    });
    expect(createResponse.ok()).toBe(true);
    const created = (await createResponse.json()) as { sessionId: string; sharePath: string };
    expect(created.sessionId).toBeTruthy();

    const RedisClient = (
      Bun as unknown as {
        RedisClient?: new (url: string) => { get(key: string): Promise<string | null> };
      }
    ).RedisClient;
    if (!RedisClient) {
      throw new Error("Bun RedisClient is unavailable in this runtime.");
    }
    const redis = new RedisClient(redisUrl);
    const stored = await redis.get(`${REDIS_SESSION_KEY_PREFIX}${created.sessionId}`);
    expect(stored).toBeTruthy();
    expect(stored).toContain(created.sessionId);

    const sessionResponse = await request.get(`${signalBaseUrl}/api/sessions/${created.sessionId}`);
    expect(sessionResponse.ok()).toBe(true);
  });
});
