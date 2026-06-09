import {
  AccessCodeResolveResponseSchema,
  APP_NAME,
  AppStatusSchema,
  ClaimSessionRequestSchema,
  CompleteSessionRequestSchema,
  CreateSessionRequestSchema,
  EndSessionRequestSchema,
  ReleaseSessionRequestSchema,
  SessionRoleSchema,
} from "@p2pfile/shared";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { LiveSessionStore, type LiveSessionStoreOptions } from "./runtime";

const badRequest = (message: string) => new HTTPException(400, { message });
const unauthorized = () => new HTTPException(401, { message: "invalid token" });
const notFound = () => new HTTPException(404, { message: "session not found" });

const parseJsonBody = async <T>(
  request: Request,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest("invalid json body");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("invalid request body");
  }

  return parsed.data;
};

export const createApp = (options: LiveSessionStoreOptions = {}) => {
  const store = new LiveSessionStore(options);
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["content-type"],
    }),
  );

  app.get("/api/status", (c) => {
    return c.json(
      AppStatusSchema.parse({
        ok: true,
        service: "signal",
        product: APP_NAME,
      }),
    );
  });

  app.post("/api/sessions", async (c) => {
    const input = await parseJsonBody(c.req.raw, CreateSessionRequestSchema);
    return c.json(store.createSession(input), 201);
  });

  app.get("/api/sessions/:id", (c) => {
    const session = store.getPublicSession(c.req.param("id"));
    if (!session) {
      throw notFound();
    }

    return c.json(session);
  });

  app.post("/api/sessions/:id/claim", async (c) => {
    const input = await parseJsonBody(c.req.raw, ClaimSessionRequestSchema);
    const result = store.claimSession(c.req.param("id"), input.receiverToken);
    if (!result) {
      throw notFound();
    }

    return c.json(result);
  });

  app.post("/api/sessions/:id/release", async (c) => {
    const input = await parseJsonBody(c.req.raw, ReleaseSessionRequestSchema);
    const result = store.releaseSession(c.req.param("id"), input);
    if (!result) {
      throw unauthorized();
    }

    return c.json(result);
  });

  app.post("/api/sessions/:id/complete", async (c) => {
    const input = await parseJsonBody(c.req.raw, CompleteSessionRequestSchema);
    const result = store.completeSession(c.req.param("id"), input);
    if (!result) {
      throw unauthorized();
    }

    return c.json(result);
  });

  app.post("/api/sessions/:id/end", async (c) => {
    const input = await parseJsonBody(c.req.raw, EndSessionRequestSchema);
    const result = store.endSession(c.req.param("id"), input);
    if (!result) {
      throw unauthorized();
    }

    return c.json(result);
  });

  app.get("/api/access-codes/:code", (c) => {
    const resolved = store.resolveAccessCode(c.req.param("code"));
    if (!resolved) {
      throw notFound();
    }

    return c.json(AccessCodeResolveResponseSchema.parse(resolved));
  });

  app.get(
    "/ws/:sessionId/:role/:token",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("sessionId");
      const roleResult = SessionRoleSchema.safeParse(c.req.param("role"));
      const token = c.req.param("token");
      if (!sessionId || !token) {
        throw unauthorized();
      }
      if (!roleResult.success) {
        throw unauthorized();
      }

      const role = roleResult.data;
      return {
        onOpen(_event, ws) {
          if (!store.connectSocket(sessionId, role, token, ws.raw)) {
            ws.close(1008, "invalid session websocket");
          }
        },
        onMessage(event, ws) {
          if (!store.handleSignal(sessionId, role, token, event.data.toString())) {
            ws.close(1003, "invalid signal payload");
          }
        },
        onClose() {
          store.disconnectSocket(sessionId, role, token);
        },
      };
    }),
  );

  return { app, store };
};
