import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import type { SessionPublicView } from "../lib/api";
import { reconnectingProgressFromCurrent } from "./receive-flow-polling";

function reconnectingSession(): SessionPublicView {
  return {
    accessCode: "ACCESS1",
    claimed: true,
    claimedAt: new Date(0).toISOString(),
    completed: false,
    completedAt: null,
    ended: false,
    endedAt: null,
    expiresAt: Date.now() + 120_000,
    fileCount: 2,
    files: reconnectingManifest,
    manifest: reconnectingManifest,
    sessionId: "abcdefabcdef",
    sharePath: "/f/abcdefabcdef",
    state: "reconnecting",
    status: "reconnecting",
    summary: { fileCount: 2, totalSize: MANIFEST_CHUNK_BYTES * 5 },
    totalBytes: MANIFEST_CHUNK_BYTES * 5,
    transferMode: "relay",
    canClaim: false,
    retriesRemaining: 1,
  };
}
const reconnectingManifest = [
  { id: "file-1", name: "alpha.bin", size: MANIFEST_CHUNK_BYTES },
  { id: "file-2", name: "beta.bin", size: MANIFEST_CHUNK_BYTES * 4 },
];

test("polling reconnecting session preserves current active per-file progress", () => {
  const session = reconnectingSession();

  expect(
    reconnectingProgressFromCurrent(session, {
      fileId: "file-2",
      fileName: "beta.bin",
      fileBytes: MANIFEST_CHUNK_BYTES * 2,
      fileTotalBytes: MANIFEST_CHUNK_BYTES * 4,
      completedBytes: MANIFEST_CHUNK_BYTES * 3,
      totalBytes: MANIFEST_CHUNK_BYTES * 5,
      completedFiles: 1,
      totalFiles: 2,
      files: [
        {
          fileId: "file-1",
          fileName: "alpha.bin",
          fileBytes: MANIFEST_CHUNK_BYTES,
          fileTotalBytes: MANIFEST_CHUNK_BYTES,
          state: "completed",
        },
        {
          fileId: "file-2",
          fileName: "beta.bin",
          fileBytes: MANIFEST_CHUNK_BYTES * 2,
          fileTotalBytes: MANIFEST_CHUNK_BYTES * 4,
          state: "reconnecting",
        },
      ],
    }),
  ).toMatchObject({
    fileId: "file-2",
    fileBytes: MANIFEST_CHUNK_BYTES * 2,
    completedBytes: MANIFEST_CHUNK_BYTES * 3,
    completedFiles: 1,
    files: [
      { fileId: "file-1", fileBytes: MANIFEST_CHUNK_BYTES, state: "completed" },
      { fileId: "file-2", fileBytes: MANIFEST_CHUNK_BYTES * 2, state: "reconnecting" },
    ],
  });
});
