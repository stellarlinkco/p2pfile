import type { TransferMode } from "@p2pfile/shared";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { claimSession, completeSession, type SessionPublicView } from "../lib/api";
import { writeReceiverToken } from "../lib/session-storage";
import type { ReceivedFile, ReceiverRuntime, TransferProgress } from "../lib/transfer";
import { startReceiverRuntime } from "../lib/transfer";
import { clearReceivedFiles, stopReceiverRuntime } from "./receive-flow-cleanup";
import {
  nextReceiverStageAfterProgress,
  progressFromCommitted,
  RECONNECTING_STATUS,
  RETRY_EXHAUSTED_STATUS,
  type ReceiverStage,
  receiverStageFromClaim,
} from "./receive-flow-utils";
import {
  cacheActiveReceiveProgress,
  cacheReceivedFile,
  clearCachedActiveReceiveProgress,
  clearCachedReceivedFiles,
  readCachedActiveReceiveProgress,
  readCachedReceivedFiles,
} from "./received-file-cache";

type ClaimReceiverSessionOptions = {
  session: SessionPublicView | null;
  currentReceiverToken: string | null;
  runtimeRef: RefObject<ReceiverRuntime | null>;
  sampleRef: RefObject<{ bytes: number; at: number } | null>;
  receivedFilesRef: RefObject<ReceivedFile[]>;
  setSession: Dispatch<SetStateAction<SessionPublicView | null>>;
  setStage: Dispatch<SetStateAction<ReceiverStage>>;
  setStatus: Dispatch<SetStateAction<string>>;
  setMode: Dispatch<SetStateAction<TransferMode | null>>;
  setProgress: Dispatch<SetStateAction<TransferProgress>>;
  setSpeed: Dispatch<SetStateAction<number | null>>;
  setReceivedFiles: Dispatch<SetStateAction<ReceivedFile[]>>;
  setRetriesRemaining: Dispatch<SetStateAction<number | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
};

export function resumeCommittedBytesByFileId(
  sessionId: string,
  manifest: SessionPublicView["files"],
  resumedFiles: ReceivedFile[],
) {
  const committedBytesByFileId = readCachedActiveReceiveProgress(sessionId, manifest);
  for (const file of resumedFiles) {
    committedBytesByFileId.set(file.id, file.size);
  }
  return committedBytesByFileId;
}

