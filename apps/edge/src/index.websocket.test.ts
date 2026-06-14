import { expect, test } from "bun:test";

import {
  ClaimSessionResponseSchema,
  CreateSessionResponseSchema,
  ReleaseSessionResponseSchema,
  resumeProgressFromManifest,
  SessionMutationResponseSchema,
} from "@p2pfile/shared";
import { resetEdgeSessionsForTests, type SessionDurableObject, setEdgeNowForTests } from "./index";
import {
  claimReceiver,
  createDurableObjects,
  createDurableObjectsWithStorageTrace,
  createEnv,
  createSession,
  handleRequest,
  installFakeWebSocketPair,
  type MemoryDurableObjectNamespace,
  manifest,
  request,
  type StorageMutation,
  websocketRequest,
} from "./test-support";

test("Completed Session View expires after its short-lived Durable Object alarm window", async () => {
  resetEdgeSessionsForTests();
  const objects = createDurableObjects();
  const env = createEnv(objects);
  const { body } = await createSession(env);
  const created = CreateSessionResponseSchema.parse(body);
  const claimed = await claimReceiver(env, created.sessionId);

  const completed = await handleRequest(
    request(`/api/sessions/${created.sessionId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        receiverToken: claimed.receiverToken,
        completedFiles: manifest.map((file) => ({ id: file.id, bytes: file.size })),
        totalBytes: created.session.summary.totalSize,
      }),
    }),
    env,
  );
  const completedBody = SessionMutationResponseSchema.parse(await completed.json());
  const expiresAt = completedBody.session.expiresAt;
  if (expiresAt === null) throw new Error("completed views must have an expiry");
  const sessionStorage = (
    objects.SESSION_OBJECT as unknown as MemoryDurableObjectNamespace<SessionDurableObject>
  ).storageForName(created.sessionId);
  expect(await sessionStorage.getAlarm()).toBe(expiresAt);

  setEdgeNowForTests(() => expiresAt + 1);
  await (
    objects.SESSION_OBJECT as unknown as MemoryDurableObjectNamespace<
      SessionDurableObject & { alarm: () => Promise<void> }
    >
  )
    .instanceForName(created.sessionId)
    .alarm();

  const expiredView = await handleRequest(request(`/api/sessions/${created.sessionId}`), env);
  const expiredCode = await handleRequest(request(`/api/access-codes/${created.accessCode}`), env);

  expect(expiredView.status).toBe(404);
  expect((await expiredView.json()) as unknown).toEqual({ message: "session not found" });
  expect(expiredCode.status).toBe(404);
  expect((await expiredCode.json()) as unknown).toEqual({ message: "session not found" });
});
test("SessionObject WebSockets forward validated Direct Transfer signaling only to the peer", async () => {
  resetEdgeSessionsForTests();
  const env = createEnv(createDurableObjects());
  const pairs = installFakeWebSocketPair();
  const { body: created } = await createSession(env);
  const session = CreateSessionResponseSchema.parse(created);
  const claim = await claimReceiver(env, session.sessionId);

  const senderResponse = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/sender/${session.senderToken}`),
    env,
  );
  const receiverResponse = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/receiver/${claim.receiverToken}`),
    env,
  );

  expect(senderResponse.status).toBe(101);
  expect(receiverResponse.status).toBe(101);
  expect(pairs).toHaveLength(2);
  const senderPair = pairs[0];
  const receiverPair = pairs[1];
  if (!senderPair || !receiverPair) throw new Error("expected sender and receiver sockets");

  const sender = senderPair.client;
  const receiver = receiverPair.client;
  const ready = {
    type: "receiver-ready",
    payload: { completedFiles: 0, progress: resumeProgressFromManifest(manifest) },
  };
  receiver.send(JSON.stringify(ready));
  expect(sender.received.map((message) => JSON.parse(message))).toEqual([ready]);
  expect(receiver.received).toEqual([]);

  const offer = { type: "offer", payload: { type: "offer", sdp: "v=0" } };
  sender.send(JSON.stringify(offer));
  expect(receiver.received).toEqual([JSON.stringify(offer)]);

  sender.send(
    JSON.stringify({
      type: "receiver-ready",
      payload: { completedFiles: 1, progress: resumeProgressFromManifest(manifest) },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sender.closed).toEqual({ code: 1003, reason: "invalid signal message" });
  expect(receiver.received).toEqual([
    JSON.stringify(offer),
    JSON.stringify({ type: "sender-reconnecting", payload: { reason: "sender-disconnected" } }),
  ]);
});

test("SessionObject relays transfer frames in-flight without writing chunks to storage", async () => {
  const storageMutations: StorageMutation[] = [];
  const env = createEnv(createDurableObjectsWithStorageTrace(storageMutations));
  const pairs = installFakeWebSocketPair();
  const { body: created } = await createSession(env);
  const session = CreateSessionResponseSchema.parse(created);
  const claim = await claimReceiver(env, session.sessionId);

  const senderResponse = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/sender/${session.senderToken}`),
    env,
  );
  const receiverResponse = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/receiver/${claim.receiverToken}`),
    env,
  );

  expect(senderResponse.status).toBe(101);
  expect(receiverResponse.status).toBe(101);
  const senderPair = pairs[0];
  const receiverPair = pairs[1];
  if (!senderPair || !receiverPair) throw new Error("expected sender and receiver sockets");

  const sender = senderPair.client;
  const receiver = receiverPair.client;
  const relayReady = { type: "relay-ready", payload: {} };
  const relayChunk = "YQ==".repeat(64 * 1024);
  const relayMessage = {
    type: "relay-message",
    payload: {
      sequence: 0,
      message: {
        type: "chunk",
        fileId: manifest[0]?.id ?? "local-1",
        chunkIndex: 0,
        offset: 0,
        bytesBase64: relayChunk,
        chunkDigest: "0".repeat(64),
      },
    },
  };
  const relayAck = { type: "relay-ack", payload: { sequence: 0 } };

  receiver.send(JSON.stringify(relayReady));
  expect(sender.received).toEqual([JSON.stringify(relayReady)]);
  expect(receiver.received).toEqual([]);

  sender.send(JSON.stringify(relayMessage));
  expect(receiver.received).toEqual([JSON.stringify(relayMessage)]);

  receiver.send(JSON.stringify(relayAck));
  expect(sender.received).toEqual([JSON.stringify(relayReady), JSON.stringify(relayAck)]);
  expect(sender.closed).toBeNull();
  expect(receiver.closed).toBeNull();

  const durableWrites = JSON.stringify(storageMutations);
  expect(durableWrites).not.toContain(relayChunk);
  expect(durableWrites).not.toContain("relay-message");
  expect(durableWrites).not.toContain("relay-ack");
  expect(durableWrites).not.toContain("relay-ready");
});

test("SessionObject forwards receiver relay chunk-commit separately from relay delivery ack", async () => {
  const storageMutations: StorageMutation[] = [];
  const env = createEnv(createDurableObjectsWithStorageTrace(storageMutations));
  const pairs = installFakeWebSocketPair();
  const { body: created } = await createSession(env);
  const session = CreateSessionResponseSchema.parse(created);
  const claim = await claimReceiver(env, session.sessionId);

  const senderResponse = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/sender/${session.senderToken}`),
    env,
  );
  const receiverResponse = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/receiver/${claim.receiverToken}`),
    env,
  );

  expect(senderResponse.status).toBe(101);
  expect(receiverResponse.status).toBe(101);
  const senderPair = pairs[0];
  const receiverPair = pairs[1];
  if (!senderPair || !receiverPair) throw new Error("expected sender and receiver sockets");

  const sender = senderPair.client;
  const receiver = receiverPair.client;
  const relayAck = { type: "relay-ack", payload: { sequence: 4 } };
  const relayCommit = {
    type: "relay-message",
    payload: {
      sequence: 11,
      message: {
        type: "chunk-commit",
        fileId: manifest[0]?.id ?? "local-1",
        chunkIndex: 0,
        committedBytes: 64 * 1024,
      },
    },
  };

  receiver.send(JSON.stringify(relayAck));
  receiver.send(JSON.stringify(relayCommit));
  expect(sender.received.map((message) => JSON.parse(message))).toEqual([relayAck, relayCommit]);

  sender.send(JSON.stringify({ type: "relay-ack", payload: { sequence: 11 } }));
  expect(receiver.received.map((message) => JSON.parse(message))).toEqual([
    { type: "relay-ack", payload: { sequence: 11 } },
  ]);
  expect(sender.closed).toBeNull();
  expect(receiver.closed).toBeNull();

  const durableWrites = JSON.stringify(storageMutations);
  expect(durableWrites).not.toContain("chunk-commit");
  expect(durableWrites).not.toContain("bytesBase64");
  expect(durableWrites).not.toContain("committedBytes");
});

test("release preserves sender WebSocket for later receiver signaling", async () => {
  const env = createEnv(createDurableObjects());
  const pairs = installFakeWebSocketPair();
  const { body: created } = await createSession(env);
  const session = CreateSessionResponseSchema.parse(created);
  const firstClaim = await claimReceiver(env, session.sessionId);

  const senderResponse = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/sender/${session.senderToken}`),
    env,
  );
  const firstReceiverResponse = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/receiver/${firstClaim.receiverToken}`),
    env,
  );
  expect(senderResponse.status).toBe(101);
  expect(firstReceiverResponse.status).toBe(101);
  const senderPair = pairs[0];
  const firstReceiverPair = pairs[1];
  if (!senderPair || !firstReceiverPair) throw new Error("expected initial socket pairs");

  const release = await handleRequest(
    request(`/api/sessions/${session.sessionId}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverToken: firstClaim.receiverToken }),
    }),
    env,
  );
  const releaseBody = ReleaseSessionResponseSchema.parse(await release.json());
  expect(releaseBody.status).toBe("released");
  expect(firstReceiverPair.client.closed).toEqual({ code: 1000, reason: "session closed" });
  expect(senderPair.client.closed).toBeNull();

  const secondClaimResponse = await handleRequest(
    request(`/api/sessions/${session.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  const secondClaim = ClaimSessionResponseSchema.parse(await secondClaimResponse.json());
  expect(secondClaim.status).toBe("claimed");
  if (secondClaim.status !== "claimed") throw new Error("expected second claim");
  expect(secondClaim.receiverToken).not.toBe(firstClaim.receiverToken);

  const secondReceiverResponse = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/receiver/${secondClaim.receiverToken}`),
    env,
  );
  expect(secondReceiverResponse.status).toBe(101);
  const secondReceiverPair = pairs[2];
  if (!secondReceiverPair) throw new Error("expected reopened receiver socket pair");

  const relayReady = { type: "relay-ready", payload: {} };
  secondReceiverPair.client.send(JSON.stringify(relayReady));
  expect(senderPair.client.received).toEqual([JSON.stringify(relayReady)]);

  const offer = { type: "offer", payload: { type: "offer", sdp: "v=0" } };
  const relayMessage = {
    type: "relay-message",
    payload: {
      sequence: 1,
      message: {
        type: "chunk",
        fileId: manifest[0]?.id ?? "local-1",
        chunkIndex: 0,
        offset: 0,
        bytesBase64: "YQ==",
        chunkDigest: "0".repeat(64),
      },
    },
  };
  senderPair.client.send(JSON.stringify(offer));
  senderPair.client.send(JSON.stringify(relayMessage));
  expect(secondReceiverPair.client.received).toEqual([
    JSON.stringify(offer),
    JSON.stringify(relayMessage),
  ]);
  expect(senderPair.client.closed).toBeNull();
  expect(secondReceiverPair.client.closed).toBeNull();
});
