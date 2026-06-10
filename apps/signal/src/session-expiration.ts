import { deleteStoredSession, markSessionEnded } from "./session-lifecycle";
import type { StoredSession } from "./session-model";
import { isActiveSessionState } from "./session-state";

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
      isActiveSessionState(session.state) &&
      now - session.senderLastSeenAt > heartbeatTtlMs &&
      !session.sockets.sender
    ) {
      markSessionEnded(session, now, "sender-timeout");
    }
  }
}
