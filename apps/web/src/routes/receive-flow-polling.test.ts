import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import type { SessionPublicView } from "../lib/api";
import type { ReceiverRuntime } from "../lib/transfer";
import {
  isReceiverRuntimeActive,
  isReceiverRuntimeEstablished,
  receiverStageForReconnectingPoll,
  reconnectingProgressFromCurrent,
  shouldEndFromSenderEndedPoll,
  shouldPollSenderEndedForStage,
  shouldRecoverFromReconnectingPoll,
  shouldRestartReceiverFromReconnectingPoll,
  shouldStopReceiverRuntimeForReconnectingPoll,
} from "./receive-flow-polling";
import { RECONNECTING_STATUS } from "./receive-flow-utils";

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

test("reconnecting poll keeps receiver runtime alive once a transfer has started", () => {
  expect(shouldStopReceiverRuntimeForReconnectingPoll("receiving")).toBe(false);
  expect(shouldStopReceiverRuntimeForReconnectingPoll("reconnecting")).toBe(false);
  expect(shouldStopReceiverRuntimeForReconnectingPoll("connecting")).toBe(true);
  expect(shouldStopReceiverRuntimeForReconnectingPoll("manifest")).toBe(true);
});
test("recovered sender signal keeps an active receiver runtime receiving", () => {
  const liveRuntime = {
    stop() {},
    release() {},
    isAlive() {
      return true;
    },
    isEstablished() {
      return true;
    },
  } satisfies ReceiverRuntime;
  expect(shouldRestartReceiverFromReconnectingPoll("reconnecting", liveRuntime)).toBe(true);
  expect(receiverStageForReconnectingPoll("receiving", liveRuntime)).toBe("receiving");
  expect(receiverStageForReconnectingPoll("reconnecting", liveRuntime)).toBe("reconnecting");
  expect(receiverStageForReconnectingPoll("reconnecting", null)).toBe("reconnecting");
  expect(shouldRestartReceiverFromReconnectingPoll("reconnecting", null)).toBe(true);
  const connectingRuntime = {
    ...liveRuntime,
    isEstablished() {
      return false;
    },
  } satisfies ReceiverRuntime;
  expect(isReceiverRuntimeActive(connectingRuntime)).toBe(true);
  expect(isReceiverRuntimeEstablished(connectingRuntime)).toBe(false);
  expect(shouldRestartReceiverFromReconnectingPoll("receiving", connectingRuntime)).toBe(true);
});

test("sender recovery after stopped relay runtime restarts instead of reusing dead object presence", () => {
  const stoppedRuntime = {
    stop() {},
    release() {},
    isAlive() {
      return false;
    },
    isEstablished() {
      return false;
    },
  } satisfies ReceiverRuntime;

  // Presence of a stopped runtime object must not look active.
  expect(stoppedRuntime !== null).toBe(true);
  expect(isReceiverRuntimeActive(stoppedRuntime)).toBe(false);
  expect(shouldRestartReceiverFromReconnectingPoll("reconnecting", stoppedRuntime)).toBe(true);
  expect(shouldRestartReceiverFromReconnectingPoll("receiving", stoppedRuntime)).toBe(true);
});

test("reconnecting receiver stage keeps polling for sender recovery", () => {
  expect(shouldPollSenderEndedForStage("reconnecting")).toBe(true);
});

test("reconnecting poll still updates receiver status while keeping receiving stage", () => {
  expect(RECONNECTING_STATUS).toContain("等待发送方重新连接");
});

test("reconnecting poll does not treat ended session as sender recovery", () => {
  const endedSession = {
    ...reconnectingSession(),
    ended: true,
    state: "ended",
    status: "ended",
  } satisfies SessionPublicView;

  expect(shouldRecoverFromReconnectingPoll("reconnecting", endedSession)).toBe(false);
});

test("sender ended poll recognizes ended session before recovery handling", () => {
  const endedSession = {
    ...reconnectingSession(),
    ended: true,
    state: "ended",
    status: "ended",
  } satisfies SessionPublicView;

  expect(shouldEndFromSenderEndedPoll(endedSession)).toBe(true);
});

test("reconnecting poll clears stale status after active receiving recovers", () => {
  const activeSession = {
    ...reconnectingSession(),
    state: "transferring",
    status: "transferring",
  } satisfies SessionPublicView;

  expect(shouldRecoverFromReconnectingPoll("receiving", activeSession)).toBe(true);
});

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
