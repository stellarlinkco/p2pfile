import { deleteStoredSession, markSessionEnded } from "./session-lifecycle";
import type { StoredSession } from "./session-model";
import { isActiveSessionState } from "./session-state";

function endExpiredSession(session: StoredSession, now: number) {
  const sender = session.sockets.sender;
  const receiver = session.sockets.receiver;
  markSessionEnded(session, now, "sender-timeout");
  sender?.close(1000, "session closed");
  receiver?.close(1000, "session closed");
}

export function sweepExpiredSessions(
  sessions: Map<string, StoredSession>,
  accessCodes: Map<string, string>,
  now: number,
  heartbeatTtlMs: number,
) {
  for (const session of sessions.values()) {
    if (
      session.state === "waiting" &&
      session.openExpiresAt !== null &&
      session.openExpiresAt <= now
    ) {
      deleteStoredSession(sessions, accessCodes, session.id);
      continue;
    }
    if (
      session.state === "completed-view" &&
      session.completedViewExpiresAt !== null &&
      session.completedViewExpiresAt <= now
    ) {
      deleteStoredSession(sessions, accessCodes, session.id);
      continue;
    }
    if (
      (session.state === "ended" || session.state === "failed") &&
      session.openExpiresAt !== null &&
      session.openExpiresAt <= now
    ) {
      deleteStoredSession(sessions, accessCodes, session.id);
      continue;
    }
    if (
      session.state === "reconnecting" &&
      session.openExpiresAt !== null &&
      session.openExpiresAt <= now
    ) {
      endExpiredSession(session, now);
      continue;
    }
    if (
      isActiveSessionState(session.state) &&
      session.state !== "reconnecting" &&
      now - session.senderLastSeenAt > heartbeatTtlMs &&
      !session.sockets.sender
    ) {
      endExpiredSession(session, now);
    }
  }
}
