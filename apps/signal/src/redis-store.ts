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
  type SignalEnvelope,
} from "@p2pfile/shared";
import type { ServerWebSocket } from "bun";
import {
  createRedisClient,
  deleteRedisAccessCode,
  getRedisAccessCodeSessionId,
  getRedisSessionId,
  loadRedisSession,
  normalizeAccessCode,
  type RedisLike,
  saveRedisSession,
} from "./redis-session-storage";
import { parseSignalEnvelope } from "./redis-signal";
import { RedisSocketRegistry } from "./redis-socket-registry";
import { terminalClaimResponse } from "./redis-terminal-claim";
import { createStoredSession } from "./session-factory";
import { setSessionReconnecting } from "./session-lifecycle";
import {
  DEFAULT_COMPLETED_VIEW_TTL_MS,
  DEFAULT_OPEN_SESSION_TTL_MS,
  DEFAULT_SENDER_RECONNECT_GRACE_MS,
  DEFAULT_SHARE_PATH_PREFIX,
  type LiveSessionStoreOptions,
  type StoredSession,
} from "./session-model";
import { isActiveSessionState, markConnecting, markTransferring } from "./session-state";
import { generateAccessCode, generateSessionId, generateToken } from "./session-tokens";
import { toPublicSession } from "./session-view";

export class RedisSessionStore {
  private readonly client: RedisLike;
  private readonly openSessionTtlMs: number;
  private readonly sharePathPrefix: string;
  private readonly completedViewTtlMs: number;
  private readonly senderReconnectGraceMs: number;
  private readonly now: () => number;

  private readonly sockets = new RedisSocketRegistry();

  constructor(redisUrl: string, options: LiveSessionStoreOptions = {}, client?: RedisLike) {
    this.client = client ?? createRedisClient(redisUrl);
    this.openSessionTtlMs = options.openSessionTtlMs ?? DEFAULT_OPEN_SESSION_TTL_MS;
    this.completedViewTtlMs = options.completedViewTtlMs ?? DEFAULT_COMPLETED_VIEW_TTL_MS;
    this.senderReconnectGraceMs =
      options.senderReconnectGraceMs ?? DEFAULT_SENDER_RECONNECT_GRACE_MS;
    this.sharePathPrefix = options.sharePathPrefix ?? DEFAULT_SHARE_PATH_PREFIX;
    this.now = options.now ?? Date.now;
  }

  async createSession(input: CreateSessionRequest) {
    const id = await this.unusedSessionId();
    const accessCode = await this.unusedAccessCode();
    const session = createStoredSession({
      request: input,
      id,
      accessCode,
      createdAt: this.now(),
      openSessionTtlMs: this.openSessionTtlMs,
      sharePathPrefix: this.sharePathPrefix,
    });
    await this.save(session);
    return CreateSessionResponseSchema.parse({
      sessionId: id,
      accessCode,
      sharePath: session.sharePath,
      senderToken: session.senderToken,
      session: toPublicSession(session),
    });
  }

  async getPublicSession(sessionId: string) {
    const session = await this.load(sessionId);
    return session ? SessionPublicViewSchema.parse(toPublicSession(session)) : null;
  }

  async viewSession(sessionId: string) {
    const session = await this.load(sessionId);
    if (!session) return null;
    if (session.state === "waiting") {
      session.state = "viewing";
      await this.save(session);
    }
    return SessionPublicViewSchema.parse(toPublicSession(session));
  }

