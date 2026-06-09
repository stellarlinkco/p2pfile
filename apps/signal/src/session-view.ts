import type { FileManifestItem, SessionPublicView } from "@p2pfile/shared";
import type { StoredSession } from "./session-model";

export const buildSummary = (manifest: FileManifestItem[]) => ({
  fileCount: manifest.length,
  totalSize: manifest.reduce((sum, item) => sum + item.size, 0),
});

export const toPublicSession = (session: StoredSession): SessionPublicView => {
  const expiresAt =
    session.state === "waiting"
      ? session.openExpiresAt
      : session.state === "completed-view"
        ? session.completedViewExpiresAt
        : null;

  return {
    sessionId: session.id,
    state: session.state,
    manifest: session.manifest.map((item) => ({ ...item })),
    summary: { ...session.summary },
    transferMode: session.transferMode,
    canClaim: session.state === "waiting",
    claimed: session.state === "claimed",
    completed: session.state === "completed-view",
    ended: session.state === "ended",
    expiresAt,
  };
};
