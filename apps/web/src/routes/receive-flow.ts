import type { TransferMode } from "@p2pfile/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  claimSession,
  completeSession,
  releaseSession,
  resolveAccessCode,
  type SessionPublicView,
} from "../lib/api";
import { clearReceiverToken, readReceiverToken, writeReceiverToken } from "../lib/session-storage";
import type { ReceivedFile, ReceiverRuntime, TransferProgress } from "../lib/transfer";
import { startReceiverRuntime } from "../lib/transfer";
import {
  clearReceivedFiles,
  revokeReceivedFiles,
  stopReceiverRuntime,
} from "./receive-flow-cleanup";
import { loadReceiverSession } from "./receive-flow-loader";
import { useSenderEndedPolling } from "./receive-flow-polling";
import type { ReceiveFlowState } from "./receive-flow-types";
import {
  initialProgress,
  RETRY_EXHAUSTED_STATUS,
  type ReceiverStage,
  receiverStageFromClaim,
  sessionIdFromEntry,
} from "./receive-flow-utils";
import {
  cacheReceivedFile,
  clearCachedReceivedFiles,
  readCachedReceivedFiles,
} from "./received-file-cache";

export function useReceiveFlow(): ReceiveFlowState {
  const { sessionId: routeSessionId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [entryValue, setEntryValue] = useState("");
  const [session, setSession] = useState<SessionPublicView | null>(null);
  const [stage, setStage] = useState<ReceiverStage>(
    routeSessionId || searchParams.get("session") ? "loading" : "entry",
  );
  const [status, setStatus] = useState(
    "粘贴 Share Link 或 Access Code，先查看 Frozen Manifest 再 claim。",
  );
  const [mode, setMode] = useState<TransferMode | null>(null);
  const [progress, setProgress] = useState<TransferProgress>(initialProgress(null));
  const [speed, setSpeed] = useState<number | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [retriesRemaining, setRetriesRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runtimeRef = useRef<ReceiverRuntime | null>(null);
  const sampleRef = useRef<{ bytes: number; at: number } | null>(null);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);
  const previousSessionIdRef = useRef<string | null>(null);

  const initialSessionId = useMemo(
    () => routeSessionId ?? searchParams.get("session"),
    [routeSessionId, searchParams],
  );

  const loadSession = useCallback(
    async (sessionId: string, canonicalizeRoute: boolean) => {
      await loadReceiverSession(sessionId, canonicalizeRoute, {
        navigate,
        setSession,
        setProgress,
        setMode,
        setStage,
        setStatus,
        setError,
        setRetriesRemaining,
      });
    },
    [navigate],
  );

  useEffect(() => {
    if (!initialSessionId) {
      return;
    }

    void loadSession(initialSessionId, false);
  }, [initialSessionId, loadSession]);
  useEffect(() => {
    receivedFilesRef.current = receivedFiles;
  }, [receivedFiles]);
  useEffect(() => {
    return () => {
      stopReceiverRuntime(runtimeRef);
      revokeReceivedFiles(receivedFilesRef.current);
    };
  }, []);
  useEffect(() => {
    const nextSessionId = session?.sessionId ?? null;
    if (
      previousSessionIdRef.current &&
      nextSessionId &&
      previousSessionIdRef.current !== nextSessionId
    ) {
      clearReceivedFiles(receivedFilesRef, setReceivedFiles);
    }
    previousSessionIdRef.current = nextSessionId;
  }, [session]);

  useSenderEndedPolling({
    session,
    stage,
    runtimeRef,
    setSession,
    setProgress,
    setMode,
    setStage,
    setStatus,
  });

  async function openEntry() {
    const entry = sessionIdFromEntry(entryValue);
    if (!entry) {
      setError("请输入 Share Link 或 Access Code。");
      return;
    }

    setError(null);
    setStage("loading");

    try {
      if (/^[a-f0-9]{12}$/i.test(entry)) {
        await loadSession(entry, true);
        return;
      }

      const resolved = await resolveAccessCode(entry);
      await loadSession(resolved.sessionId, true);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "Access Code 无效。");
      setStage("failed");
    }
  }
  async function claimCurrentSession() {
    if (!session) {
      return;
    }
    const currentReceiverToken = readReceiverToken(session.sessionId);
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
      if (!retryingSameReceiver && response.claim === "claimed" && resumeFiles.length > 0) {
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
        setStatus(
          response.originalReceiver
            ? "Completed Session View：该接收方可查看短暂只读结果态。"
            : "Completion Notice：该会话已完成；如需重新接收，请让发送方重新创建。",
        );
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
            const now = Date.now();
            const lastSample = sampleRef.current;
            if (lastSample) {
              const elapsed = (now - lastSample.at) / 1000;
              if (elapsed > 0) {
                setSpeed(Math.max(0, (nextProgress.completedBytes - lastSample.bytes) / elapsed));
              }
            }
            sampleRef.current = { bytes: nextProgress.completedBytes, at: now };
          },
          onFileReceived(file) {
            setReceivedFiles((current) => {
              void cacheReceivedFile(session.sessionId, file, current.length);
              return [...current, file];
            });
          },
          onComplete() {
            setStage("completed");
            setStatus("Completed Session View：全部文件已接收并通过字节数校验。");
            void completeSession(session.sessionId, response.receiverToken ?? "");
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
  async function releaseCurrentClaim() {
    if (!session) {
      return;
    }

    const token = readReceiverToken(session.sessionId);
    if (!token) {
      return;
    }

    try {
      stopReceiverRuntime(runtimeRef);
      await releaseSession(session.sessionId, token);
      clearReceiverToken(session.sessionId);
      clearReceivedFiles(receivedFilesRef, setReceivedFiles);
      void clearCachedReceivedFiles(session.sessionId);
      setRetriesRemaining(null);
      await loadSession(session.sessionId, false);
      setStatus("已放弃 claim，会话回到 pre-claim 状态。");
    } catch (releaseError) {
      setError(releaseError instanceof Error ? releaseError.message : "放弃 claim 失败。");
    }
  }

  return {
    claimCurrentSession,
    entryValue,
    error,
    mode,
    openEntry,
    progress,
    receivedFiles,
    releaseCurrentClaim,
    retriesRemaining,
    session,
    setEntryValue,
    speed,
    stage,
    status,
  };
}
