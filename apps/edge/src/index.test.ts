import { expect, test } from "bun:test";

import {
  AccessCodeResolveResponseSchema,
  ClaimSessionResponseSchema,
  CreateSessionResponseSchema,
  SessionAccessCodeSchema,
  SessionPublicViewSchema,
} from "@p2pfile/shared";
import { resetEdgeSessionsForTests, type SessionDurableObject, setEdgeNowForTests } from "./index";
import {
  claimReceiver,
  createDurableObjects,
  createEnv,
  createSession,
  handleRequest,
  type MemoryDurableObjectNamespace,
  manifest,
  request,
} from "./test-support";

test("Worker local dev serves SPA fallback routes for Share Link entry", async () => {
  const env = createEnv();
  for (const path of ["/", "/receive", "/f/abcdef123456"]) {
    const response = await handleRequest(request(path), env);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain('<div id="root"></div>');
  }
});

test("API and WebSocket paths run Worker code before static assets", async () => {
  const env = createEnv();

  for (const path of ["/api/not-found", "/ws/not-found"]) {
    const response = await handleRequest(request(path, { headers: { accept: "text/html" } }), env);
    const body = await response.text();

    expect(response.status).not.toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).not.toContain('<div id="root"></div>');
  }
});

test("sender creates a contract-compatible Temporary Session Window", async () => {
  resetEdgeSessionsForTests();
  const { response, body } = await createSession();
  const parsed = CreateSessionResponseSchema.parse(body);

  expect(response.status).toBe(201);
  expect(parsed.sessionId).toMatch(/^[a-f0-9]{12}$/);
  expect(parsed.accessCode).toMatch(/^[A-Z2-9]{6}$/);
  expect(parsed.senderToken.length).toBeGreaterThan(16);
  expect(parsed.sharePath).toBe(`/f/${parsed.sessionId}`);
  expect(parsed.session.state).toBe("waiting");
  expect(parsed.session.transferMode).toBe("direct");
  expect(parsed.session.summary).toEqual({ fileCount: 2, totalSize: 50 });
  expect(parsed.session.manifest).toEqual(manifest);
});

test("Share Link receiver sees a metadata-only Frozen Manifest", async () => {
  resetEdgeSessionsForTests();
  const { body } = await createSession();
  const created = CreateSessionResponseSchema.parse(body);

  const response = await handleRequest(request(`/api/sessions/${created.sessionId}`), createEnv());
  const rawBody = await response.text();
  const parsed = SessionPublicViewSchema.parse(JSON.parse(rawBody));

  expect(response.status).toBe(200);
  expect(parsed.state).toBe("viewing");
  expect(parsed.canClaim).toBe(true);
  expect(parsed.manifest).toEqual(manifest);
  expect(parsed.summary).toEqual({ fileCount: 2, totalSize: 50 });
  expect(rawBody).not.toMatch(
    /alpha file from playwright|thumbnail|previewUrl|thumbnailUrl|r2:\/\/|\bR2\b|\bKV\b|\bD1\b|staged/i,
  );
});

test("Access Code resolves to the same Temporary Session Window as the Share Link", async () => {
  resetEdgeSessionsForTests();
  const { body } = await createSession();
  const created = CreateSessionResponseSchema.parse(body);
  const normalizedCode = SessionAccessCodeSchema.parse(`  ${created.accessCode.toLowerCase()}  `);

  const response = await handleRequest(
    request(`/api/access-codes/${encodeURIComponent(`  ${created.accessCode.toLowerCase()}  `)}`),
    createEnv(),
  );
  const resolved = AccessCodeResolveResponseSchema.parse(await response.json());
  const sessionResponse = await handleRequest(
    request(resolved.sharePath.replace("/f/", "/api/sessions/")),
    createEnv(),
  );
  const session = SessionPublicViewSchema.parse(await sessionResponse.json());

  expect(response.status).toBe(200);
  expect(normalizedCode).toBe(created.accessCode);
  expect(resolved).toEqual({ sessionId: created.sessionId, sharePath: created.sharePath });

  expect(session.sessionId).toBe(created.sessionId);
  expect(session.manifest).toEqual(manifest);
});

