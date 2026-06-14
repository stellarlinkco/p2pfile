import { expect, test } from "bun:test";
import type { SessionPublicView } from "../lib/api";
import {
  progressFromCommitted,
  receiverStageFromClaim,
  receiverStageFromSession,
  sessionIdFromEntry,
} from "./receive-flow-utils";

const failedSession: SessionPublicView = {
  accessCode: "ABC234",
  canClaim: false,
  claimed: false,
  claimedAt: null,
  completed: false,
  completedAt: null,
  ended: false,
  endedAt: null,
  expiresAt: null,
  failureReason: "retry-budget-exhausted",
  fileCount: 1,
  files: [{ id: "file-1", name: "hello.txt", size: 5 }],
  manifest: [{ id: "file-1", name: "hello.txt", size: 5 }],
  sessionId: "session-1",
  sharePath: "/f/session-1",
  state: "failed",
  status: "failed",
  summary: { fileCount: 1, totalSize: 5 },
  totalBytes: 5,
  retriesRemaining: 0,
  transferMode: "direct",
};

test("retry-budget-exhausted claim routes to the retry-exhausted stage", () => {
  const stage = receiverStageFromClaim({
    claim: "failed",
    ok: true,
    originalReceiver: false,
    receiverToken: null,
    retriesRemaining: null,
    session: failedSession,
  });

  expect(stage).toBe("retry-exhausted");
});

test("failed session view routes visitors to the retry-exhausted stage", () => {
  expect(receiverStageFromSession(failedSession)).toBe("retry-exhausted");
});

test("recoverable sender reconnecting session routes to reconnecting guidance", () => {
  expect(
    receiverStageFromSession({
      ...failedSession,
      canClaim: false,
      claimed: true,
      ended: false,
      expiresAt: Date.now() + 30_000,
      failureReason: undefined,
      retriesRemaining: 2,
      state: "reconnecting",
      status: "reconnecting",
    }),
  ).toBe("reconnecting");
});

test("completed claim without local files routes to completion notice", () => {
  const stage = receiverStageFromClaim({
    claim: "completed",
    ok: true,
    originalReceiver: true,
    receiverToken: null,
    retriesRemaining: null,
    session: {
      accessCode: "ABC123",
      canClaim: false,
      claimed: true,
      claimedAt: null,
      completed: true,
      completedAt: null,
      ended: false,
      endedAt: null,
      expiresAt: null,
      failureReason: undefined,
      fileCount: 1,
      files: [{ id: "file-1", name: "hello.txt", size: 5 }],
      manifest: [{ id: "file-1", name: "hello.txt", size: 5 }],
      sessionId: "session-1",
      sharePath: "/f/session-1",
      state: "completed-view",
      status: "completed-view",
      summary: { fileCount: 1, totalSize: 5 },
      totalBytes: 5,
      retriesRemaining: 0,
      transferMode: "direct",
    },
  });

  expect(stage).toBe("completion-notice");
});

test("per-file progress exposes queued completed and reconnecting states", () => {
  const session: SessionPublicView = {
    ...failedSession,
    files: [
      { id: "file-1", name: "done.txt", size: 5 },
      { id: "file-2", name: "partial.zip", size: 64 * 1024 * 4 },
      { id: "file-3", name: "queued.bin", size: 7 },
    ],
    manifest: [
      { id: "file-1", name: "done.txt", size: 5 },
      { id: "file-2", name: "partial.zip", size: 64 * 1024 * 4 },
      { id: "file-3", name: "queued.bin", size: 7 },
    ],
    summary: { fileCount: 3, totalSize: 64 * 1024 * 4 + 12 },
    totalBytes: 64 * 1024 * 4 + 12,
  };

  const progress = progressFromCommitted(
    session,
    new Map([
      ["file-1", 5],
      ["file-2", 64 * 1024],
    ]),
  );

  expect(progress.fileId).toBe("file-2");
  expect(progress.completedFiles).toBe(1);
  expect(progress.files?.map((file) => [file.fileId, file.state])).toEqual([
    ["file-1", "completed"],
    ["file-2", "reconnecting"],
    ["file-3", "queued"],
  ]);
});

test("malformed percent escapes do not throw while parsing receiver entries", () => {
  expect(sessionIdFromEntry("https://p2pfile.local/f/%E0%A4%A")).toBe("%E0%A4%A");
  expect(sessionIdFromEntry("/f/%E0%A4%A")).toBe("%E0%A4%A");
});
