import { expect, test } from "bun:test";
import { createApp } from "./app";

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

test("complete and end endpoints reject invalid tokens", async () => {
  const { app, body } = await createSession();
  const claimResponse = await app.request(
    createJsonRequest("POST", `/api/sessions/${body.sessionId}/claim`, {}),
  );
  const claim = await claimResponse.json();

  const invalidComplete = await app.request(
    createJsonRequest("POST", `/api/sessions/${body.sessionId}/complete`, {
      receiverToken: "invalid-token-invalid-token",
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
