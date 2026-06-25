import { expect, test } from "bun:test";
import { sweepExpiredSessions } from "./session-expiration";
import { createStoredSession } from "./session-factory";
import { markSessionReconnecting } from "./session-lifecycle";
import {
  DEFAULT_COMPLETED_VIEW_TTL_MS,
  DEFAULT_HEARTBEAT_TTL_MS,
  DEFAULT_OPEN_SESSION_TTL_MS,
  DEFAULT_SENDER_RECONNECT_GRACE_MS,
} from "./session-model";

class FakeSocket {
  closeCode: number | null = null;
  readonly sent: unknown[] = [];

  send(payload: string) {
    if (this.closeCode !== null) return;
    this.sent.push(JSON.parse(payload));
  }

  close(code?: number) {
    this.closeCode = code ?? null;
  }
}

test("reconnecting session expires after sender reconnect grace", () => {
  const sessions = new Map();
  const accessCodes = new Map();
  const now = 10_000;
  const session = createStoredSession({
    request: { manifest: [{ id: "file-1", name: "hello.txt", size: 128 }] },
    id: "session-1",
    accessCode: "ABC123",
    createdAt: now,
    openSessionTtlMs: DEFAULT_OPEN_SESSION_TTL_MS,
  });
  session.receiverToken = "receiver-token";
  session.state = "transferring";
  markSessionReconnecting(session, now, DEFAULT_SENDER_RECONNECT_GRACE_MS);
  const receiverSocket = new FakeSocket();
  session.sockets.receiver = receiverSocket as never;
  sessions.set(session.id, session);
  accessCodes.set(session.accessCode, session.id);

  sweepExpiredSessions(
    sessions,
    accessCodes,
    now + DEFAULT_SENDER_RECONNECT_GRACE_MS - 1,
    DEFAULT_HEARTBEAT_TTL_MS,
  );
  expect(sessions.get(session.id)?.state).toBe("reconnecting");

  sweepExpiredSessions(
    sessions,
    accessCodes,
    now + DEFAULT_SENDER_RECONNECT_GRACE_MS,
    DEFAULT_HEARTBEAT_TTL_MS,
  );
  expect(sessions.get(session.id)?.state).toBe("ended");
  expect(receiverSocket.closeCode).toBe(1000);
  expect(receiverSocket.sent).toContainEqual({
    type: "sender-left",
    payload: { reason: "sender-timeout" },
  });

  sweepExpiredSessions(
    sessions,
    accessCodes,
    now + DEFAULT_SENDER_RECONNECT_GRACE_MS + DEFAULT_COMPLETED_VIEW_TTL_MS,
    DEFAULT_HEARTBEAT_TTL_MS,
  );
  expect(sessions.has(session.id)).toBe(false);
  expect(accessCodes.has(session.accessCode)).toBe(false);
});

test("reconnecting session is not ended by sender heartbeat sweep", () => {
  const sessions = new Map();
  const accessCodes = new Map();
  const now = 10_000;
  const session = createStoredSession({
    request: { manifest: [{ id: "file-1", name: "hello.txt", size: 128 }] },
    id: "session-2",
    accessCode: "DEF456",
    createdAt: now,
    openSessionTtlMs: DEFAULT_OPEN_SESSION_TTL_MS,
  });
  session.receiverToken = "receiver-token";
  markSessionReconnecting(session, now, DEFAULT_SENDER_RECONNECT_GRACE_MS);
  session.senderLastSeenAt = now - DEFAULT_HEARTBEAT_TTL_MS - 1;
  sessions.set(session.id, session);
  accessCodes.set(session.accessCode, session.id);

  sweepExpiredSessions(
    sessions,
    accessCodes,
    now + DEFAULT_SENDER_RECONNECT_GRACE_MS - 1,
    DEFAULT_HEARTBEAT_TTL_MS,
  );
  expect(sessions.get(session.id)?.state).toBe("reconnecting");
});
