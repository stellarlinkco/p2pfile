import {
  AccessCodeResolveResponseSchema,
  APP_NAME,
  AppStatusSchema,
  type ClaimSessionRequest,
  ClaimSessionRequestSchema,
  type CompleteSessionRequest,
  CompleteSessionRequestSchema,
  type CreateSessionRequest,
  CreateSessionRequestSchema,
  type CreateSessionResponse,
  CreateSessionResponseSchema,
  type EndSessionRequest,
  EndSessionRequestSchema,
  type ReleaseSessionRequest,
  ReleaseSessionRequestSchema,
  SessionAccessCodeSchema,
} from "@p2pfile/shared";

import type { EdgeEnv } from "./env";
import { badRequest, json, notFound } from "./responses";
import {
  cloneManifest,
  createInitialSession,
  DIRECTORY_OBJECT_NAME,
  type SessionCreatePayload,
  type SessionDirectoryRegisterPayload,
  toPublicSession,
} from "./session-record";

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function parseSessionRequest(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  const parsed = CreateSessionRequestSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

async function parseJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function parseClaimRequest(request: Request): Promise<ClaimSessionRequest | null> {
  const parsed = ClaimSessionRequestSchema.safeParse(await parseJsonBody(request));
  return parsed.success ? parsed.data : null;
}

async function parseReleaseRequest(request: Request): Promise<ReleaseSessionRequest | null> {
  const parsed = ReleaseSessionRequestSchema.safeParse(await parseJsonBody(request));
  return parsed.success ? parsed.data : null;
}

async function parseCompleteRequest(request: Request): Promise<CompleteSessionRequest | null> {
  const parsed = CompleteSessionRequestSchema.safeParse(await parseJsonBody(request));
  return parsed.success ? parsed.data : null;
}

async function parseEndRequest(request: Request): Promise<EndSessionRequest | null> {
  const parsed = EndSessionRequestSchema.safeParse(await parseJsonBody(request));
  return parsed.success ? parsed.data : null;
}

function sessionStub(env: EdgeEnv, sessionId: string) {
  const id = env.SESSION_OBJECT.idFromName(sessionId);
  return env.SESSION_OBJECT.get(id);
}

function directoryStub(env: EdgeEnv) {
  const id = env.SESSION_DIRECTORY.idFromName(DIRECTORY_OBJECT_NAME);
  return env.SESSION_DIRECTORY.get(id);
}

function internalRequest(path: string, init?: RequestInit) {
  return new Request(`https://internal.p2pfile${path}`, init);
}

async function createSession(
  input: CreateSessionRequest,
  env: EdgeEnv,
): Promise<CreateSessionResponse> {
  const manifest = cloneManifest(input.manifest);
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const session = createInitialSession(manifest);
    const created = await sessionStub(env, session.id).fetch(
      internalRequest("/create", {
        method: "POST",
        body: JSON.stringify({ session } satisfies SessionCreatePayload),
      }),
    );
    if (created.status === 409) continue;
    if (!created.ok) throw new Error("SessionObject create failed.");

    const registered = await directoryStub(env).fetch(
      internalRequest("/register", {
        method: "POST",
        body: JSON.stringify({
          accessCode: session.accessCode,
          sessionId: session.id,
        } satisfies SessionDirectoryRegisterPayload),
      }),
    );
    if (registered.status === 409) {
      await sessionStub(env, session.id).fetch(internalRequest("/delete", { method: "POST" }));
      continue;
    }
    if (!registered.ok) throw new Error("SessionDirectory register failed.");

    return CreateSessionResponseSchema.parse({
      sessionId: session.id,
      accessCode: session.accessCode,
      sharePath: session.sharePath,
      senderToken: session.senderToken,
      session: toPublicSession(session),
    });
  }
  throw new Error("Unable to allocate a unique session.");
}

export async function handleApi(request: Request, env: EdgeEnv, url: URL) {
  if (request.method === "GET" && url.pathname === "/api/status") {
    return json(AppStatusSchema.parse({ ok: true, service: "signal", product: APP_NAME }));
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const input = await parseSessionRequest(request);
    if (!input) return badRequest("invalid request body");
    return json(await createSession(input, env), { status: 201 });
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch) {
    return sessionStub(env, sessionMatch[1] ?? "").fetch(internalRequest("/view"));
  }

  const accessCodeMatch = url.pathname.match(/^\/api\/access-codes\/([^/]+)$/);
  if (request.method === "GET" && accessCodeMatch) {
    const parsedCode = SessionAccessCodeSchema.safeParse(
      decodePathSegment(accessCodeMatch[1] ?? ""),
    );
    if (!parsedCode.success) return notFound("session not found");

    const resolved = await directoryStub(env).fetch(internalRequest(`/resolve/${parsedCode.data}`));
    if (!resolved.ok) return notFound("session not found");
    const { sessionId } = (await resolved.json()) as { sessionId: string };
    const session = await sessionStub(env, sessionId).fetch(internalRequest("/view"));
    if (!session.ok) {
      await directoryStub(env).fetch(
        internalRequest(`/delete/${parsedCode.data}`, { method: "POST" }),
      );
      return notFound("session not found");
    }
    return json(AccessCodeResolveResponseSchema.parse({ sessionId, sharePath: `/f/${sessionId}` }));
  }

  const claimMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/claim$/);
  if (request.method === "POST" && claimMatch) {
    const input = await parseClaimRequest(request);
    if (!input) return badRequest("invalid request body");
    return sessionStub(env, claimMatch[1] ?? "").fetch(
      internalRequest("/claim", { method: "POST", body: JSON.stringify(input) }),
    );
  }

  const releaseMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/release$/);
  const completeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/complete$/);
  if (request.method === "POST" && completeMatch) {
    const input = await parseCompleteRequest(request);
    if (!input) return badRequest("invalid request body");
    return sessionStub(env, completeMatch[1] ?? "").fetch(
      internalRequest("/complete", { method: "POST", body: JSON.stringify(input) }),
    );
  }

  const endMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/end$/);
  if (request.method === "POST" && endMatch) {
    const input = await parseEndRequest(request);
    if (!input) return badRequest("invalid request body");
    return sessionStub(env, endMatch[1] ?? "").fetch(
      internalRequest("/end", { method: "POST", body: JSON.stringify(input) }),
    );
  }

  if (request.method === "POST" && releaseMatch) {
    const input = await parseReleaseRequest(request);
    if (!input) return badRequest("invalid request body");
    return sessionStub(env, releaseMatch[1] ?? "").fetch(
      internalRequest("/release", { method: "POST", body: JSON.stringify(input) }),
    );
  }
  return notFound("api route not found");
}

export async function handleWebSocket(request: Request, env: EdgeEnv, url: URL) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ message: "websocket upgrade required" }, { status: 426 });
  }

  const match = url.pathname.match(/^\/ws\/([^/]+)\/(sender|receiver)\/([^/]+)$/);
  if (!match) return json({ message: "invalid session websocket" }, { status: 401 });
  return sessionStub(env, match[1] ?? "").fetch(request);
}
