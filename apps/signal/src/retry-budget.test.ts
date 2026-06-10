import { expect, test } from "bun:test";
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
      manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
    }),
  );

  return {
    app,
    body: await response.json(),
  };
};

const claim = async (
  app: Awaited<ReturnType<typeof createSession>>["app"],
  sessionId: string,
  receiverToken?: string,
) => {
  const response = await app.request(
    createJsonRequest(
      "POST",
      `/api/sessions/${sessionId}/claim`,
      receiverToken ? { receiverToken } : {},
    ),
  );
  return response.json();
};

test("first claim grants the full retry budget without consuming it", async () => {
  const { app, body: created } = await createSession();

  const firstClaim = await claim(app, created.sessionId);

  expect(firstClaim.status).toBe("claimed");
  expect(firstClaim.retriesRemaining).toBe(3);
});

test("original receiver re-claim consumes one retry per attempt", async () => {
  const { app, body: created } = await createSession();
  const firstClaim = await claim(app, created.sessionId);

  const firstRetry = await claim(app, created.sessionId, firstClaim.receiverToken);
  const secondRetry = await claim(app, created.sessionId, firstClaim.receiverToken);

  expect(firstRetry.status).toBe("claimed");
  expect(firstRetry.receiverToken).toBe(firstClaim.receiverToken);
  expect(firstRetry.retriesRemaining).toBe(2);
  expect(secondRetry.status).toBe("claimed");
  expect(secondRetry.retriesRemaining).toBe(1);
});

test("claim past the exhausted retry budget fails the session for every visitor", async () => {
  const { app, body: created } = await createSession();
  const firstClaim = await claim(app, created.sessionId);
  for (let retry = 0; retry < 3; retry += 1) {
    await claim(app, created.sessionId, firstClaim.receiverToken);
  }

  const exhaustedClaim = await claim(app, created.sessionId, firstClaim.receiverToken);
  expect(exhaustedClaim.status).toBe("failed");
  expect(exhaustedClaim.session.state).toBe("failed");

  const publicView = await app.request(`http://localhost/api/sessions/${created.sessionId}`);
  const failedView = await publicView.json();
  expect(failedView.state).toBe("failed");
  expect(failedView.failureReason).toBe("retry-budget-exhausted");

  const strangerClaim = await claim(app, created.sessionId);
  expect(strangerClaim.status).toBe("failed");

  const originalReceiverClaim = await claim(app, created.sessionId, firstClaim.receiverToken);
  expect(originalReceiverClaim.status).toBe("failed");
});

test("release returns the session to pre-claim and resets the retry budget — accepted v1 release-bypass boundary", async () => {
  const { app, body: created } = await createSession();
  const firstClaim = await claim(app, created.sessionId);
  const retry = await claim(app, created.sessionId, firstClaim.receiverToken);
  expect(retry.retriesRemaining).toBe(2);

  const release = await app.request(
    createJsonRequest("POST", `/api/sessions/${created.sessionId}/release`, {
      receiverToken: firstClaim.receiverToken,
    }),
  );
  expect(release.status).toBe(200);
  const releaseBody = await release.json();
  expect(releaseBody.session.failureReason).toBeUndefined();
  expect(releaseBody.session.retriesRemaining).toBe(3);

  const nextCycleClaim = await claim(app, created.sessionId);
  expect(nextCycleClaim.status).toBe("claimed");
  expect(nextCycleClaim.retriesRemaining).toBe(3);
});

test("failed session rejects websocket connections and signals", () => {
  const store = new LiveSessionStore();
  const created = store.createSession({
    manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
  });
  const firstClaim = store.claimSession(created.sessionId);
  if (firstClaim?.status !== "claimed") {
    throw new Error("expected claimed");
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    store.claimSession(created.sessionId, firstClaim.receiverToken);
  }
  expect(store.getPublicSession(created.sessionId)?.state).toBe("failed");

  const socket = { send() {} };
  expect(
    store.connectSocket(created.sessionId, "sender", created.senderToken, socket as never),
  ).toBe(false);
  expect(
    store.handleSignal(
      created.sessionId,
      "sender",
      created.senderToken,
      JSON.stringify({ type: "sender-heartbeat", payload: {} }),
    ),
  ).toBe(false);
});
