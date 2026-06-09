import type {
  FileManifestItem,
  SessionPublicView as SharedSessionPublicView,
} from "@p2pfile/shared";

export type SessionStatus = SharedSessionPublicView["state"] | "failed";

export type SessionPublicView = SharedSessionPublicView & {
  accessCode: string;
  sharePath: string;
  status: SessionStatus;
  files: FileManifestItem[];
  fileCount: number;
  totalBytes: number;
  expiresAt: number | null;
  claimedAt: string | null;
  completedAt: string | null;
  endedAt: string | null;
};

export type CreateSessionResponse = {
  sessionId: string;
  accessCode: string;
  sharePath: string;
  senderToken: string;
  expiresAt: number | null;
  session: SessionPublicView;
};

export type ClaimSessionState = "claimed" | "occupied" | "completed" | "ended";

export type ClaimSessionResponse = {
  ok: true;
  session: SessionPublicView;
  receiverToken: string | null;
  claim: ClaimSessionState;
  originalReceiver: boolean;
};

export type SignalRole = "sender" | "receiver";
