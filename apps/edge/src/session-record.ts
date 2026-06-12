import {
  type CompleteSessionRequest,
  DEFAULT_RETRY_BUDGET,
  type FileManifestItem,
  type SessionPublicView,
  SessionPublicViewSchema,
  type SessionState,
} from "@p2pfile/shared";

import { currentTime } from "./clock";

const ACCESS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const COMPLETED_SESSION_VIEW_TTL_MS = 2 * 60 * 1000;
export const OPEN_SESSION_TTL_MS = 10 * 60 * 1000;
export const SESSION_STORAGE_KEY = "session";
export const DIRECTORY_OBJECT_NAME = "session-directory";

export type SessionRecord = {
  id: string;
  accessCode: string;
  sharePath: string;
  senderToken: string;
  receiverToken: string | null;
  manifest: FileManifestItem[];
  summary: { fileCount: number; totalSize: number };
  state: SessionState;
  createdAt: number;
  openExpiresAt: number;
  retriesRemaining: number;
  failureReason?: string;
};

export type SessionCreatePayload = {
  session: SessionRecord;
};

export type SessionDirectoryRegisterPayload = {
  accessCode: string;
  sessionId: string;
};

export function generateSessionId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

export function generateToken() {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

export function generateAccessCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (value) => {
    return ACCESS_CODE_ALPHABET[value % ACCESS_CODE_ALPHABET.length];
  }).join("");
}

export function cloneManifest(manifest: FileManifestItem[]) {
  return manifest.map(({ id, name, size, mimeType }) => ({
    id,
    name,
    size,
    ...(mimeType ? { mimeType } : {}),
  }));
}

export function summarize(manifest: FileManifestItem[]) {
  return {
    fileCount: manifest.length,
    totalSize: manifest.reduce((total, file) => total + file.size, 0),
  };
}

export function toPublicSession(session: SessionRecord): SessionPublicView {
  const isOpen = session.state === "waiting" || session.state === "viewing";
  const isCompletedView = session.state === "completed-view";
  return SessionPublicViewSchema.parse({
    sessionId: session.id,
    state: session.state,
    manifest: cloneManifest(session.manifest),
    summary: { ...session.summary },
    transferMode: "direct",
    canClaim: isOpen,
    claimed:
      session.state === "claimed" ||
      session.state === "connecting" ||
      session.state === "transferring",
    completed: isCompletedView,
    ended: session.state === "ended",
    expiresAt: isOpen || isCompletedView ? session.openExpiresAt : null,
    retriesRemaining: session.retriesRemaining,
    failureReason: session.failureReason,
  });
}

export function matchesCompletedManifest(session: SessionRecord, input: CompleteSessionRequest) {
  if (
    input.totalBytes !== session.summary.totalSize ||
    input.completedFiles.length !== session.manifest.length
  ) {
    return false;
  }

  for (let index = 0; index < session.manifest.length; index += 1) {
    const expected = session.manifest[index];
    const received = input.completedFiles[index];
    if (!expected || !received || expected.id !== received.id || expected.size !== received.bytes) {
      return false;
    }
  }

  return true;
}

export function isExpired(session: SessionRecord, at = currentTime.now()) {
  return (
    (session.state === "waiting" ||
      session.state === "viewing" ||
      session.state === "completed-view" ||
      session.state === "ended" ||
      session.state === "failed") &&
    session.openExpiresAt <= at
  );
}

export function isActiveSession(session: SessionRecord) {
  return (
    session.state === "claimed" ||
    session.state === "connecting" ||
    session.state === "transferring"
  );
}

export function isSenderLiveSession(session: SessionRecord) {
  return (
    session.state !== "ended" && session.state !== "failed" && session.state !== "completed-view"
  );
}

export async function readSession(storage: DurableObjectStorage) {
  return storage.get<SessionRecord>(SESSION_STORAGE_KEY);
}

export async function writeSession(storage: DurableObjectStorage, session: SessionRecord) {
  await storage.put(SESSION_STORAGE_KEY, session);
}

export function createInitialSession(manifest: FileManifestItem[]): SessionRecord {
  const id = generateSessionId();
  const accessCode = generateAccessCode();
  const createdAt = currentTime.now();
  return {
    id,
    accessCode,
    sharePath: `/f/${id}`,
    senderToken: generateToken(),
    receiverToken: null,
    manifest,
    summary: summarize(manifest),
    state: "waiting",
    createdAt,
    openExpiresAt: createdAt + OPEN_SESSION_TTL_MS,
    retriesRemaining: DEFAULT_RETRY_BUDGET,
  };
}
