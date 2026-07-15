import { expect, test } from "bun:test";
import { resumeProgressFromManifest } from "@p2pfile/shared";
import { type RedisLike, redisSessionKey } from "./redis-session-storage";
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

  async persist(key: string) {
    this.expirations.delete(key);
  }
}

class BlockingSetRedis extends MemoryRedis {
  private nextSetGate: { markEntered: () => void; released: Promise<void> } | undefined;

  blockNextSet() {
    let markEntered = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextSetGate = { markEntered, released };
    return { entered, release };
  }

  override async set(key: string, value: string) {
    const gate = this.nextSetGate;
    this.nextSetGate = undefined;
    if (gate) {
      gate.markEntered();
      await gate.released;
    }
    await super.set(key, value);
  }
}

class FakeSocket {
  sent: unknown[] = [];

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }

  closeCode: number | null = null;

  close(code?: number) {
    this.closeCode = code ?? null;
  }
}

const redisUrl = process.env.REDIS_URL;

function createMemoryStore(
  options: {
    now?: () => number;
    completedViewTtlMs?: number;
    senderReconnectGraceMs?: number;
  } = {},
) {
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
  await completedStore.completeSession(created.sessionId, {
    receiverToken: claimed.receiverToken,
    completedFiles: created.session.manifest.map(({ id, size }) => ({ id, bytes: size })),
    totalBytes: created.session.summary.totalSize,
  });

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

test("RedisSessionStore validates only the current receiver token", async () => {
  const store = createMemoryStore();
  const { claimed, created } = await createClaimedSession(store);
  expect(await store.validateReceiverToken(created.sessionId, claimed.receiverToken)).toBe(true);

  await store.releaseSession(created.sessionId, { receiverToken: claimed.receiverToken });
  const replacement = await store.claimSession(created.sessionId);
  if (replacement?.status !== "claimed") throw new Error("expected replacement claim");

  expect(await store.validateReceiverToken(created.sessionId, claimed.receiverToken)).toBe(false);
  expect(await store.validateReceiverToken(created.sessionId, replacement.receiverToken)).toBe(
    true,
  );
});

test("RedisSessionStore keeps completed view for the configured TTL", async () => {
  let now = 1_000;
  const store = createMemoryStore({ completedViewTtlMs: 500, now: () => now });
  const { claimed, created } = await createClaimedSession(store);

  const completed = await store.completeSession(created.sessionId, {
    receiverToken: claimed.receiverToken,
    completedFiles: created.session.manifest.map(({ id, size }) => ({ id, bytes: size })),
    totalBytes: created.session.summary.totalSize,
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
      JSON.stringify({
        type: "receiver-ready",
        payload: {
          completedFiles: 1,
          progress: resumeProgressFromManifest([{ id: "file-1", name: "hello.txt", size: 128 }]),
        },
      }),
    ),
  ).toBe(true);
  expect(sender.sent).toEqual([
    {
      type: "receiver-ready",
      payload: {
        completedFiles: 1,
        progress: resumeProgressFromManifest([{ id: "file-1", name: "hello.txt", size: 128 }]),
      },
    },
  ]);

  expect(
    await store.handleSignal(
      created.sessionId,
      "sender",
      created.senderToken,
      JSON.stringify({
        type: "receiver-ready",
        payload: {
          completedFiles: 1,
          progress: resumeProgressFromManifest([{ id: "file-1", name: "hello.txt", size: 128 }]),
        },
      }),
    ),
  ).toBe(false);
});

test("RedisSessionStore enters reconnecting when transferring sender disconnects", async () => {
  const store = createMemoryStore();
  const { claimed, created } = await createClaimedSession(store);
  const sender = new FakeSocket();
  const receiver = new FakeSocket();
  await store.connectSocket(created.sessionId, "sender", created.senderToken, sender as never);
  await store.connectSocket(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    receiver as never,
  );
  await store.handleSignal(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    JSON.stringify({
      type: "receiver-ready",
      payload: {
        completedFiles: 0,
        progress: resumeProgressFromManifest([{ id: "file-1", name: "hello.txt", size: 128 }]),
      },
    }),
  );

  await store.disconnectSocket(created.sessionId, "sender", created.senderToken, sender as never);

  const session = await store.getPublicSession(created.sessionId);
  expect(session?.state).toBe("reconnecting");
  expect(receiver.sent).toContainEqual({
    type: "sender-reconnecting",
    payload: { reason: "sender-disconnected" },
  });
});

test("RedisSessionStore restores transferring and clears reconnect TTL when sender reconnects", async () => {
  const client = new MemoryRedis();
  const store = new RedisSessionStore("redis://memory", {}, client);
  const { claimed, created } = await createClaimedSession(store);
  const sender = new FakeSocket();
  const receiver = new FakeSocket();
  await store.connectSocket(created.sessionId, "sender", created.senderToken, sender as never);
  await store.connectSocket(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    receiver as never,
  );
  await store.handleSignal(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    JSON.stringify({
      type: "receiver-ready",
      payload: {
        completedFiles: 0,
        progress: resumeProgressFromManifest([{ id: "file-1", name: "hello.txt", size: 128 }]),
      },
    }),
  );
  await store.disconnectSocket(created.sessionId, "sender", created.senderToken, sender as never);

  const replacementSender = new FakeSocket();
  await store.connectSocket(
    created.sessionId,
    "sender",
    created.senderToken,
    replacementSender as never,
  );

  const session = await store.getPublicSession(created.sessionId);
  expect(session?.state).toBe("transferring");
  expect(client.expirations.has(redisSessionKey(created.sessionId))).toBe(false);
});

test("RedisSessionStore closes and rejects a replaced receiver socket", async () => {
  const store = createMemoryStore();
  const { claimed, created } = await createClaimedSession(store);
  const oldReceiver = new FakeSocket();
  const replacementReceiver = new FakeSocket();

  await store.connectSocket(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    oldReceiver as never,
  );
  await store.connectSocket(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    replacementReceiver as never,
  );

  expect(oldReceiver.closeCode).toBe(1000);
  expect(
    await store.handleSignal(
      created.sessionId,
      "receiver",
      claimed.receiverToken,
      JSON.stringify({ type: "relay-ready", payload: {} }),
      oldReceiver as never,
    ),
  ).toBe(false);
});

test("RedisSessionStore serializes socket replacement behind an in-flight signal", async () => {
  const client = new BlockingSetRedis();
  const store = new RedisSessionStore("redis://memory", {}, client);
  const { claimed, created } = await createClaimedSession(store);
  const sender = new FakeSocket();
  const oldReceiver = new FakeSocket();
  await store.connectSocket(created.sessionId, "sender", created.senderToken, sender as never);
  await store.connectSocket(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    oldReceiver as never,
  );
  const gate = client.blockNextSet();
  const staleSignal = store.handleSignal(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    JSON.stringify({
      type: "receiver-ready",
      payload: {
        completedFiles: 0,
        progress: resumeProgressFromManifest([{ id: "file-1", name: "hello.txt", size: 128 }]),
      },
    }),
    oldReceiver as never,
  );
  await gate.entered;
  const replacementReceiver = new FakeSocket();
  const replacement = store.connectSocket(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    replacementReceiver as never,
  );
  await Promise.resolve();
  gate.release();

  expect(await staleSignal).toBe(true);
  expect(await replacement).toBe(true);
  expect(sender.sent).toContainEqual(expect.objectContaining({ type: "receiver-ready" }));
  expect(oldReceiver.closeCode).toBe(1000);
});

test("RedisSessionStore serializes receiver-ready before a concurrent release", async () => {
  const client = new BlockingSetRedis();
  const store = new RedisSessionStore("redis://memory", {}, client);
  const { claimed, created } = await createClaimedSession(store);
  const receiver = new FakeSocket();
  await store.connectSocket(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    receiver as never,
  );

  const gate = client.blockNextSet();
  const signal = store.handleSignal(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    JSON.stringify({
      type: "receiver-ready",
      payload: {
        completedFiles: 0,
        progress: resumeProgressFromManifest([{ id: "file-1", name: "hello.txt", size: 128 }]),
      },
    }),
    receiver as never,
  );
  await gate.entered;
  const release = store.releaseSession(created.sessionId, {
    receiverToken: claimed.receiverToken,
  });
  await Promise.resolve();
  gate.release();
  await Promise.all([signal, release]);

  const current = await store.getPublicSession(created.sessionId);
  expect(current?.state).toBe("waiting");
  expect(await store.validateReceiverToken(created.sessionId, claimed.receiverToken)).toBe(false);
});

test("RedisSessionStore serializes token validation behind receiver release", async () => {
  const client = new BlockingSetRedis();
  const store = new RedisSessionStore("redis://memory", {}, client);
  const { claimed, created } = await createClaimedSession(store);
  const gate = client.blockNextSet();
  const release = store.releaseSession(created.sessionId, {
    receiverToken: claimed.receiverToken,
  });
  await gate.entered;

  let validationResolved = false;
  const validation = store
    .validateReceiverToken(created.sessionId, claimed.receiverToken)
    .then((valid) => {
      validationResolved = true;
      return valid;
    });
  await Promise.resolve();

  expect(validationResolved).toBe(false);
  gate.release();
  expect(await release).not.toBeNull();
  expect(await validation).toBe(false);
});

test("RedisSessionStore sender end notifies and closes connected receiver socket", async () => {
  const store = createMemoryStore();
  const { claimed, created } = await createClaimedSession(store);
  const sender = new FakeSocket();
  const receiver = new FakeSocket();
  await store.connectSocket(created.sessionId, "sender", created.senderToken, sender as never);
  await store.connectSocket(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    receiver as never,
  );

  await store.endSession(created.sessionId, { senderToken: created.senderToken });

  expect(receiver.sent).toContainEqual({
    type: "sender-left",
    payload: { reason: "sender-ended" },
  });
  expect(receiver.closeCode).toBe(1000);
});

test("RedisSessionStore sender-left signal keeps ended session on short TTL", async () => {
  let now = 1_000;
  const client = new MemoryRedis();
  const store = new RedisSessionStore(
    "redis://memory",
    { completedViewTtlMs: 2_000, now: () => now },
    client,
  );
  const { claimed, created } = await createClaimedSession(store);
  const sender = new FakeSocket();
  const receiver = new FakeSocket();
  await store.connectSocket(created.sessionId, "sender", created.senderToken, sender as never);
  await store.connectSocket(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    receiver as never,
  );

  expect(
    await store.handleSignal(
      created.sessionId,
      "sender",
      created.senderToken,
      JSON.stringify({ type: "sender-left", payload: { reason: "sender-left" } }),
    ),
  ).toBe(true);
  now += 1;

  expect((await store.getPublicSession(created.sessionId))?.state).toBe("ended");
  expect(client.expirations.get(redisSessionKey(created.sessionId))).toBe(2);
});

test("RedisSessionStore rejects sender reattach after reconnect grace expires", async () => {
  let now = 1_000;
  const store = createMemoryStore({ senderReconnectGraceMs: 100, now: () => now });
  const { claimed, created } = await createClaimedSession(store);
  const sender = new FakeSocket();
  const receiver = new FakeSocket();
  await store.connectSocket(created.sessionId, "sender", created.senderToken, sender as never);
  await store.connectSocket(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    receiver as never,
  );
  await store.handleSignal(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    JSON.stringify({
      type: "receiver-ready",
      payload: {
        completedFiles: 0,
        progress: resumeProgressFromManifest([{ id: "file-1", name: "hello.txt", size: 128 }]),
      },
    }),
  );
  await store.disconnectSocket(created.sessionId, "sender", created.senderToken, sender as never);

  now += 101;
  const replacementSender = new FakeSocket();

  expect(
    await store.connectSocket(
      created.sessionId,
      "sender",
      created.senderToken,
      replacementSender as never,
    ),
  ).toBe(false);
  expect((await store.getPublicSession(created.sessionId))?.state).toBe("ended");
  expect(receiver.sent).toContainEqual({
    type: "sender-left",
    payload: { reason: "sender-timeout" },
  });
  expect(receiver.closeCode).toBe(1000);
});

test("RedisSessionStore rejects client-originated sender-reconnecting signals", async () => {
  const store = createMemoryStore();
  const { claimed, created } = await createClaimedSession(store);
  const sender = new FakeSocket();
  const receiver = new FakeSocket();
  await store.connectSocket(created.sessionId, "sender", created.senderToken, sender as never);
  await store.connectSocket(
    created.sessionId,
    "receiver",
    claimed.receiverToken,
    receiver as never,
  );

  expect(
    await store.handleSignal(
      created.sessionId,
      "sender",
      created.senderToken,
      JSON.stringify({ type: "sender-reconnecting", payload: { reason: "spoofed" } }),
    ),
  ).toBe(false);
  expect(receiver.sent).not.toContainEqual({
    type: "sender-reconnecting",
    payload: { reason: "spoofed" },
  });
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
