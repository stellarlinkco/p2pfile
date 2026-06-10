import { expect, test } from "bun:test";
import type { RedisLike } from "./redis-session-storage";
import { RedisSessionStore } from "./redis-store";

class MemoryRedis implements RedisLike {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, number>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
  }

  async del(key: string) {
    this.values.delete(key);
    this.expirations.delete(key);
  }

  async expire(key: string, seconds: number) {
    this.expirations.set(key, seconds);
  }
}

class FakeSocket {
  sent: unknown[] = [];

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }
}

const redisUrl = process.env.REDIS_URL;

function createMemoryStore(options: { now?: () => number; completedViewTtlMs?: number } = {}) {
  return new RedisSessionStore("redis://memory", options, new MemoryRedis());
}

async function createClaimedSession(store: RedisSessionStore) {
  const created = await store.createSession({
    manifest: [{ id: crypto.randomUUID(), name: "hello.txt", size: 128 }],
  });
  const claimed = await store.claimSession(created.sessionId);
  if (claimed?.status !== "claimed") throw new Error("expected claimed");
  return { claimed, created };
}

test("RedisSessionStore preserves completed and ended terminal claim states", async () => {
  const completedStore = createMemoryStore();
  const { claimed, created } = await createClaimedSession(completedStore);
  await completedStore.completeSession(created.sessionId, { receiverToken: claimed.receiverToken });

  const completedClaim = await completedStore.claimSession(
    created.sessionId,
    claimed.receiverToken,
  );
  expect(completedClaim?.status).toBe("completed");

  const endedStore = createMemoryStore();
  const ended = await endedStore.createSession({
    manifest: [{ id: crypto.randomUUID(), name: "bye.txt", size: 12 }],
  });
  await endedStore.endSession(ended.sessionId, { senderToken: ended.senderToken });

  const endedClaim = await endedStore.claimSession(ended.sessionId);
  expect(endedClaim?.status).toBe("ended");
});

test("RedisSessionStore keeps completed view for the configured TTL", async () => {
  let now = 1_000;
  const store = createMemoryStore({ completedViewTtlMs: 500, now: () => now });
  const { claimed, created } = await createClaimedSession(store);

  const completed = await store.completeSession(created.sessionId, {
    receiverToken: claimed.receiverToken,
  });
  expect(completed?.session.expiresAt).toBe(1_500);

  now = 1_501;
  expect(await store.getPublicSession(created.sessionId)).toBeNull();
});

test("RedisSessionStore forwards websocket signals between same-process peers", async () => {
  const store = createMemoryStore();
  const { claimed, created } = await createClaimedSession(store);
  const sender = new FakeSocket();
  const receiver = new FakeSocket();

  expect(
    await store.connectSocket(created.sessionId, "sender", created.senderToken, sender as never),
  ).toBe(true);
  expect(
    await store.connectSocket(
      created.sessionId,
      "receiver",
      claimed.receiverToken,
      receiver as never,
    ),
  ).toBe(true);

  expect(
    await store.handleSignal(
      created.sessionId,
      "sender",
      created.senderToken,
      JSON.stringify({ type: "offer", payload: { type: "offer", sdp: "v=0" } }),
    ),
  ).toBe(true);
  expect(receiver.sent).toEqual([{ type: "offer", payload: { type: "offer", sdp: "v=0" } }]);

  expect(
    await store.handleSignal(
      created.sessionId,
      "receiver",
      claimed.receiverToken,
      JSON.stringify({ type: "receiver-ready", payload: { completedFiles: 1 } }),
    ),
  ).toBe(true);
  expect(sender.sent).toEqual([{ type: "receiver-ready", payload: { completedFiles: 1 } }]);

  expect(
    await store.handleSignal(
      created.sessionId,
      "sender",
      created.senderToken,
      JSON.stringify({ type: "receiver-ready", payload: { completedFiles: 1 } }),
    ),
  ).toBe(false);
});

test.skipIf(!redisUrl)(
  "RedisSessionStore persists session state and access-code index",
  async () => {
    const store = new RedisSessionStore(redisUrl as string, { openSessionTtlMs: 60_000 });
    const created = await store.createSession({
      manifest: [{ id: crypto.randomUUID(), name: "hello.txt", size: 128 }],
    });

    const resolved = await store.resolveAccessCode(created.accessCode);
    expect(resolved?.sessionId).toBe(created.sessionId);

    const viewed = await store.viewSession(created.sessionId);
    expect(viewed?.state).toBe("viewing");
    expect(viewed?.canClaim).toBe(true);

    const claimed = await store.claimSession(created.sessionId);
    if (claimed?.status !== "claimed") {
      throw new Error("expected claimed");
    }
    expect(claimed.session.claimed).toBe(true);
    expect(claimed.session.canClaim).toBe(false);

    const released = await store.releaseSession(created.sessionId, {
      receiverToken: claimed.receiverToken,
    });
    expect(released?.session.state).toBe("waiting");
    expect(released?.session.retriesRemaining).toBe(3);
    expect(released?.session.failureReason).toBeUndefined();
  },
);