  async claimSession(sessionId: string, receiverToken?: string) {
    const session = await this.load(sessionId);
    if (!session) return null;
    const terminalClaim = terminalClaimResponse(session, receiverToken);
    if (terminalClaim) {
      if (session.state === "failed") this.sockets.clear(sessionId);
      return terminalClaim;
    }
    if (isActiveSessionState(session.state)) {
      if (receiverToken && receiverToken === session.receiverToken) {
        if (session.retriesRemaining <= 0) {
          session.state = "failed";
          session.failureReason = "retry-budget-exhausted";
          this.sockets.clear(sessionId);
          await this.save(session);
          return ClaimSessionResponseSchema.parse({
            status: "failed",
            session: toPublicSession(session),
          });
        }
        session.retriesRemaining -= 1;
        await this.save(session);
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
    await this.save(session);
    return ClaimSessionResponseSchema.parse({
      status: "claimed",
      receiverToken: session.receiverToken,
      retriesRemaining: session.retriesRemaining,
      session: toPublicSession(session),
    });
  }

  async releaseSession(sessionId: string, input: ReleaseSessionRequest) {
    const session = await this.load(sessionId);
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
    this.sockets.detach(sessionId, "receiver");
    await this.save(session);
    return ReleaseSessionResponseSchema.parse({
      status: "released",
      session: toPublicSession(session),
    });
  }

  async completeSession(sessionId: string, input: CompleteSessionRequest) {
    const session = await this.load(sessionId);
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
    await this.save(session);
    return SessionMutationResponseSchema.parse({ ok: true, session: toPublicSession(session) });
  }

  async endSession(sessionId: string, input: EndSessionRequest) {
    const session = await this.load(sessionId);
    if (!session || session.senderToken !== input.senderToken) return null;
    if (
      session.state !== "completed-view" &&
      session.state !== "ended" &&
      session.state !== "failed"
    ) {
      this.endActiveSession(sessionId, session, "sender-ended");
    }
    await this.save(session);
    return SessionMutationResponseSchema.parse({ ok: true, session: toPublicSession(session) });
  }

  async connectSocket(
    sessionId: string,
    role: string,
    token: string,
    socket: ServerWebSocket<unknown>,
  ) {
    const session = await this.load(sessionId);
    if (
      !session ||
      session.state === "waiting" ||
      session.state === "ended" ||
      session.state === "failed"
    )
      return false;
    if (role === "sender" && session.senderToken !== token) return false;
    if (role === "receiver" && session.receiverToken !== token) return false;
    this.sockets.attach(sessionId, role as SessionRole, socket);
    if (role === "sender") {
      session.senderLastSeenAt = this.now();
      if (session.state === "reconnecting") {
        session.state = session.receiverToken ? "transferring" : "connecting";
        session.openExpiresAt = null;
      }
    }
    markConnecting(session);
    await this.save(session);
    return true;
  }

  async disconnectSocket(
    sessionId: string,
    role: string,
    token: string,
    socket?: ServerWebSocket<unknown>,
  ) {
    const session = await this.load(sessionId);
    if (!session || session.state === "ended" || session.state === "failed") return;
    if (role === "sender" && session.senderToken !== token) return;
    if (role === "receiver" && session.receiverToken !== token) return;
    const sessionSockets = this.sockets.get(sessionId);
    if (socket && sessionSockets?.[role as SessionRole] !== socket) return;
    if (role === "sender" && session.state !== "completed-view") {
      if (session.state === "connecting" || session.state === "transferring") {
        this.sockets.sendToPeer(sessionId, "sender", {
          type: "sender-reconnecting",
          payload: { reason: "sender-disconnected" },
        });
        setSessionReconnecting(session, this.now(), this.senderReconnectGraceMs);
        this.sockets.detach(sessionId, role as SessionRole, socket);
        await this.save(session);
        return;
      }
      this.endActiveSession(sessionId, session, "sender-disconnected");
      await this.save(session);
      return;
    }
    this.sockets.detach(sessionId, role as SessionRole, socket);
  }

  async handleSignal(
    sessionId: string,
    role: string,
    token: string,
    rawMessage: string | ArrayBuffer | ArrayBufferView,
  ) {
    const session = await this.load(sessionId);
    if (!session || session.state === "failed" || session.state === "ended") return false;
    if (role === "sender" && session.senderToken !== token) return false;
    if (role === "receiver" && session.receiverToken !== token) return false;
    const signalRole = role as SessionRole;

    if (typeof rawMessage !== "string") {
      markTransferring(session);
      await this.save(session);
      this.sockets.sendBinaryToPeer(sessionId, signalRole, rawMessage);
      return true;
    }

    const parsed = parseSignalEnvelope(rawMessage);
    if (!parsed) return false;
    const envelope = parsed as SignalEnvelope;
    if (role === "sender") session.senderLastSeenAt = this.now();
    if (envelope.type === "offer" && role === "sender") markConnecting(session);
    if (envelope.type === "mode") {
      session.transferMode = envelope.payload.mode;
      if (envelope.payload.mode === "relay") markTransferring(session);
      if (envelope.payload.mode === "direct" && role === "sender") markConnecting(session);
    }
    if (envelope.type === "receiver-ready") {
      if (role !== "receiver") return false;
      markTransferring(session);
      await this.save(session);
      this.sockets.sendToPeer(sessionId, signalRole, envelope);
      return true;
    }
    if (envelope.type === "sender-left") {
      if (role !== "sender") return false;
      if (session.state !== "completed-view") {
        this.endActiveSession(sessionId, session, envelope.payload.reason ?? "sender-left");
        await this.save(session);
      } else {
        await this.save(session);
        this.sockets.sendToPeer(sessionId, signalRole, envelope);
        this.sockets.clear(sessionId);
      }
      return true;
    }
    if (envelope.type === "transfer-complete" || envelope.type === "sender-reconnecting")
      return false;
    if (envelope.type === "relay-ready" || envelope.type === "relay-message") {
      markTransferring(session);
    }
    this.sockets.sendToPeer(sessionId, signalRole, envelope);
    await this.save(session);
    return true;
  }

  async resolveAccessCode(code: string) {
    const normalized = normalizeAccessCode(code);
    const sessionId = await getRedisAccessCodeSessionId(this.client, normalized);
    if (!sessionId) return null;
    const session = await this.load(sessionId);
    if (!session) {
      await deleteRedisAccessCode(this.client, normalized);
      return null;
    }
    return AccessCodeResolveResponseSchema.parse({ sessionId, sharePath: session.sharePath });
  }

  private async unusedSessionId() {
    while (true) {
      const id = generateSessionId(new Set());
      if (!(await getRedisSessionId(this.client, id))) return id;
    }
  }

  private async unusedAccessCode() {
    while (true) {
      const code = generateAccessCode(new Map());
      if (!(await getRedisAccessCodeSessionId(this.client, code))) return code;
    }
  }

  private endActiveSession(sessionId: string, session: StoredSession, reason: string) {
    const endedAt = this.now();
    this.sockets.sendToPeer(sessionId, "sender", { type: "sender-left", payload: { reason } });
    session.state = "ended";
    session.endedAt = endedAt;
    session.openExpiresAt = endedAt + this.completedViewTtlMs;
    this.sockets.clear(sessionId);
  }

  private async load(sessionId: string) {
    const session = await loadRedisSession(this.client, sessionId, this.now());
    if (
      session?.state === "reconnecting" &&
      session.openExpiresAt !== null &&
      session.openExpiresAt <= this.now()
    ) {
      this.endActiveSession(sessionId, session, "sender-timeout");
      await this.save(session);
    }
    return session;
  }

  private async save(session: StoredSession) {
    await saveRedisSession(this.client, session, this.now());
  }
}
