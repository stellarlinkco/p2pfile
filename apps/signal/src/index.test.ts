import { expect, test } from "bun:test";
import { resumeProgressFromManifest } from "@p2pfile/shared";
import { createApp } from "./app";
import { LiveSessionStore } from "./runtime";

const createJsonRequest = (method: string, path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const createSession = async () => {
  const { app } = createApp();
  const response = await app.request(
    createJsonRequest("POST", "/api/sessions", {
      manifest: [
        { id: "file-1", name: "hello.txt", size: 128 },
        { id: "file-2", name: "photo.jpg", size: 256 },
      ],
    }),
  );

  return {
    app,
    response,
    body: await response.json(),
  };
};

test("status endpoint returns ok", async () => {
  const { app } = createApp();
  const response = await app.request("http://localhost/api/status");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toEqual({
    ok: true,
    service: "signal",
    product: "P2P File",
  });
});

test("session creation returns frozen manifest summary and sender token", async () => {
  const { response, body } = await createSession();

  expect(response.status).toBe(201);
  expect(body.sessionId).toHaveLength(12);
  expect(body.accessCode).toHaveLength(6);
  expect(body.sharePath).toBe(`/f/${body.sessionId}`);
  expect(body.senderToken.length).toBeGreaterThan(16);
  expect(body.session.summary).toEqual({ fileCount: 2, totalSize: 384 });
  expect(body.session.canClaim).toBe(true);
});

test("session creation retries on generated session id collision", async () => {
  const { app } = createApp();
  const originalRandomUUID = crypto.randomUUID;
  const values = [
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  ];
  const lastValue = values[values.length - 1] ?? "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  let index = 0;

  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => values[index++] ?? lastValue,
  });

  try {
    const first = await app.request(
      createJsonRequest("POST", "/api/sessions", {
        manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
      }),
    );
    const second = await app.request(
      createJsonRequest("POST", "/api/sessions", {
        manifest: [{ id: "file-2", name: "photo.jpg", size: 256 }],
      }),
    );
    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(firstBody.sessionId).toBe("aaaaaaaaaaaa");
    expect(secondBody.sessionId).toBe("bbbbbbbbbbbb");
  } finally {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: originalRandomUUID,
    });
  }
});

test("claim is exclusive until released", async () => {
  const { app, body: created } = await createSession();

  const firstClaim = await app.request(
    createJsonRequest("POST", `/api/sessions/${created.sessionId}/claim`, {}),
  );
  const secondClaim = await app.request(
    createJsonRequest("POST", `/api/sessions/${created.sessionId}/claim`, {}),
  );

  const firstBody = await firstClaim.json();
  const secondBody = await secondClaim.json();

  expect(firstBody.status).toBe("claimed");
  expect(secondBody.status).toBe("occupied");

  const release = await app.request(
    createJsonRequest("POST", `/api/sessions/${created.sessionId}/release`, {
      receiverToken: firstBody.receiverToken,
    }),
  );
  const releaseBody = await release.json();

  expect(release.status).toBe(200);
  expect(releaseBody.session.state).toBe("waiting");
  expect(releaseBody.session.canClaim).toBe(true);

  const thirdClaim = await app.request(
    createJsonRequest("POST", `/api/sessions/${created.sessionId}/claim`, {}),
  );
  const thirdBody = await thirdClaim.json();

  expect(thirdBody.status).toBe("claimed");
  expect(thirdBody.receiverToken).not.toBe(firstBody.receiverToken);
});

test("access code resolves back to the same share path", async () => {
  const { app, body } = await createSession();
  const response = await app.request(`http://localhost/api/access-codes/${body.accessCode}`);
  const resolved = await response.json();

  expect(response.status).toBe(200);
  expect(resolved).toEqual({
    sessionId: body.sessionId,
    sharePath: body.sharePath,
  });
});
test("stale sender websocket close does not end replacement connection", () => {
  const store = new LiveSessionStore();
  const created = store.createSession({
    manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
  });
  const oldSocket = { send() {} };
  const replacementSocket = { send() {} };

  expect(
    store.connectSocket(created.sessionId, "sender", created.senderToken, oldSocket as never),
  ).toBe(true);
  expect(
    store.connectSocket(
      created.sessionId,
      "sender",
      created.senderToken,
      replacementSocket as never,
    ),
  ).toBe(true);

  store.disconnectSocket(created.sessionId, "sender", created.senderToken, oldSocket as never);

  expect(store.getPublicSession(created.sessionId)?.state).toBe("waiting");
});

test("transferring sender websocket disconnect enters reconnecting instead of ended", () => {
  const store = new LiveSessionStore();
  const created = store.createSession({
    manifest: [{ id: "file-1", name: "large.zip", size: 1024 * 1024 + 1 }],
  });
  const claim = store.claimSession(created.sessionId);
  if (claim?.status !== "claimed") {
    throw new Error("expected claimed");
  }
  const senderSocket = { send() {} };
  const receiverSocket = {
    sent: [] as unknown[],
    send(payload: string) {
      this.sent.push(JSON.parse(payload));
    },
  };
  store.connectSocket(created.sessionId, "sender", created.senderToken, senderSocket as never);
  store.connectSocket(created.sessionId, "receiver", claim.receiverToken, receiverSocket as never);
  store.handleSignal(
    created.sessionId,
    "sender",
    created.senderToken,
    JSON.stringify({ type: "offer", payload: { type: "offer", sdp: "v=0" } }),
  );
  store.handleSignal(
    created.sessionId,
    "receiver",
    claim.receiverToken,
    JSON.stringify({
      type: "receiver-ready",
      payload: {
        completedFiles: 0,
        progress: resumeProgressFromManifest([
          { id: "file-1", name: "large.zip", size: 1024 * 1024 + 1 },
        ]),
      },
    }),
  );

  store.disconnectSocket(created.sessionId, "sender", created.senderToken, senderSocket as never);

  const session = store.getPublicSession(created.sessionId);
  expect(session?.state).toBe("reconnecting");
  expect(session?.ended).toBe(false);
  expect(receiverSocket.sent).toContainEqual({
    type: "sender-reconnecting",
    payload: { reason: "sender-disconnected" },
  });
});

