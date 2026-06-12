import { expect, test } from "bun:test";

import {
  ClaimSessionResponseSchema,
  CreateSessionResponseSchema,
  DEFAULT_RETRY_BUDGET,
  ReleaseSessionResponseSchema,
  SessionMutationResponseSchema,
} from "@p2pfile/shared";
import { resetEdgeSessionsForTests } from "./index";
import {
  claimReceiver,
  createEnv,
  createSession,
  handleRequest,
  manifest,
  request,
} from "./test-support";

test("Receiver Token claim is exclusive and token holder can re-enter", async () => {
  resetEdgeSessionsForTests();
  const env = createEnv();
  const { body } = await createSession(env);
  const created = CreateSessionResponseSchema.parse(body);

  const firstClaim = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  const firstBody = ClaimSessionResponseSchema.parse(await firstClaim.json());
  if (firstBody.status !== "claimed") throw new Error("expected first claim to succeed");

  const occupiedClaim = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  const occupiedBody = ClaimSessionResponseSchema.parse(await occupiedClaim.json());

  const reentryClaim = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverToken: firstBody.receiverToken }),
    }),
    env,
  );
  const reentryBody = ClaimSessionResponseSchema.parse(await reentryClaim.json());

  expect(firstClaim.status).toBe(200);
  expect(firstBody.session.state).toBe("claimed");
  expect(firstBody.session.claimed).toBe(true);
  expect(firstBody.session.canClaim).toBe(false);
  expect(occupiedClaim.status).toBe(200);
  expect(occupiedBody.status).toBe("occupied");
  expect(occupiedBody.session.claimed).toBe(true);
  expect(reentryClaim.status).toBe(200);
  expect(reentryBody.status).toBe("claimed");
  if (reentryBody.status !== "claimed") throw new Error("expected re-entry claim");
  expect(reentryBody.receiverToken).toBe(firstBody.receiverToken);
  expect(reentryBody.retriesRemaining).toBe(firstBody.retriesRemaining - 1);
});

