import { expect, test } from "bun:test";

import {
  ClaimSessionResponseSchema,
  CreateSessionResponseSchema,
  SessionMutationResponseSchema,
  SessionPublicViewSchema,
} from "@p2pfile/shared";
import { resetEdgeSessionsForTests, type SessionDurableObject, setEdgeNowForTests } from "./index";
import {
  claimReceiver,
  createDurableObjects,
  createEnv,
  createSession,
  handleRequest,
  installFakeWebSocketPair,
  type MemoryDurableObjectNamespace,
  request,
  websocketRequest,
} from "./test-support";

test("sender explicit end creates Sender-Ended Session and rejects sender reattach", async () => {
  const env = createEnv(createDurableObjects());
  installFakeWebSocketPair();
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

  const ended = await handleRequest(
    request(`/api/sessions/${session.sessionId}/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senderToken: session.senderToken }),
    }),
    env,
  );
  const endedBody = SessionMutationResponseSchema.parse(await ended.json());
  expect(ended.status).toBe(200);
  expect(endedBody.session.state).toBe("ended");
  expect(endedBody.session.ended).toBe(true);

  const endedClaim = await handleRequest(
    request(`/api/sessions/${session.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  const endedClaimBody = ClaimSessionResponseSchema.parse(await endedClaim.json());
  expect(endedClaimBody.status).toBe("ended");

  const reattach = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/sender/${session.senderToken}`),
    env,
  );
  expect(reattach.status).toBe(401);
});

test("sender-ended metadata is cleaned by Durable Object alarm", async () => {
  resetEdgeSessionsForTests();
  const objects = createDurableObjects();
  const env = createEnv(objects);
  const { body: created } = await createSession(env);
  const session = CreateSessionResponseSchema.parse(created);
  await claimReceiver(env, session.sessionId);

  const ended = await handleRequest(
    request(`/api/sessions/${session.sessionId}/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senderToken: session.senderToken }),
    }),
    env,
  );
  const endedBody = SessionMutationResponseSchema.parse(await ended.json());
  expect(endedBody.session.state).toBe("ended");
  const alarmAt = await (
    objects.SESSION_OBJECT as unknown as MemoryDurableObjectNamespace<SessionDurableObject>
  )
    .storageForName(session.sessionId)
    .getAlarm();
  if (alarmAt === null) throw new Error("ended session cleanup alarm must be scheduled");

  setEdgeNowForTests(() => alarmAt + 1);
  await (
    objects.SESSION_OBJECT as unknown as MemoryDurableObjectNamespace<
      SessionDurableObject & { alarm: () => Promise<void> }
    >
  )
    .instanceForName(session.sessionId)
    .alarm();

  const expiredView = await handleRequest(request(`/api/sessions/${session.sessionId}`), env);
  const expiredCode = await handleRequest(request(`/api/access-codes/${session.accessCode}`), env);
  expect(expiredView.status).toBe(404);
  expect((await expiredView.json()) as unknown).toEqual({ message: "session not found" });
  expect(expiredCode.status).toBe(404);
  expect((await expiredCode.json()) as unknown).toEqual({ message: "session not found" });
});

