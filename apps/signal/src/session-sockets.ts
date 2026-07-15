import { matchesSessionToken, type SessionRole, type SignalEnvelope } from "@p2pfile/shared";
import type { StoredSession } from "./session-model";

export const sendToPeer = (
  session: StoredSession,
  fromRole: SessionRole,
  envelope: SignalEnvelope,
) => {
  const peerRole: SessionRole = fromRole === "sender" ? "receiver" : "sender";
  const peerSocket = session.sockets[peerRole];
  if (!peerSocket) {
    return;
  }

  peerSocket.send(JSON.stringify(envelope));
};

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
