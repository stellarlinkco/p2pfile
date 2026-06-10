import type { FileManifestItem, SessionRole, SessionState, TransferMode } from "@p2pfile/shared";
import type { ServerWebSocket } from "bun";

export type PeerSockets = Partial<Record<SessionRole, ServerWebSocket<unknown>>>;

export type StoredSession = {
  id: string;
  accessCode: string;
  sharePath: string;
  senderToken: string;
  receiverToken: string | null;
  manifest: FileManifestItem[];
  summary: {
    fileCount: number;
    totalSize: number;
  };
  state: SessionState;
  transferMode: TransferMode;
  retriesRemaining: number;
  failureReason?: string;
  createdAt: number;
  openExpiresAt: number | null;
  completedViewExpiresAt: number | null;
  endedAt: number | null;
  completedAt: number | null;
  senderLastSeenAt: number;
  sockets: PeerSockets;
};

export type LiveSessionStoreOptions = {
  openSessionTtlMs?: number;
  completedViewTtlMs?: number;
  heartbeatTtlMs?: number;
  sharePathPrefix?: string;
  now?: () => number;
};

export const DEFAULT_OPEN_SESSION_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_COMPLETED_VIEW_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_HEARTBEAT_TTL_MS = 30 * 1000;
export const DEFAULT_SHARE_PATH_PREFIX = "/f";