test("accidental sender websocket close enters reconnect grace and allows original sender reattach", async () => {
  const env = createEnv(createDurableObjects());
  const pairs = installFakeWebSocketPair();
  const { body: created } = await createSession(env);
  const session = CreateSessionResponseSchema.parse(created);
  const claim = await claimReceiver(env, session.sessionId);

  expect(
    (
      await handleRequest(
        websocketRequest(`/ws/${session.sessionId}/sender/${session.senderToken}`),
        env,
      )
    ).status,
  ).toBe(101);
  expect(
    (
      await handleRequest(
        websocketRequest(`/ws/${session.sessionId}/receiver/${claim.receiverToken}`),
        env,
      )
    ).status,
  ).toBe(101);

  const senderPair = pairs[0];
  if (!senderPair) throw new Error("expected sender socket");
  senderPair.client.close(1000, "sender tab closed");

  const view = await handleRequest(request(`/api/sessions/${session.sessionId}`), env);
  const viewBody = SessionPublicViewSchema.parse(await view.json());
  expect(viewBody.state).toBe("reconnecting");
  expect(viewBody.canClaim).toBe(false);
  expect(viewBody.ended).toBe(false);

  const reattach = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/sender/${session.senderToken}`),
    env,
  );
  expect(reattach.status).toBe(101);

  const retryClaim = await handleRequest(
    request(`/api/sessions/${session.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverToken: claim.receiverToken }),
    }),
    env,
  );
  const retryClaimBody = ClaimSessionResponseSchema.parse(await retryClaim.json());
  expect(retryClaimBody.status).toBe("claimed");
  if (retryClaimBody.status !== "claimed") throw new Error("expected claimed status");
  expect(retryClaimBody.receiverToken).toBe(claim.receiverToken);
});
test("accidental sender websocket close after claim preserves Receiver Token re-entry", async () => {
  const env = createEnv(createDurableObjects());
  const pairs = installFakeWebSocketPair();
  const { body: created } = await createSession(env);
  const session = CreateSessionResponseSchema.parse(created);

  expect(
    (
      await handleRequest(
        websocketRequest(`/ws/${session.sessionId}/sender/${session.senderToken}`),
        env,
      )
    ).status,
  ).toBe(101);

  const claim = await claimReceiver(env, session.sessionId);
  expect(
    (
      await handleRequest(
        websocketRequest(`/ws/${session.sessionId}/receiver/${claim.receiverToken}`),
        env,
      )
    ).status,
  ).toBe(101);

  const senderPair = pairs[0];
  if (!senderPair) throw new Error("expected sender socket");
  senderPair.client.close(1000, "sender tab closed");

  const retryClaim = await handleRequest(
    request(`/api/sessions/${session.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverToken: claim.receiverToken }),
    }),
    env,
  );
  const retryClaimBody = ClaimSessionResponseSchema.parse(await retryClaim.json());
  expect(retryClaimBody.status).toBe("claimed");
  if (retryClaimBody.status !== "claimed") throw new Error("expected claimed status");
  expect(retryClaimBody.receiverToken).toBe(claim.receiverToken);
  expect(retryClaimBody.session.state).toBe("reconnecting");
});

test("expired reconnect grace rejects sender reattach and Receiver Token re-entry before alarm runs", async () => {
  resetEdgeSessionsForTests();
  const objects = createDurableObjects();
  const env = createEnv(objects);
  const pairs = installFakeWebSocketPair();
  const { body: created } = await createSession(env);
  const session = CreateSessionResponseSchema.parse(created);
  const claim = await claimReceiver(env, session.sessionId);

  expect(
    (
      await handleRequest(
        websocketRequest(`/ws/${session.sessionId}/sender/${session.senderToken}`),
        env,
      )
    ).status,
  ).toBe(101);
  expect(
    (
      await handleRequest(
        websocketRequest(`/ws/${session.sessionId}/receiver/${claim.receiverToken}`),
        env,
      )
    ).status,
  ).toBe(101);

  const senderPair = pairs[0];
  if (!senderPair) throw new Error("expected sender socket");
  senderPair.client.close(1000, "sender tab closed");
  const reconnectView = await handleRequest(request(`/api/sessions/${session.sessionId}`), env);
  expect(SessionPublicViewSchema.parse(await reconnectView.json()).state).toBe("reconnecting");

  const alarmAt = await (
    objects.SESSION_OBJECT as unknown as MemoryDurableObjectNamespace<SessionDurableObject>
  )
    .storageForName(session.sessionId)
    .getAlarm();
  if (alarmAt === null) throw new Error("reconnect timeout alarm must be scheduled");
  setEdgeNowForTests(() => alarmAt + 1);

  const reattach = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/sender/${session.senderToken}`),
    env,
  );
  expect(reattach.status).toBe(401);

  const retryClaim = await handleRequest(
    request(`/api/sessions/${session.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverToken: claim.receiverToken }),
    }),
    env,
  );
  const retryClaimBody = ClaimSessionResponseSchema.parse(await retryClaim.json());
  expect(retryClaimBody.status).toBe("ended");
  expect(retryClaimBody.session.state).toBe("ended");
  expect(retryClaimBody.session.ended).toBe(true);
  resetEdgeSessionsForTests();
});

test("Worker rejects invalid Direct Transfer WebSocket session, role, and token", async () => {
  const env = createEnv(createDurableObjects());
  installFakeWebSocketPair();
  const { body: created } = await createSession(env);
  const session = CreateSessionResponseSchema.parse(created);

  const noUpgrade = await handleRequest(
    request(`/ws/${session.sessionId}/sender/${session.senderToken}`),
    env,
  );
  expect(noUpgrade.status).toBe(426);

  const invalidRole = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/viewer/${session.senderToken}`),
    env,
  );
  expect(invalidRole.status).toBe(401);

  const invalidToken = await handleRequest(
    websocketRequest(`/ws/${session.sessionId}/sender/not-the-sender-token`),
    env,
  );
  expect(invalidToken.status).toBe(401);

  const missingSession = await handleRequest(
    websocketRequest("/ws/missing-session/sender/token"),
    env,
  );
  expect(missingSession.status).toBe(404);
});
