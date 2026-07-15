import {
  type ClaimSessionRequest,
  ClaimSessionRequestSchema,
  ClaimSessionResponseSchema,
  type CompleteSessionRequest,
  CompleteSessionRequestSchema,
  DEFAULT_RETRY_BUDGET,
  type EndSessionRequest,
  EndSessionRequestSchema,
  ReceiverTokenValidationResponseSchema,
  type ReleaseSessionRequest,
  ReleaseSessionRequestSchema,
  ReleaseSessionResponseSchema,
  SENDER_RECONNECT_GRACE_MS,
  SessionMutationResponseSchema,
  type SessionRole,
} from "@p2pfile/shared";

import { currentTime } from "./clock";
import { json, notFound } from "./responses";
import {
  COMPLETED_SESSION_VIEW_TTL_MS,
  isActiveSession,
  isExpired,
  isReconnectGraceExpired,
  isSenderLiveSession,
  matchesCompletedManifest,
  OPEN_SESSION_TTL_MS,
  readSession,
  SESSION_STORAGE_KEY,
  type SessionCreatePayload,
  type SessionRecord,
  toPublicSession,
  writeSession,
} from "./session-record";
import {
  closeSockets,
  isRoleAllowedSignal,
  parseEdgeWire,
  relaySequenceFromBinaryWire,
} from "./session-signaling";

