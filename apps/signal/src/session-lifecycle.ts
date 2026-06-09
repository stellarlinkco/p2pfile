import type { StoredSession } from "./session-model";
import { detachSocket, sendToPeer } from "./session-sockets";

export function markSessionEnded(session: StoredSession, endedAt: number, reason: string) {
  session.state = "ended";
  session.endedAt = endedAt;
  sendToPeer(session, "sender", { type: "sender-left", payload: { reason } });
  detachSocket(session, "sender");
  detachSocket(session, "receiver");
}

export function deleteStoredSession(
  sessions: Map<string, StoredSession>,
  accessCodes: Map<string, string>,
  sessionId: string,
) {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }

  accessCodes.delete(session.accessCode);
  sessions.delete(sessionId);
}