export async function claimReceiverSession({
  session,
  currentReceiverToken,
  runtimeRef,
  sampleRef,
  receivedFilesRef,
  setSession,
  setStage,
  setStatus,
  setMode,
  setProgress,
  setSpeed,
  setReceivedFiles,
  setRetriesRemaining,
  setError,
}: ClaimReceiverSessionOptions) {
  if (!session) {
    return;
  }

  const memoryFiles = receivedFilesRef.current;
  const cachedFiles = currentReceiverToken
    ? await readCachedReceivedFiles(session.sessionId, session.files)
    : [];
  const resumeFiles = memoryFiles.length >= cachedFiles.length ? memoryFiles : cachedFiles;
  stopReceiverRuntime(runtimeRef);
  setStage("claiming");
  setError(null);
  setStatus("正在 claim 会话…");
  let runtimeFinished = false;
  sampleRef.current = null;

  try {
    const response = await claimSession(session.sessionId, currentReceiverToken);
    const retryingSameReceiver =
      response.claim === "claimed" &&
      currentReceiverToken !== null &&
      response.receiverToken === currentReceiverToken;
    const resumedFiles =
      retryingSameReceiver || (response.claim === "completed" && response.originalReceiver)
        ? resumeFiles
        : [];
    const committedBytesByFileId = resumeCommittedBytesByFileId(
      session.sessionId,
      response.session.files,
      resumedFiles,
    );
    if (resumedFiles.length > 0) {
      restoreReceivedFiles(resumedFiles, receivedFilesRef, setReceivedFiles);
    } else if (!retryingSameReceiver && response.claim === "claimed" && resumeFiles.length > 0) {
      clearReceivedFiles(receivedFilesRef, setReceivedFiles);
      void clearCachedReceivedFiles(session.sessionId);
    }
    setSession(response.session);
    setProgress(progressFromCommitted(response.session, committedBytesByFileId));
    setStage(receiverStageFromClaim(response));
    setRetriesRemaining(response.claim === "claimed" ? response.retriesRemaining : null);

    if (response.claim === "failed") {
      setStatus(RETRY_EXHAUSTED_STATUS);
      return;
    }

    if (response.claim === "occupied") {
      setStatus("Occupied Session Notice：已有另一个接收方 claim 了该会话。");
      return;
    }

    if (response.claim === "ended") {
      setStatus("Sender-Ended Session：发送方已结束当前会话，请请求重新创建。");
      return;
    }

    if (response.claim === "completed") {
      if (response.originalReceiver) {
        const cachedFiles = await readCachedReceivedFiles(
          session.sessionId,
          response.session.files,
        );
        setStage("completed");
        restoreReceivedFiles(cachedFiles, receivedFilesRef, setReceivedFiles);
        setStatus("Completed Session View：该接收方可查看短暂只读结果态。");
        return;
      }
      clearReceivedFiles(receivedFilesRef, setReceivedFiles);
      setStage("completion-notice");
      void clearCachedReceivedFiles(session.sessionId);
      setStatus("Completion Notice：该会话已完成；如需重新接收，请让发送方重新创建。");
      return;
    }

    if (!response.receiverToken) {
      throw new Error("Claim succeeded without Receiver Token.");
    }

    writeReceiverToken(session.sessionId, response.receiverToken);
    setStatus("已 claim，会话排他。正在建立 WebRTC DataChannel…");
    runtimeRef.current = await startReceiverRuntime(
      session.sessionId,
      response.receiverToken,
      response.session.files,
      {
        onStatus(nextStatus) {
          if (runtimeFinished) {
            return;
          }
          const reconnecting = nextStatus === "Waiting for peer reconnect";
          setStatus((current) =>
            current.startsWith("Completed Session View")
              ? current
              : reconnecting
                ? RECONNECTING_STATUS
                : nextStatus,
          );
          if (reconnecting) {
            setProgress((current) => {
              if (runtimeFinished) {
                return current;
              }
              return markFileStates(current, "receiving", "reconnecting");
            });
          }
          setStage((current) => {
            if (runtimeFinished || current === "completed") {
              return current;
            }
            return reconnecting
              ? "reconnecting"
              : nextStatus.includes("Receiving")
                ? "receiving"
                : "connecting";
          });
        },
        onMode(nextMode) {
          if (runtimeFinished) {
            return;
          }
          setMode(nextMode);
        },
        onProgress(nextProgress) {
          if (runtimeFinished) {
            return;
          }
          setProgress(nextProgress);
          setStage((current) => nextReceiverStageAfterProgress(current, runtimeFinished));
          cacheActiveReceiveProgress(
            session.sessionId,
            response.session.files,
            nextProgress.fileId,
            nextProgress.fileBytes,
          );
          updateSpeed(nextProgress, sampleRef, setSpeed);
        },
        onFileReceived(file) {
          if (runtimeFinished) {
            return;
          }
          clearCachedActiveReceiveProgress(session.sessionId, file.id);
          const next = mergeReceivedFile(receivedFilesRef.current, file, response.session.files);
          receivedFilesRef.current = next;
          setReceivedFiles(next);
          const manifestIndex = response.session.files.findIndex(
            (manifestFile) => manifestFile.id === file.id,
          );
          if (manifestIndex >= 0) {
            void cacheReceivedFile(session.sessionId, file, manifestIndex);
          }
        },
        onComplete() {
          if (runtimeFinished) {
            return;
          }
          runtimeFinished = true;
          clearCachedActiveReceiveProgress(session.sessionId);
          const completedFiles = response.session.files.map((manifestFile) => {
            const file = receivedFilesRef.current.find(
              (receivedFile) => receivedFile.id === manifestFile.id,
            );
            return { id: manifestFile.id, bytes: file?.size ?? 0 };
          });
          setStage("completed");
          setStatus("Completed Session View：全部文件已接收并通过字节数校验。");
          void completeSession(
            session.sessionId,
            response.receiverToken ?? "",
            completedFiles,
            response.session.totalBytes,
          );
        },
        onEnded() {
          if (runtimeFinished) {
            return;
          }
          runtimeFinished = true;
          setStage("ended");
          setStatus("Sender-Ended Session：发送方已离开，请请求重新创建会话。");
        },
        onError(message) {
          if (runtimeFinished) {
            return;
          }
          runtimeFinished = true;
          setError(message);
          setProgress(markIncompleteFileStates);
          setStage("failed");
        },
      },
      resumedFiles,
      committedBytesByFileId,
    );
  } catch (claimError) {
    setError(claimError instanceof Error ? claimError.message : "Claim 失败。");
    setStage("failed");
    setStatus("Claim 或连接失败。请重试或请求发送方重新创建会话。");
  }
}

function markFileStates(
  progress: TransferProgress,
  from: "queued" | "receiving" | "reconnecting" | "completed" | "failed",
  to: "queued" | "receiving" | "reconnecting" | "completed" | "failed",
) {
  return {
    ...progress,
    files: progress.files?.map((file) => ({
      ...file,
      state: file.state === from ? to : file.state,
    })),
  } satisfies TransferProgress;
}

function markIncompleteFileStates(progress: TransferProgress) {
  return {
    ...progress,
    files: progress.files?.map((file) => ({
      ...file,
      state: file.state === "completed" ? "completed" : "failed",
    })),
  } satisfies TransferProgress;
}

function mergeReceivedFile(
  current: ReceivedFile[],
  file: ReceivedFile,
  manifest: SessionPublicView["files"],
) {
  const byId = new Map(current.map((receivedFile) => [receivedFile.id, receivedFile]));
  byId.set(file.id, file);
  return manifest.flatMap((manifestFile) => {
    const receivedFile = byId.get(manifestFile.id);
    return receivedFile ? [receivedFile] : [];
  });
}

function restoreReceivedFiles(
  files: ReceivedFile[],
  receivedFilesRef: RefObject<ReceivedFile[]>,
  setReceivedFiles: Dispatch<SetStateAction<ReceivedFile[]>>,
) {
  receivedFilesRef.current = files;
  setReceivedFiles(files);
}

function updateSpeed(
  nextProgress: TransferProgress,
  sampleRef: RefObject<{ bytes: number; at: number } | null>,
  setSpeed: Dispatch<SetStateAction<number | null>>,
) {
  const now = Date.now();
  const lastSample = sampleRef.current;
  if (lastSample) {
    const elapsed = (now - lastSample.at) / 1000;
    if (elapsed > 0) {
      setSpeed(Math.max(0, (nextProgress.completedBytes - lastSample.bytes) / elapsed));
    }
  }
  sampleRef.current = { bytes: nextProgress.completedBytes, at: now };
}