export class SessionDurableObject implements DurableObject {
  private readonly sockets: Partial<Record<SessionRole, WebSocket>> = {};
  private currentSession: SessionRecord | null = null;
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/create") {
      if (await readSession(this.state.storage))
        return json({ message: "session exists" }, { status: 409 });
      const payload = (await request.json()) as SessionCreatePayload;
      await this.persistSession(payload.session);
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/delete") {
      await this.deleteSession();
      return json({ ok: true });
    }

    const session = this.currentSession ?? (await readSession(this.state.storage));
    if (!session) return notFound("session not found");
    this.currentSession = session;
    if (isExpired(session)) {
      await this.deleteSession();
      return notFound("session not found");
    }
    if (isReconnectGraceExpired(session)) {
      await this.markSenderEnded(session, "sender-reconnect-timeout");
      session.state = "ended";
      session.openExpiresAt = currentTime.now() + COMPLETED_SESSION_VIEW_TTL_MS;
    }

    if (request.method === "GET" && url.pathname === "/view") {
      if (session.state === "waiting") {
        session.state = "viewing";
        await this.persistSession(session);
      }
      return json(toPublicSession(session));
    }

    if (request.method === "GET" && url.pathname === "/receiver-token") {
      return json(
        ReceiverTokenValidationResponseSchema.parse({
          valid:
            session.receiverToken !== null &&
            request.headers.get("x-receiver-token") === session.receiverToken,
        }),
      );
    }

    if (request.method === "POST" && url.pathname === "/claim") {
      return this.claim(session, ClaimSessionRequestSchema.parse(await request.json()));
    }
    if (request.method === "POST" && url.pathname === "/release") {
      return this.release(session, ReleaseSessionRequestSchema.parse(await request.json()));
    }
    if (request.method === "POST" && url.pathname === "/complete") {
      return this.complete(session, CompleteSessionRequestSchema.parse(await request.json()));
    }
    if (request.method === "POST" && url.pathname === "/end") {
      return this.end(session, EndSessionRequestSchema.parse(await request.json()));
    }

    const wsMatch = url.pathname.match(/^\/ws\/[^/]+\/(sender|receiver)\/([^/]+)$/);
    if (wsMatch) return this.handleWebSocket(session, wsMatch[1] as SessionRole, wsMatch[2] ?? "");
    return notFound("session route not found");
  }

  async alarm() {
    const session = await readSession(this.state.storage);
    if (!session) {
      await this.state.storage.deleteAlarm();
      return;
    }
    if (isReconnectGraceExpired(session)) {
      await this.markSenderEnded(session, "sender-reconnect-timeout");
      return;
    }
    if (isExpired(session)) {
      await this.deleteSession();
      return;
    }
    await this.scheduleExpiry(session);
  }

  private async persistSession(session: SessionRecord) {
    this.currentSession = session;
    await writeSession(this.state.storage, session);
    await this.scheduleExpiry(session);
  }

  private async scheduleExpiry(session: SessionRecord) {
    if (
      (session.state === "waiting" ||
        session.state === "viewing" ||
        session.state === "completed-view" ||
        session.state === "ended" ||
        session.state === "failed" ||
        session.state === "reconnecting") &&
      session.openExpiresAt > currentTime.now()
    ) {
      await this.state.storage.setAlarm(session.openExpiresAt);
      return;
    }
    await this.state.storage.deleteAlarm();
  }

  private async deleteSession() {
    this.currentSession = null;
    await this.state.storage.delete(SESSION_STORAGE_KEY);
    await this.state.storage.deleteAlarm();
    closeSockets(this.sockets);
  }

  private async claim(session: SessionRecord, input: ClaimSessionRequest) {
    if (session.state === "ended") {
      return json(
        ClaimSessionResponseSchema.parse({ status: "ended", session: toPublicSession(session) }),
      );
    }
    if (session.state === "failed") {
      return json(
        ClaimSessionResponseSchema.parse({ status: "failed", session: toPublicSession(session) }),
      );
    }
    if (session.state === "completed-view") {
      return json(
        ClaimSessionResponseSchema.parse({
          status: "completed",
          originalReceiver: Boolean(
            input.receiverToken && input.receiverToken === session.receiverToken,
          ),
          session: toPublicSession(session),
        }),
      );
    }

    if (isActiveSession(session)) {
      if (input.receiverToken && input.receiverToken === session.receiverToken) {
        if (session.retriesRemaining <= 0) {
          session.state = "failed";
          session.retriesRemaining = 0;
          session.failureReason = "retry-budget-exhausted";
          session.openExpiresAt = currentTime.now() + COMPLETED_SESSION_VIEW_TTL_MS;
          closeSockets(this.sockets);
          await this.persistSession(session);
          return json(
            ClaimSessionResponseSchema.parse({
              status: "failed",
              session: toPublicSession(session),
            }),
          );
        }
        session.retriesRemaining -= 1;
        await this.persistSession(session);
        return json(
          ClaimSessionResponseSchema.parse({
            status: "claimed",
            receiverToken: input.receiverToken,
            retriesRemaining: session.retriesRemaining,
            session: toPublicSession(session),
          }),
        );
      }
      return json(
        ClaimSessionResponseSchema.parse({ status: "occupied", session: toPublicSession(session) }),
      );
    }

    session.state = "claimed";
    session.receiverToken =
      crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    session.retriesRemaining = DEFAULT_RETRY_BUDGET;
    session.openExpiresAt = 0;
    await this.persistSession(session);
    return json(
      ClaimSessionResponseSchema.parse({
        status: "claimed",
        receiverToken: session.receiverToken,
        retriesRemaining: session.retriesRemaining,
        session: toPublicSession(session),
      }),
    );
  }

  private async release(session: SessionRecord, input: ReleaseSessionRequest) {
    if (!isActiveSession(session) || input.receiverToken !== session.receiverToken) {
      return json(
        ReleaseSessionResponseSchema.parse({
          status: "invalid-token",
          session: toPublicSession(session),
        }),
      );
    }
    session.state = "waiting";
    session.receiverToken = null;
    session.retriesRemaining = DEFAULT_RETRY_BUDGET;
    session.openExpiresAt = currentTime.now() + OPEN_SESSION_TTL_MS;
    this.sockets.receiver?.close(1000, "session closed");
    delete this.sockets.receiver;
    await this.persistSession(session);
    return json(
      ReleaseSessionResponseSchema.parse({ status: "released", session: toPublicSession(session) }),
    );
  }

  private async complete(session: SessionRecord, input: CompleteSessionRequest) {
    if (!isActiveSession(session) || input.receiverToken !== session.receiverToken)
      return notFound("session not found");
    if (!matchesCompletedManifest(session, input))
      return json({ message: "manifest integrity check incomplete" }, { status: 409 });
    const completedAt = currentTime.now();
    session.state = "completed-view";
    session.openExpiresAt = completedAt + COMPLETED_SESSION_VIEW_TTL_MS;
    await this.persistSession(session);
    this.sockets.sender?.send(
      JSON.stringify({ type: "transfer-complete", payload: { completedAt } }),
    );
    return json(
      SessionMutationResponseSchema.parse({ ok: true, session: toPublicSession(session) }),
    );
  }

  private async end(session: SessionRecord, input: EndSessionRequest) {
    if (input.senderToken !== session.senderToken)
      return json({ message: "invalid token" }, { status: 401 });
    const ended = await this.markSenderEnded(session, "sender-ended");
    return json(SessionMutationResponseSchema.parse({ ok: true, session: toPublicSession(ended) }));
  }

  private async markSenderEnded(session: SessionRecord, reason: string) {
    const latest = this.currentSession ?? session;
    if (!isSenderLiveSession(latest)) return latest;
    latest.state = "ended";
    latest.openExpiresAt = currentTime.now() + COMPLETED_SESSION_VIEW_TTL_MS;
    await this.persistSession(latest);
    this.sockets.receiver?.send(JSON.stringify({ type: "sender-left", payload: { reason } }));
    closeSockets(this.sockets);
    return latest;
  }

  private async markSenderReconnecting(session: SessionRecord) {
    const latest = this.currentSession ?? session;
    if (this.sockets.sender) return;
    if (!isSenderLiveSession(latest) || latest.state === "reconnecting") return;
    latest.state = "reconnecting";
    latest.openExpiresAt = currentTime.now() + SENDER_RECONNECT_GRACE_MS;
    this.sockets.receiver?.send(
      JSON.stringify({ type: "sender-reconnecting", payload: { reason: "sender-disconnected" } }),
    );
    await this.persistSession(latest);
  }

  private handleWebSocket(session: SessionRecord, role: SessionRole, token: string) {
    const validSender =
      role === "sender" && session.senderToken === token && isSenderLiveSession(session);
    const validReceiver =
      role === "receiver" && session.receiverToken === token && isActiveSession(session);
    if (!validSender && !validReceiver)
      return json({ message: "invalid session websocket" }, { status: 401 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (role === "sender" && session.state === "reconnecting") {
      session.state = session.receiverToken ? "transferring" : "connecting";
      void this.persistSession(session);
    }

    const replaced = this.sockets[role];
    if (role === "receiver") {
      session.receiverGeneration += 1;
      session.relayReadyGeneration = null;
      void this.persistSession(session);
    }
    this.sockets[role] = server;
    if (
      role === "sender" &&
      replaced &&
      session.receiverToken &&
      isActiveSession(session) &&
      session.state !== "reconnecting"
    ) {
      this.sockets.receiver?.send(
        JSON.stringify({ type: "sender-reconnecting", payload: { reason: "sender-disconnected" } }),
      );
    }
    replaced?.close(1000, "replaced");
    server.addEventListener("message", (event) => {
      void this.handleSignal(session, role, server, event);
    });
    server.addEventListener("close", () => {
      if (this.sockets[role] !== server) return;
      delete this.sockets[role];
      if (role === "sender") void this.markSenderReconnecting(session);
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleSignal(
    initialSession: SessionRecord,
    role: SessionRole,
    socket: WebSocket,
    event: MessageEvent,
  ) {
    if (this.sockets[role] !== socket) {
      return;
    }
    const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
    if (this.sockets[role] !== socket) {
      return;
    }
    const session = this.currentSession ?? initialSession;
    const wire = parseEdgeWire(data);
    if (!wire) {
      socket.close(1003, "invalid signal message");
      return;
    }

    const rejectRelay = (sequence: number) => {
      socket.send(
        JSON.stringify({
          type: "relay-nack",
          payload: { sequence, reason: "peer-unavailable" },
        }),
      );
    };
    if (wire.kind === "binary") {
      // Opaque binary relay frames (chunk payloads) are forwarded in-flight only.
      if (role === "sender") {
        const sequence = relaySequenceFromBinaryWire(wire.bytes);
        if (
          sequence !== null &&
          (!this.sockets.receiver || session.relayReadyGeneration !== session.receiverGeneration)
        ) {
          rejectRelay(sequence);
          return;
        }
      }
      const peer = this.sockets[role === "sender" ? "receiver" : "sender"];
      if (peer?.readyState === WebSocket.OPEN) peer.send(wire.bytes);
      return;
    }

    const envelope = wire.envelope;
    const allowedRelayCommitSignal =
      (role === "receiver" &&
        envelope.type === "relay-message" &&
        envelope.payload.message.type === "chunk-commit") ||
      (role === "sender" && envelope.type === "relay-ack");
    if (!isRoleAllowedSignal(role, envelope) && !allowedRelayCommitSignal) {
      socket.close(1003, "invalid signal message");
      return;
    }
    if (envelope.type === "sender-left") {
      await this.markSenderEnded(session, envelope.payload.reason ?? "sender-left");
      return;
    }
    if (role === "sender" && envelope.type === "relay-message") {
      if (!this.sockets.receiver || session.relayReadyGeneration !== session.receiverGeneration) {
        rejectRelay(envelope.payload.sequence);
        return;
      }
    }
    if (
      role === "receiver" &&
      envelope.type === "relay-ready" &&
      session.relayReadyGeneration !== session.receiverGeneration
    ) {
      session.relayReadyGeneration = session.receiverGeneration;
      void this.persistSession(session);
    }
    const peer = this.sockets[role === "sender" ? "receiver" : "sender"];
    if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify(envelope));
  }
}
