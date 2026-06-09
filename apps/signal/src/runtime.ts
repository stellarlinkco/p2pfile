import {
  AccessCodeResolveResponseSchema,
  ClaimSessionResponseSchema,
  type CompleteSessionRequest,
  type CreateSessionRequest,
  CreateSessionResponseSchema,
  type EndSessionRequest,
  type ReleaseSessionRequest,
  SessionMutationResponseSchema,
  SessionPublicViewSchema,
  type SessionRole,
  SignalEnvelopeSchema,
} from "@p2pfile/shared";
import type { ServerWebSocket } from "bun";
import { deleteStoredSession, markSessionEnded } from "./session-lifecycle";
import {
  DEFAULT_COMPLETED_VIEW_TTL_MS,
  DEFAULT_HEARTBEAT_TTL_MS,
  DEFAULT_OPEN_SESSION_TTL_MS,
  DEFAULT_SHARE_PATH_PREFIX,
  type LiveSessionStoreOptions,
  type StoredSession,
} from "./session-model";
import { detachSocket, isValidRoleToken, sendToPeer } from "./session-sockets";
import { generateAccessCode, generateSessionId, generateToken } from "./session-tokens";
import { buildSummary, toPublicSession } from "./session-view";

export type { LiveSessionStoreOptions } from "./session-model";

