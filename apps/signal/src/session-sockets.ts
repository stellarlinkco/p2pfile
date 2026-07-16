import { matchesSessionToken, type SessionRole, type SignalEnvelope } from "@p2pfile/shared";
import type { ServerWebSocket } from "bun";
import type { StoredSession } from "./session-model";

export function relaySequenceFromBinaryWire(bytes: ArrayBuffer | ArrayBufferView) {
  const view =
    bytes instanceof ArrayBuffer
      ? new DataView(bytes)
      : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 6) return null;
  if (view.getUint8(0) !== 0x52 || view.getUint8(1) !== 0x01) return null;
  return view.getUint32(2, false);
}

export function nackRelayPeerUnavailable(
  socket: { send: (data: string) => void } | undefined,
  sequence: number,
) {
  if (!socket) return;
  socket.send(
    JSON.stringify({
      type: "relay-nack",
      payload: { sequence, reason: "peer-unavailable" },
    }),
  );
}

export const sendToPeer = (
  session: StoredSession,
  fromRole: SessionRole,
  envelope: SignalEnvelope,
): boolean => {
  const peerRole: SessionRole = fromRole === "sender" ? "receiver" : "sender";
  const peerSocket = session.sockets[peerRole];
  if (!peerSocket) {
    return false;
  }

  peerSocket.send(JSON.stringify(envelope));
  return true;
};

export const sendBinaryToPeer = (
  session: StoredSession,
  fromRole: SessionRole,
  rawMessage: ArrayBuffer | ArrayBufferView,
): boolean => {
  const peerRole: SessionRole = fromRole === "sender" ? "receiver" : "sender";
  const peerSocket = session.sockets[peerRole];
  if (!peerSocket) {
    return false;
  }
  if (rawMessage instanceof ArrayBuffer) {
    peerSocket.send(rawMessage);
    return true;
  }
  const view = rawMessage as ArrayBufferView;
  peerSocket.send(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  return true;
};

export type LiveSocket = ServerWebSocket<unknown>;

export const detachSocket = (session: StoredSession, role: SessionRole) => {
  if (!session.sockets[role]) {
    return;
  }

  session.sockets[role] = undefined;
};

export const isValidRoleToken = (session: StoredSession, role: SessionRole, token: string) => {
  if (role === "sender") {
    return matchesSessionToken(session.senderToken, token);
  }

  return session.receiverToken !== null && matchesSessionToken(session.receiverToken, token);
};
