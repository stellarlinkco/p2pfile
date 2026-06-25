import { DEFAULT_COMPLETED_VIEW_TTL_MS, type StoredSession } from "./session-model";
import { detachSocket, sendToPeer } from "./session-sockets";

export function setSessionReconnecting(session: StoredSession, now: number, graceMs: number) {
  session.state = "reconnecting";
  session.openExpiresAt = now + graceMs;
}

export function markSessionReconnecting(session: StoredSession, now: number, graceMs: number) {
  setSessionReconnecting(session, now, graceMs);
  sendToPeer(session, "sender", {
    type: "sender-reconnecting",
    payload: { reason: "sender-disconnected" },
  });
  detachSocket(session, "sender");
}

export function markSessionEnded(session: StoredSession, endedAt: number, reason: string) {
  session.state = "ended";
  session.endedAt = endedAt;
  session.openExpiresAt = endedAt + DEFAULT_COMPLETED_VIEW_TTL_MS;
  sendToPeer(session, "sender", { type: "sender-left", payload: { reason } });
  detachSocket(session, "sender");
  detachSocket(session, "receiver");
}

export function markSessionFailed(session: StoredSession, failureReason?: string) {
  session.state = "failed";
  session.failureReason = failureReason;
  detachSocket(session, "sender");
  detachSocket(session, "receiver");
}

export function isTerminallyClosed(session: StoredSession) {
  return session.state === "ended" || session.state === "failed";
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
