import type { FileManifestItem, SessionPublicView } from "@p2pfile/shared";
import type { StoredSession } from "./session-model";

export const buildSummary = (manifest: FileManifestItem[]) => ({
  fileCount: manifest.length,
  totalSize: manifest.reduce((sum, item) => sum + item.size, 0),
});

export const toPublicSession = (session: StoredSession): SessionPublicView => {
  const preClaim = session.state === "waiting" || session.state === "viewing";
  const claimed =
    !preClaim &&
    session.state !== "completed-view" &&
    session.state !== "ended" &&
    session.state !== "failed";
  const expiresAt =
    preClaim || session.state === "reconnecting"
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
    canClaim: preClaim,
    claimed,
    completed: session.state === "completed-view",
    ended: session.state === "ended",
    expiresAt,
    retriesRemaining: session.retriesRemaining,
    failureReason: session.failureReason,
  };
};
