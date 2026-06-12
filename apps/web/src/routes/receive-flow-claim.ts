import type { TransferMode } from "@p2pfile/shared";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { claimSession, completeSession, type SessionPublicView } from "../lib/api";
import { writeReceiverToken } from "../lib/session-storage";
import type { ReceivedFile, ReceiverRuntime, TransferProgress } from "../lib/transfer";
import { startReceiverRuntime } from "../lib/transfer";
import { clearReceivedFiles, stopReceiverRuntime } from "./receive-flow-cleanup";
import {
  initialProgress,
  RETRY_EXHAUSTED_STATUS,
  type ReceiverStage,
  receiverStageFromClaim,
} from "./receive-flow-utils";
import {
  cacheReceivedFile,
  clearCachedReceivedFiles,
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
    if (resumedFiles.length > 0) {
      restoreReceivedFiles(resumedFiles, receivedFilesRef, setReceivedFiles);
    } else if (!retryingSameReceiver && response.claim === "claimed" && resumeFiles.length > 0) {
      clearReceivedFiles(receivedFilesRef, setReceivedFiles);
      void clearCachedReceivedFiles(session.sessionId);
    }
    setSession(response.session);
    setProgress(initialProgress(response.session, resumedFiles.length));
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
          setStatus(nextStatus);
          setStage(nextStatus.includes("Receiving") ? "receiving" : "connecting");
        },
        onMode(nextMode) {
          setMode(nextMode);
        },
        onProgress(nextProgress) {
          setProgress(nextProgress);
          setStage("receiving");
          updateSpeed(nextProgress, sampleRef, setSpeed);
        },
        onFileReceived(file) {
          const next = [...receivedFilesRef.current, file];
          receivedFilesRef.current = next;
          setReceivedFiles(next);
          void cacheReceivedFile(session.sessionId, file, next.length - 1);
        },
        onComplete() {
          const completedFiles = receivedFilesRef.current.map((file) => ({
            id: file.id,
            bytes: file.size,
          }));
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
          setStage("ended");
          setStatus("Sender-Ended Session：发送方已离开，请请求重新创建会话。");
        },
        onError(message) {
          setError(message);
          setStage("failed");
        },
      },
      resumedFiles,
    );
  } catch (claimError) {
    setError(claimError instanceof Error ? claimError.message : "Claim 失败。");
    setStage("failed");
    setStatus("Claim 或连接失败。请重试或请求发送方重新创建会话。");
  }
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
