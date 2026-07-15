import {
  AccessCodeResolveResponseSchema,
  ClaimSessionResponseSchema,
  type CompleteSessionRequest,
  type CreateSessionRequest,
  CreateSessionResponseSchema,
  DEFAULT_RETRY_BUDGET,
  type EndSessionRequest,
  type ReleaseSessionRequest,
  ReleaseSessionResponseSchema,
  SessionMutationResponseSchema,
  SessionPublicViewSchema,
  type SessionRole,
  SignalEnvelopeSchema,
} from "@p2pfile/shared";
import type { ServerWebSocket } from "bun";
import { sweepExpiredSessions } from "./session-expiration";
import { createStoredSession } from "./session-factory";
import {
  isTerminallyClosed,
  markSessionEnded,
  markSessionFailed,
  markSessionReconnecting,
} from "./session-lifecycle";
import {
  DEFAULT_COMPLETED_VIEW_TTL_MS,
  DEFAULT_HEARTBEAT_TTL_MS,
  DEFAULT_OPEN_SESSION_TTL_MS,
  DEFAULT_SENDER_RECONNECT_GRACE_MS,
  DEFAULT_SHARE_PATH_PREFIX,
  type LiveSessionStoreOptions,
  type StoredSession,
} from "./session-model";
import { detachSocket, isValidRoleToken, sendToPeer } from "./session-sockets";
import { isActiveSessionState, markConnecting, markTransferring } from "./session-state";
import { generateAccessCode, generateSessionId, generateToken } from "./session-tokens";
import { toPublicSession } from "./session-view";

export type { LiveSessionStoreOptions } from "./session-model";

