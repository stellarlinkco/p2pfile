import type { SessionRole, SignalEnvelope } from "@p2pfile/shared";
import type { ServerWebSocket } from "bun";
import type { PeerSockets } from "./session-model";

export class RedisSocketRegistry {
  private readonly sockets = new Map<string, PeerSockets>();

  attach(sessionId: string, role: SessionRole, socket: ServerWebSocket<unknown>) {
    const sessionSockets = this.sockets.get(sessionId) ?? {};
    const replaced = sessionSockets[role];
    sessionSockets[role] = socket;
    this.sockets.set(sessionId, sessionSockets);
    if (replaced && replaced !== socket) {
      replaced.close(1000, "replaced");
    }
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

  isCurrent(sessionId: string, role: SessionRole, socket: ServerWebSocket<unknown>) {
    return this.sockets.get(sessionId)?.[role] === socket;
  }

  sendToPeer(sessionId: string, fromRole: SessionRole, envelope: SignalEnvelope): boolean {
    const peerRole: SessionRole = fromRole === "sender" ? "receiver" : "sender";
    const peer = this.sockets.get(sessionId)?.[peerRole];
    if (!peer) return false;
    peer.send(JSON.stringify(envelope));
    return true;
  }

  sendBinaryToPeer(
    sessionId: string,
    fromRole: SessionRole,
    rawMessage: ArrayBuffer | ArrayBufferView,
  ): boolean {
    const peerRole: SessionRole = fromRole === "sender" ? "receiver" : "sender";
    const peer = this.sockets.get(sessionId)?.[peerRole];
    if (!peer) return false;
    if (rawMessage instanceof ArrayBuffer) {
      peer.send(rawMessage);
      return true;
    }
    const view = rawMessage as ArrayBufferView;
    peer.send(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    return true;
  }

  nackRelay(sessionId: string, role: SessionRole, sequence: number) {
    const socket = this.sockets.get(sessionId)?.[role];
    if (!socket) return;
    socket.send(
      JSON.stringify({
        type: "relay-nack",
        payload: { sequence, reason: "peer-unavailable" },
      }),
    );
  }
}