test("original Receiver Token holder can retry until the bounded budget is exhausted", async () => {
  resetEdgeSessionsForTests();
  const env = createEnv();
  const { body } = await createSession(env);
  const created = CreateSessionResponseSchema.parse(body);
  const firstClaim = await claimReceiver(env, created.sessionId);

  let retriesRemaining = firstClaim.retriesRemaining;
  for (let retry = 1; retry <= DEFAULT_RETRY_BUDGET; retry += 1) {
    const retryResponse = await handleRequest(
      request(`/api/sessions/${created.sessionId}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receiverToken: firstClaim.receiverToken }),
      }),
      env,
    );
    const retryBody = ClaimSessionResponseSchema.parse(await retryResponse.json());
    expect(retryBody.status).toBe("claimed");
    if (retryBody.status !== "claimed") throw new Error("expected retry claim");
    retriesRemaining -= 1;
    expect(retryBody.receiverToken).toBe(firstClaim.receiverToken);
    expect(retryBody.retriesRemaining).toBe(retriesRemaining);
  }

  const exhausted = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverToken: firstClaim.receiverToken }),
    }),
    env,
  );
  const exhaustedBody = ClaimSessionResponseSchema.parse(await exhausted.json());
  expect(exhaustedBody.status).toBe("failed");
  expect(exhaustedBody.session.state).toBe("failed");
  expect(exhaustedBody.session.failureReason).toBe("retry-budget-exhausted");
  expect(exhaustedBody.session.retriesRemaining).toBe(0);

  const lateVisitor = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  const lateVisitorBody = ClaimSessionResponseSchema.parse(await lateVisitor.json());
  expect(lateVisitorBody.status).toBe("failed");
  expect(lateVisitorBody.session.state).toBe("failed");
});

test("Receiver Token holder can release claim and invalid tokens cannot release", async () => {
  resetEdgeSessionsForTests();
  const env = createEnv();
  const { body } = await createSession(env);
  const created = CreateSessionResponseSchema.parse(body);
  const claimedResponse = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  const claimed = ClaimSessionResponseSchema.parse(await claimedResponse.json());
  if (claimed.status !== "claimed") throw new Error("expected claim to succeed");

  const invalidRelease = await handleRequest(
    request(`/api/sessions/${created.sessionId}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverToken: "invalid-token-invalid-token" }),
    }),
    env,
  );
  const invalidReleaseBody = ReleaseSessionResponseSchema.parse(await invalidRelease.json());
  const occupiedAfterInvalid = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  const occupiedAfterInvalidBody = ClaimSessionResponseSchema.parse(
    await occupiedAfterInvalid.json(),
  );

  const release = await handleRequest(
    request(`/api/sessions/${created.sessionId}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverToken: claimed.receiverToken }),
    }),
    env,
  );
  const releaseBody = ReleaseSessionResponseSchema.parse(await release.json());

  const newClaim = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  const newClaimBody = ClaimSessionResponseSchema.parse(await newClaim.json());

  expect(invalidRelease.status).toBe(200);
  expect(invalidReleaseBody.status).toBe("invalid-token");
  expect(invalidReleaseBody.session.claimed).toBe(true);
  expect(occupiedAfterInvalid.status).toBe(200);
  expect(occupiedAfterInvalidBody.status).toBe("occupied");
  expect(release.status).toBe(200);
  expect(releaseBody.status).toBe("released");
  expect(releaseBody.session.state).toBe("waiting");
  expect(releaseBody.session.canClaim).toBe(true);
  expect(releaseBody.session.claimed).toBe(false);
  expect(newClaim.status).toBe(200);
  expect(newClaimBody.status).toBe("claimed");
  if (newClaimBody.status !== "claimed") throw new Error("expected new claim");
  expect(newClaimBody.receiverToken).not.toBe(claimed.receiverToken);
});

test("completeSession rejects invalid Receiver Token values", async () => {
  resetEdgeSessionsForTests();
  const env = createEnv();
  const { body } = await createSession(env);
  const created = CreateSessionResponseSchema.parse(body);
  await claimReceiver(env, created.sessionId);

  const malformed = await handleRequest(
    request(`/api/sessions/${created.sessionId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        receiverToken: "short",
        completedFiles: manifest.map((file) => ({ id: file.id, bytes: file.size })),
        totalBytes: created.session.summary.totalSize,
      }),
    }),
    env,
  );
  const wrongToken = await handleRequest(
    request(`/api/sessions/${created.sessionId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        receiverToken: "wrong-token-wrong-token",
        completedFiles: manifest.map((file) => ({ id: file.id, bytes: file.size })),
        totalBytes: created.session.summary.totalSize,
      }),
    }),
    env,
  );

  const malformedBody = (await malformed.json()) as unknown;
  const wrongTokenBody = (await wrongToken.json()) as unknown;

  expect(malformed.status).toBe(400);
  expect(malformedBody).toEqual({ message: "invalid request body" });
  expect(wrongToken.status).toBe(404);
  expect(wrongTokenBody).toEqual({ message: "session not found" });
});

test("completeSession rejects premature completion before full File Manifest integrity passes", async () => {
  resetEdgeSessionsForTests();
  const env = createEnv();
  const { body } = await createSession(env);
  const created = CreateSessionResponseSchema.parse(body);
  const claimed = await claimReceiver(env, created.sessionId);

  const premature = await handleRequest(
    request(`/api/sessions/${created.sessionId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        receiverToken: claimed.receiverToken,
        completedFiles: [{ id: manifest[0]?.id ?? "", bytes: manifest[0]?.size ?? 0 }],
        totalBytes: manifest[0]?.size ?? 0,
      }),
    }),
    env,
  );
  const stillOccupied = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  const occupiedBody = ClaimSessionResponseSchema.parse(await stillOccupied.json());

  const prematureBody = (await premature.json()) as unknown;

  expect(premature.status).toBe(409);
  expect(prematureBody).toEqual({ message: "manifest integrity check incomplete" });
  expect(occupiedBody.status).toBe("occupied");
});

test("full-manifest completion creates owner-only Completed Session View without file copies", async () => {
  resetEdgeSessionsForTests();
  const env = createEnv();
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
  const originalReceiver = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverToken: claimed.receiverToken }),
    }),
    env,
  );
  const originalReceiverBody = ClaimSessionResponseSchema.parse(await originalReceiver.json());
  const nonOwner = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  const nonOwnerBody = ClaimSessionResponseSchema.parse(await nonOwner.json());
  const publicView = await handleRequest(request(`/api/sessions/${created.sessionId}`), env);
  const publicViewBody = await publicView.text();

  expect(completed.status).toBe(200);
  expect(completedBody.session.state).toBe("completed-view");
  expect(completedBody.session.completed).toBe(true);
  expect(completedBody.session.expiresAt).toBeGreaterThan(Date.now());
  expect(originalReceiverBody.status).toBe("completed");
  if (originalReceiverBody.status !== "completed") throw new Error("expected completed claim");
  expect(originalReceiverBody.originalReceiver).toBe(true);
  expect(nonOwnerBody.status).toBe("completed");
  if (nonOwnerBody.status !== "completed") throw new Error("expected completed claim");
  expect(nonOwnerBody.originalReceiver).toBe(false);
  expect(publicViewBody).not.toMatch(
    /alpha file from playwright|thumbnail|previewUrl|thumbnailUrl|r2:\/\/|\bR2\b|\bKV\b|\bD1\b|staged/i,
  );
});