test("Open Session TTL alarm deletes unclaimed sessions and their expired Access Code mapping", async () => {
  resetEdgeSessionsForTests();
  const objects = createDurableObjects();
  const env = createEnv(objects);
  const { body } = await createSession(env);
  const created = CreateSessionResponseSchema.parse(body);
  const expiresAt = created.session.expiresAt;
  if (expiresAt === null) throw new Error("session expiry is required for open sessions");

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

  const expiredSession = await handleRequest(request(`/api/sessions/${created.sessionId}`), env);
  const expiredCode = await handleRequest(request(`/api/access-codes/${created.accessCode}`), env);

  expect(expiredSession.status).toBe(404);
  expect((await expiredSession.json()) as unknown).toEqual({ message: "session not found" });
  expect(expiredCode.status).toBe(404);
  expect((await expiredCode.json()) as unknown).toEqual({ message: "session not found" });
});

test("Open Session TTL alarm does not end claimed sessions", async () => {
  resetEdgeSessionsForTests();
  const objects = createDurableObjects();
  const env = createEnv(objects);
  const { body } = await createSession(env);
  const created = CreateSessionResponseSchema.parse(body);
  const expiresAt = created.session.expiresAt;
  if (expiresAt === null) throw new Error("session expiry is required for open sessions");
  const claimed = await claimReceiver(env, created.sessionId);

  const sessionStorage = (
    objects.SESSION_OBJECT as unknown as MemoryDurableObjectNamespace<SessionDurableObject>
  ).storageForName(created.sessionId);
  expect(await sessionStorage.getAlarm()).toBeNull();

  setEdgeNowForTests(() => expiresAt + 1);
  await (
    objects.SESSION_OBJECT as unknown as MemoryDurableObjectNamespace<
      SessionDurableObject & { alarm: () => Promise<void> }
    >
  )
    .instanceForName(created.sessionId)
    .alarm();

  const view = await handleRequest(request(`/api/sessions/${created.sessionId}`), env);
  const viewBody = SessionPublicViewSchema.parse(await view.json());
  expect(view.status).toBe(200);
  expect(viewBody.state).toBe("claimed");
  expect(viewBody.claimed).toBe(true);
  expect(viewBody.expiresAt).toBeNull();

  const reenter = await handleRequest(
    request(`/api/sessions/${created.sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverToken: claimed.receiverToken }),
    }),
    env,
  );
  const reenterBody = ClaimSessionResponseSchema.parse(await reenter.json());
  expect(reenterBody.status).toBe("claimed");
});

test("Durable Object env preserves session and Access Code across Worker handler instances", async () => {
  resetEdgeSessionsForTests();
  const bindings = createDurableObjects();
  const firstWorkerEnv = createEnv(bindings);
  const secondWorkerEnv = createEnv(bindings);
  const { body } = await createSession(firstWorkerEnv);
  const created = CreateSessionResponseSchema.parse(body);

  const resolvedResponse = await handleRequest(
    request(`/api/access-codes/${created.accessCode.toLowerCase()}`),
    secondWorkerEnv,
  );
  const resolved = AccessCodeResolveResponseSchema.parse(await resolvedResponse.json());
  const sessionResponse = await handleRequest(
    request(`/api/sessions/${resolved.sessionId}`),
    secondWorkerEnv,
  );
  const session = SessionPublicViewSchema.parse(await sessionResponse.json());

  expect(resolvedResponse.status).toBe(200);
  expect(resolved).toEqual({ sessionId: created.sessionId, sharePath: created.sharePath });
  expect(sessionResponse.status).toBe(200);
  expect(session.sessionId).toBe(created.sessionId);
  expect(session.manifest).toEqual(manifest);
});

test("Access Code lookup returns contract-compatible errors for unknown and expired codes", async () => {
  resetEdgeSessionsForTests();
  const unknown = await handleRequest(request("/api/access-codes/ABC234"), createEnv());
  expect(unknown.status).toBe(404);
  const unknownBody = (await unknown.json()) as { message: string };
  expect(unknownBody).toEqual({ message: "session not found" });

  const { body } = await createSession();
  const created = CreateSessionResponseSchema.parse(body);
  const expiresAt = created.session.expiresAt;
  if (expiresAt === null) throw new Error("session expiry is required for open sessions");
  setEdgeNowForTests(() => expiresAt + 1);

  const expiredCode = await handleRequest(
    request(`/api/access-codes/${created.accessCode}`),
    createEnv(),
  );
  const expiredSession = await handleRequest(
    request(`/api/sessions/${created.sessionId}`),
    createEnv(),
  );

  expect(expiredCode.status).toBe(404);
  const expiredCodeBody = (await expiredCode.json()) as { message: string };
  const expiredSessionBody = (await expiredSession.json()) as { message: string };
  expect(expiredCodeBody).toEqual({ message: "session not found" });
  expect(expiredSession.status).toBe(404);
  expect(expiredSessionBody).toEqual({ message: "session not found" });
});
