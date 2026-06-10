import { FileManifestItemSchema, SessionStateSchema, TransferModeSchema } from "@p2pfile/shared";
import type { StoredSession } from "./session-model";

type SerializedSession = Omit<StoredSession, "sockets">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`invalid redis session ${field}`);
  return value;
}

function requiredNumber(value: unknown, field: string) {
  if (!Number.isFinite(value)) throw new Error(`invalid redis session ${field}`);
  return value as number;
}

function nullableString(value: unknown, field: string) {
  return value === null ? null : requiredString(value, field);
}

function nullableNumber(value: unknown, field: string) {
  return value === null ? null : requiredNumber(value, field);
}

export function parseRedisSession(raw: string): StoredSession {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || !isRecord(value.summary)) throw new Error("invalid redis session");
  return {
    id: requiredString(value.id, "id"),
    accessCode: requiredString(value.accessCode, "accessCode"),
    sharePath: requiredString(value.sharePath, "sharePath"),
    senderToken: requiredString(value.senderToken, "senderToken"),
    receiverToken: nullableString(value.receiverToken, "receiverToken"),
    manifest: FileManifestItemSchema.array().parse(value.manifest),
    summary: {
      fileCount: requiredNumber(value.summary.fileCount, "summary.fileCount"),
      totalSize: requiredNumber(value.summary.totalSize, "summary.totalSize"),
    },
    state: SessionStateSchema.parse(value.state),
    transferMode: TransferModeSchema.parse(value.transferMode),
    retriesRemaining: requiredNumber(value.retriesRemaining, "retriesRemaining"),
    failureReason:
      typeof value.failureReason === "string" && value.failureReason.length > 0
        ? value.failureReason
        : undefined,
    createdAt: requiredNumber(value.createdAt, "createdAt"),
    openExpiresAt: nullableNumber(value.openExpiresAt, "openExpiresAt"),
    completedViewExpiresAt: nullableNumber(value.completedViewExpiresAt, "completedViewExpiresAt"),
    endedAt: nullableNumber(value.endedAt, "endedAt"),
    completedAt: nullableNumber(value.completedAt, "completedAt"),
    senderLastSeenAt: requiredNumber(value.senderLastSeenAt, "senderLastSeenAt"),
    sockets: {},
  };
}

export function serializeRedisSession(session: StoredSession) {
  const serialized: SerializedSession = { ...session };
  return JSON.stringify(serialized);
}
