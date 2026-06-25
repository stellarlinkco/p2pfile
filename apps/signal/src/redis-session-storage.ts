import { parseRedisSession, serializeRedisSession } from "./redis-session-codec";
import type { StoredSession } from "./session-model";

export type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  expire?(key: string, seconds: number): Promise<unknown>;
  persist?(key: string): Promise<unknown>;
};

type RedisClientConstructor = new (url: string) => RedisLike;

const SESSION_KEY_PREFIX = "p2pfile:session:";
const ACCESS_CODE_KEY_PREFIX = "p2pfile:access-code:";

export const redisSessionKey = (sessionId: string) => `${SESSION_KEY_PREFIX}${sessionId}`;
const sessionKey = redisSessionKey;
const accessCodeKey = (accessCode: string) => `${ACCESS_CODE_KEY_PREFIX}${accessCode}`;

export function createRedisClient(redisUrl: string): RedisLike {
  const RedisClient = (Bun as unknown as { RedisClient?: RedisClientConstructor }).RedisClient;
  if (!RedisClient) throw new Error("Bun RedisClient is unavailable in this runtime.");
  return new RedisClient(redisUrl);
}

export function normalizeAccessCode(code: string) {
  return code.trim().toUpperCase();
}

export async function loadRedisSession(
  client: RedisLike,
  sessionId: string,
  now: number,
): Promise<StoredSession | null> {
  const raw = await client.get(sessionKey(sessionId));
  if (!raw) return null;
  const session = parseRedisSession(raw);
  if (
    ((session.state === "waiting" || session.state === "viewing") &&
      session.openExpiresAt !== null &&
      session.openExpiresAt <= now) ||
    (session.state === "completed-view" &&
      session.completedViewExpiresAt !== null &&
      session.completedViewExpiresAt <= now)
  ) {
    await deleteRedisSession(client, session);
    return null;
  }
  return session;
}

export async function saveRedisSession(client: RedisLike, session: StoredSession, now: number) {
  await client.set(sessionKey(session.id), serializeRedisSession(session));
  await client.set(accessCodeKey(session.accessCode), session.id);
  const expiresAt =
    session.state === "completed-view" ? session.completedViewExpiresAt : session.openExpiresAt;
  if (expiresAt === null) {
    await client.persist?.(sessionKey(session.id));
    await client.persist?.(accessCodeKey(session.accessCode));
    return;
  }
  if (!client.expire) return;
  const ttlSeconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  await client.expire(sessionKey(session.id), ttlSeconds);
  await client.expire(accessCodeKey(session.accessCode), ttlSeconds);
}

export async function deleteRedisSession(client: RedisLike, session: StoredSession) {
  await client.del(sessionKey(session.id));
  await client.del(accessCodeKey(session.accessCode));
}

export async function getRedisSessionId(client: RedisLike, sessionId: string) {
  return client.get(sessionKey(sessionId));
}

export async function getRedisAccessCodeSessionId(client: RedisLike, code: string) {
  return client.get(accessCodeKey(code));
}

export async function deleteRedisAccessCode(client: RedisLike, code: string) {
  await client.del(accessCodeKey(code));
}
