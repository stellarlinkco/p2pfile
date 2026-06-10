import { type CreateSessionRequest, DEFAULT_RETRY_BUDGET } from "@p2pfile/shared";
import {
  DEFAULT_SHARE_PATH_PREFIX,
  type LiveSessionStoreOptions,
  type StoredSession,
} from "./session-model";
import { generateToken } from "./session-tokens";
import { buildSummary } from "./session-view";

export type NewSessionInput = {
  request: CreateSessionRequest;
  id: string;
  accessCode: string;
  createdAt: number;
  openSessionTtlMs: number;
  sharePathPrefix?: LiveSessionStoreOptions["sharePathPrefix"];
};

export function createStoredSession({
  request,
  id,
  accessCode,
  createdAt,
  openSessionTtlMs,
  sharePathPrefix = DEFAULT_SHARE_PATH_PREFIX,
}: NewSessionInput): StoredSession {
  const manifest = request.manifest.map((item) => ({ ...item }));
  return {
    id,
    accessCode,
    sharePath: `${sharePathPrefix}/${id}`,
    senderToken: generateToken(),
    receiverToken: null,
    manifest,
    summary: buildSummary(manifest),
    state: "waiting",
    transferMode: "direct",
    retriesRemaining: DEFAULT_RETRY_BUDGET,
    createdAt,
    openExpiresAt: createdAt + openSessionTtlMs,
    completedViewExpiresAt: null,
    endedAt: null,
    completedAt: null,
    senderLastSeenAt: createdAt,
    sockets: {},
  };
}