export class LiveSessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly accessCodes = new Map<string, string>();
  private readonly openSessionTtlMs: number;
  private readonly completedViewTtlMs: number;
  private readonly heartbeatTtlMs: number;
  private readonly senderReconnectGraceMs: number;
  private readonly sharePathPrefix: string;
  private readonly now: () => number;

  constructor(options: LiveSessionStoreOptions = {}) {
    this.openSessionTtlMs = options.openSessionTtlMs ?? DEFAULT_OPEN_SESSION_TTL_MS;
    this.completedViewTtlMs = options.completedViewTtlMs ?? DEFAULT_COMPLETED_VIEW_TTL_MS;
    this.heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    this.senderReconnectGraceMs =
      options.senderReconnectGraceMs ?? DEFAULT_SENDER_RECONNECT_GRACE_MS;
    this.sharePathPrefix = options.sharePathPrefix ?? DEFAULT_SHARE_PATH_PREFIX;
    this.now = options.now ?? Date.now;
  }

  createSession(input: CreateSessionRequest) {
    this.sweepExpired();
    const id = generateSessionId(new Set(this.sessions.keys()));
    const accessCode = generateAccessCode(this.accessCodes);
    const session = createStoredSession({
      request: input,
      id,
      accessCode,
      createdAt: this.now(),
      openSessionTtlMs: this.openSessionTtlMs,
      sharePathPrefix: this.sharePathPrefix,
    });
    this.sessions.set(id, session);
    this.accessCodes.set(accessCode, id);
    return CreateSessionResponseSchema.parse({
      sessionId: id,
      accessCode,
      sharePath: session.sharePath,
      senderToken: session.senderToken,
      session: toPublicSession(session),
    });
  }

  getPublicSession(sessionId: string) {
    this.sweepExpired();
    const session = this.sessions.get(sessionId);
    return session ? SessionPublicViewSchema.parse(toPublicSession(session)) : null;
  }

  viewSession(sessionId: string) {
    this.sweepExpired();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.state === "waiting") session.state = "viewing";
    return SessionPublicViewSchema.parse(toPublicSession(session));
  }

  validateReceiverToken(sessionId: string, receiverToken: string) {
    this.sweepExpired();
    return this.sessions.get(sessionId)?.receiverToken === receiverToken;
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
    if (session.state === "failed") {
      return ClaimSessionResponseSchema.parse({
        status: "failed",
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
    if (isActiveSessionState(session.state)) {
      if (receiverToken && receiverToken === session.receiverToken) {
        if (session.retriesRemaining <= 0) {
          markSessionFailed(session, "retry-budget-exhausted");
          return ClaimSessionResponseSchema.parse({
            status: "failed",
            session: toPublicSession(session),
          });
        }
        session.retriesRemaining -= 1;
        return ClaimSessionResponseSchema.parse({
          status: "claimed",
          receiverToken,
          retriesRemaining: session.retriesRemaining,
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
    session.failureReason = undefined;
    session.openExpiresAt = null;
    return ClaimSessionResponseSchema.parse({
      status: "claimed",
      receiverToken: session.receiverToken,
      retriesRemaining: session.retriesRemaining,
      session: toPublicSession(session),
    });
  }

  releaseSession(sessionId: string, input: ReleaseSessionRequest) {
    this.sweepExpired();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (!isActiveSessionState(session.state) || session.receiverToken !== input.receiverToken) {
      return ReleaseSessionResponseSchema.parse({
        status: "invalid-token",
        session: toPublicSession(session),
      });
    }
    session.state = "waiting";
    session.receiverToken = null;
    session.retriesRemaining = DEFAULT_RETRY_BUDGET;
    session.failureReason = undefined;
    session.openExpiresAt = this.now() + this.openSessionTtlMs;
    detachSocket(session, "receiver");
    return ReleaseSessionResponseSchema.parse({
      status: "released",
      session: toPublicSession(session),
    });
  }

  completeSession(sessionId: string, input: CompleteSessionRequest) {
    this.sweepExpired();
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      !isActiveSessionState(session.state) ||
      session.receiverToken !== input.receiverToken
    )
      return null;
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
    if (!session || !isValidRoleToken(session, role, token) || isTerminallyClosed(session))
      return false;
    if (role === "receiver" && session.state === "waiting") return false;
    const replaced = session.sockets[role];
    session.sockets[role] = socket;
    if (replaced && replaced !== socket) {
      replaced.close(1000, "replaced");
    }
    if (role === "sender") {
      session.senderLastSeenAt = this.now();
      if (session.state === "reconnecting") {
        session.state = session.receiverToken ? "transferring" : "connecting";
        session.openExpiresAt = null;
      }
    }
    markConnecting(session);
    return true;
  }

  disconnectSocket(
    sessionId: string,
    role: SessionRole,
    token: string,
    socket?: ServerWebSocket<unknown>,
  ) {
    const session = this.sessions.get(sessionId);
    if (!session || !isValidRoleToken(session, role, token)) return;
    if (socket && session.sockets[role] !== socket) return;
    detachSocket(session, role);
    if (role === "sender" && session.state !== "completed-view") {
      if (session.state === "connecting" || session.state === "transferring") {
        markSessionReconnecting(session, this.now(), this.senderReconnectGraceMs);
        return;
      }
      markSessionEnded(session, this.now(), "sender-disconnected");
    }
  }

  handleSignal(
    sessionId: string,
    role: SessionRole,
    token: string,
    rawMessage: string | ArrayBuffer | ArrayBufferView,
    socket?: ServerWebSocket<unknown>,
  ) {
    const session = this.sessions.get(sessionId);
    if (!session || !isValidRoleToken(session, role, token) || isTerminallyClosed(session))
      return false;
    if (socket && session.sockets[role] !== socket) return false;

    // Opaque binary relay frames (chunk payloads) are forwarded without JSON parsing.
    if (typeof rawMessage !== "string") {
      markTransferring(session);
      const peerRole: SessionRole = role === "sender" ? "receiver" : "sender";
      const peerSocket = session.sockets[peerRole];
      if (!peerSocket) return true;
      if (rawMessage instanceof ArrayBuffer) {
        peerSocket.send(rawMessage);
        return true;
      }
      if (ArrayBuffer.isView(rawMessage)) {
        const view = rawMessage as ArrayBufferView;
        peerSocket.send(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
        return true;
      }
      return false;
    }

    const envelope = this.parseSignal(rawMessage);
    if (!envelope) return false;
    if (role === "sender") session.senderLastSeenAt = this.now();
    if (envelope.type === "sender-heartbeat") {
      markConnecting(session);
      return true;
    }
    if (envelope.type === "offer" && role === "sender") markConnecting(session);
    if (envelope.type === "mode") {
      session.transferMode = envelope.payload.mode;
      if (envelope.payload.mode === "relay") markTransferring(session);
      if (envelope.payload.mode === "direct" && role === "sender") markConnecting(session);
    }
    if (
      envelope.type === "receiver-ready" ||
      envelope.type === "relay-ready" ||
      envelope.type === "relay-message"
    ) {
      markTransferring(session);
    }
    if (envelope.type === "receiver-ready" && role === "receiver") {
      session.sockets.sender?.send(JSON.stringify(envelope));
      return true;
    }
    if (envelope.type === "sender-left" && role !== "sender") return false;
    if (envelope.type === "sender-left") {
      if (session.state !== "completed-view") {
        markSessionEnded(session, this.now(), envelope.payload.reason ?? "sender-left");
      }
      return true;
    }
    if (envelope.type === "transfer-complete" || envelope.type === "sender-reconnecting")
      return false;
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
    sweepExpiredSessions(this.sessions, this.accessCodes, this.now(), this.heartbeatTtlMs);
  }
}
