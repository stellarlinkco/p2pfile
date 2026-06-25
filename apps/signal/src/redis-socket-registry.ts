import type { SessionRole, SignalEnvelope } from "@p2pfile/shared";
import type { ServerWebSocket } from "bun";
import type { PeerSockets } from "./session-model";

export class RedisSocketRegistry {
  private readonly sockets = new Map<string, PeerSockets>();

  attach(sessionId: string, role: SessionRole, socket: ServerWebSocket<unknown>) {
    const sessionSockets = this.sockets.get(sessionId) ?? {};
    sessionSockets[role] = socket;
    this.sockets.set(sessionId, sessionSockets);
  }

  detach(sessionId: string, role: SessionRole, socket?: ServerWebSocket<unknown>) {
    const sessionSockets = this.sockets.get(sessionId);
    if (!sessionSockets) return;
    if (socket && sessionSockets[role] !== socket) return;
    sessionSockets[role] = undefined;
    if (!sessionSockets.sender && !sessionSockets.receiver) {
      this.sockets.delete(sessionId);
    }
  }

  clear(sessionId: string) {
    const sessionSockets = this.sockets.get(sessionId);
    sessionSockets?.sender?.close(1000, "session closed");
    sessionSockets?.receiver?.close(1000, "session closed");
    this.sockets.delete(sessionId);
  }

  get(sessionId: string) {
    const sessionSockets = this.sockets.get(sessionId);
    return sessionSockets ? { ...sessionSockets } : undefined;
  }

  sendToPeer(sessionId: string, fromRole: SessionRole, envelope: SignalEnvelope) {
    const peerRole: SessionRole = fromRole === "sender" ? "receiver" : "sender";
    this.sockets.get(sessionId)?.[peerRole]?.send(JSON.stringify(envelope));
  }
}