test("reconnecting sender reconnect restores transferring when receiver is claimed", () => {
  const store = new LiveSessionStore();
  const created = store.createSession({
    manifest: [{ id: "file-1", name: "large.zip", size: 1024 * 1024 + 1 }],
  });
  const claim = store.claimSession(created.sessionId);
  if (claim?.status !== "claimed") {
    throw new Error("expected claimed");
  }
  const senderSocket = { send() {} };
  const receiverSocket = { send() {} };
  store.connectSocket(created.sessionId, "sender", created.senderToken, senderSocket as never);
  store.connectSocket(created.sessionId, "receiver", claim.receiverToken, receiverSocket as never);
  store.handleSignal(
    created.sessionId,
    "receiver",
    claim.receiverToken,
    JSON.stringify({
      type: "receiver-ready",
      payload: {
        completedFiles: 0,
        progress: resumeProgressFromManifest([
          { id: "file-1", name: "large.zip", size: 1024 * 1024 + 1 },
        ]),
      },
    }),
  );

  store.disconnectSocket(created.sessionId, "sender", created.senderToken, senderSocket as never);
  expect(store.getPublicSession(created.sessionId)?.state).toBe("reconnecting");

  const replacementSenderSocket = { send() {} };
  store.connectSocket(
    created.sessionId,
    "sender",
    created.senderToken,
    replacementSenderSocket as never,
  );

  expect(store.getPublicSession(created.sessionId)?.state).toBe("transferring");
});

test("receiver websocket cannot end session with sender-left", async () => {
  const store = new LiveSessionStore();
  const created = store.createSession({
    manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
  });
  const claim = store.claimSession(created.sessionId);
  if (claim?.status !== "claimed") {
    throw new Error("expected claim");
  }

  const accepted = store.handleSignal(
    created.sessionId,
    "receiver",
    claim.receiverToken,
    JSON.stringify({ type: "sender-left", payload: {} }),
  );

  expect(accepted).toBe(false);
  expect(store.getPublicSession(created.sessionId)?.state).toBe("claimed");
});

test("client websocket cannot spoof sender-reconnecting", () => {
  const store = new LiveSessionStore();
  const created = store.createSession({
    manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
  });
  const claim = store.claimSession(created.sessionId);
  if (claim?.status !== "claimed") {
    throw new Error("expected claim");
  }

  const accepted = store.handleSignal(
    created.sessionId,
    "sender",
    created.senderToken,
    JSON.stringify({ type: "sender-reconnecting", payload: { reason: "spoofed" } }),
  );

  expect(accepted).toBe(false);
  expect(store.getPublicSession(created.sessionId)?.state).toBe("claimed");
});

test("receiver websocket cannot forward transfer-complete", () => {
  const store = new LiveSessionStore();
  const created = store.createSession({
    manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
  });
  const claim = store.claimSession(created.sessionId);
  if (claim?.status !== "claimed") {
    throw new Error("expected claim");
  }

  const accepted = store.handleSignal(
    created.sessionId,
    "receiver",
    claim.receiverToken,
    JSON.stringify({ type: "transfer-complete", payload: { completedAt: 1 } }),
  );

  expect(accepted).toBe(false);
});

test("complete and end endpoints reject invalid tokens", async () => {
  const { app, body } = await createSession();
  const claimResponse = await app.request(
    createJsonRequest("POST", `/api/sessions/${body.sessionId}/claim`, {}),
  );
  const claim = await claimResponse.json();

  const completedFiles = body.session.manifest.map(
    ({ id, size }: { id: string; size: number }) => ({
      id,
      bytes: size,
    }),
  );
  const invalidComplete = await app.request(
    createJsonRequest("POST", `/api/sessions/${body.sessionId}/complete`, {
      receiverToken: "invalid-token-invalid-token",
      completedFiles,
      totalBytes: body.session.summary.totalSize,
    }),
  );
  const invalidEnd = await app.request(
    createJsonRequest("POST", `/api/sessions/${body.sessionId}/end`, {
      senderToken: "invalid-token-invalid-token",
    }),
  );

  expect(invalidComplete.status).toBe(401);
  expect(invalidEnd.status).toBe(401);

  const complete = await app.request(
    createJsonRequest("POST", `/api/sessions/${body.sessionId}/complete`, {
      receiverToken: claim.receiverToken,
      completedFiles,
      totalBytes: body.session.summary.totalSize,
    }),
  );
  const completeBody = await complete.json();

  expect(complete.status).toBe(200);
  expect(completeBody.session.state).toBe("completed-view");

  const endedClaim = await app.request(
    createJsonRequest("POST", `/api/sessions/${body.sessionId}/claim`, {}),
  );
  const endedClaimBody = await endedClaim.json();
  expect(endedClaimBody.status).toBe("completed");

  const end = await app.request(
    createJsonRequest("POST", `/api/sessions/${body.sessionId}/end`, {
      senderToken: body.senderToken,
    }),
  );
  const endBody = await end.json();

  expect(end.status).toBe(200);
  expect(endBody.session.state).toBe("completed-view");
});