export class LiveSessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly accessCodes = new Map<string, string>();
  private readonly openSessionTtlMs: number;
  private readonly completedViewTtlMs: number;
  private readonly heartbeatTtlMs: number;
  private readonly sharePathPrefix: string;
  private readonly now: () => number;

  constructor(options: LiveSessionStoreOptions = {}) {
    this.openSessionTtlMs = options.openSessionTtlMs ?? DEFAULT_OPEN_SESSION_TTL_MS;
    this.completedViewTtlMs = options.completedViewTtlMs ?? DEFAULT_COMPLETED_VIEW_TTL_MS;
    this.heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    this.sharePathPrefix = options.sharePathPrefix ?? DEFAULT_SHARE_PATH_PREFIX;
    this.now = options.now ?? Date.now;
  }

  createSession(input: CreateSessionRequest) {
    this.sweepExpired();
    const id = generateSessionId();
    const accessCode = generateAccessCode(this.accessCodes);
    const senderToken = generateToken();
    const createdAt = this.now();
    const manifest = input.manifest.map((item) => ({ ...item }));
    const session: StoredSession = {
      id,
      accessCode,
      sharePath: `${this.sharePathPrefix}/${id}`,
      senderToken,
      receiverToken: null,
      manifest,
      summary: buildSummary(manifest),
      state: "waiting",
      transferMode: "direct",
      createdAt,
      openExpiresAt: createdAt + this.openSessionTtlMs,
      completedViewExpiresAt: null,
      endedAt: null,
      completedAt: null,
      senderLastSeenAt: createdAt,
      sockets: {},
    };
    this.sessions.set(id, session);
    this.accessCodes.set(accessCode, id);
    return CreateSessionResponseSchema.parse({
      sessionId: id,
      accessCode,
      sharePath: session.sharePath,
      senderToken,
      session: toPublicSession(session),
    });
  }

  getPublicSession(sessionId: string) {
    this.sweepExpired();
    const session = this.sessions.get(sessionId);
    return session ? SessionPublicViewSchema.parse(toPublicSession(session)) : null;
  }

  claimSession(sessionId: string, receiverToken?: string) {
    this.sweepExpired();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.state === "ended") {
      return ClaimSessionResponseSchema.parse({
        status: "ended",
        session: toPublicSession(session),
      });
    }
    if (session.state === "completed-view") {
      return ClaimSessionResponseSchema.parse({
        status: "completed",
        originalReceiver: Boolean(receiverToken && receiverToken === session.receiverToken),
        session: toPublicSession(session),
      });
    }
    if (session.state === "claimed") {
      if (receiverToken && receiverToken === session.receiverToken) {
        return ClaimSessionResponseSchema.parse({
          status: "claimed",
          receiverToken,
          session: toPublicSession(session),
        });
      }
      return ClaimSessionResponseSchema.parse({
        status: "occupied",
        session: toPublicSession(session),
      });
    }
    session.state = "claimed";
    session.receiverToken = generateToken();
    session.openExpiresAt = null;
    return ClaimSessionResponseSchema.parse({
      status: "claimed",
      receiverToken: session.receiverToken,
      session: toPublicSession(session),
    });
  }

  releaseSession(sessionId: string, input: ReleaseSessionRequest) {
    this.sweepExpired();
    const session = this.sessions.get(sessionId);
    if (session?.state !== "claimed" || session.receiverToken !== input.receiverToken) return null;
    session.state = "waiting";
    session.receiverToken = null;
    session.openExpiresAt = this.now() + this.openSessionTtlMs;
    detachSocket(session, "receiver");
    return SessionMutationResponseSchema.parse({ ok: true, session: toPublicSession(session) });
  }

  completeSession(sessionId: string, input: CompleteSessionRequest) {
    this.sweepExpired();
    const session = this.sessions.get(sessionId);
    if (session?.state !== "claimed" || session.receiverToken !== input.receiverToken) return null;
    const completedAt = this.now();
    session.state = "completed-view";
    session.completedAt = completedAt;
    session.completedViewExpiresAt = completedAt + this.completedViewTtlMs;
    session.openExpiresAt = null;
    sendToPeer(session, "receiver", { type: "transfer-complete", payload: { completedAt } });
    return SessionMutationResponseSchema.parse({ ok: true, session: toPublicSession(session) });
  }

  endSession(sessionId: string, input: EndSessionRequest) {
    this.sweepExpired();
    const session = this.sessions.get(sessionId);
    if (!session || session.senderToken !== input.senderToken) return null;
    if (session.state !== "completed-view") {
      markSessionEnded(session, this.now(), "sender-ended");
    }
    return SessionMutationResponseSchema.parse({ ok: true, session: toPublicSession(session) });
  }

  resolveAccessCode(code: string) {
    this.sweepExpired();
    const sessionId = this.accessCodes.get(code.trim().toUpperCase());
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.accessCodes.delete(code.trim().toUpperCase());
      return null;
    }
    return AccessCodeResolveResponseSchema.parse({ sessionId, sharePath: session.sharePath });
  }

  connectSocket(
    sessionId: string,
    role: SessionRole,
    token: string,
    socket: ServerWebSocket<unknown>,
  ) {
    this.sweepExpired();
    const session = this.sessions.get(sessionId);
    if (!session || !isValidRoleToken(session, role, token) || session.state === "ended")
      return false;
    if (role === "receiver" && session.state === "waiting") return false;
    detachSocket(session, role);
    session.sockets[role] = socket;
    if (role === "sender") session.senderLastSeenAt = this.now();
    return true;
  }

  disconnectSocket(sessionId: string, role: SessionRole, token: string) {
    const session = this.sessions.get(sessionId);
    if (!session || !isValidRoleToken(session, role, token)) return;
    detachSocket(session, role);
    if (role === "sender" && session.state !== "completed-view") {
      markSessionEnded(session, this.now(), "sender-disconnected");
    }
  }

  handleSignal(sessionId: string, role: SessionRole, token: string, rawMessage: string) {
    const session = this.sessions.get(sessionId);
    if (!session || !isValidRoleToken(session, role, token) || session.state === "ended")
      return false;
    const envelope = this.parseSignal(rawMessage);
    if (!envelope) return false;
    if (role === "sender") session.senderLastSeenAt = this.now();
    if (envelope.type === "sender-heartbeat") return true;
    if (envelope.type === "mode") session.transferMode = envelope.payload.mode;
    if (envelope.type === "receiver-ready" && role === "receiver") {
      session.sockets.sender?.send(JSON.stringify(envelope));
      return true;
    }
    if (envelope.type === "sender-left") {
      if (session.state !== "completed-view") {
        markSessionEnded(session, this.now(), envelope.payload.reason ?? "sender-left");
      }
      return true;
    }
    sendToPeer(session, role, envelope);
    return true;
  }

  private parseSignal(rawMessage: string) {
    try {
      const envelope = SignalEnvelopeSchema.safeParse(JSON.parse(rawMessage));
      return envelope.success ? envelope.data : null;
    } catch {
      return null;
    }
  }

  private sweepExpired() {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (
        session.state === "waiting" &&
        session.openExpiresAt !== null &&
        session.openExpiresAt <= now
      ) {
        deleteStoredSession(this.sessions, this.accessCodes, session.id);
        continue;
      }
      if (
        session.state === "completed-view" &&
        session.completedViewExpiresAt !== null &&
        session.completedViewExpiresAt <= now
      ) {
        deleteStoredSession(this.sessions, this.accessCodes, session.id);
        continue;
      }
      if (
        session.state === "claimed" &&
        now - session.senderLastSeenAt > this.heartbeatTtlMs &&
        !session.sockets.sender
      ) {
        markSessionEnded(session, this.now(), "sender-timeout");
      }
    }
  }
}
