import type { TransferMode } from "@p2pfile/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { releaseSession, resolveAccessCode, type SessionPublicView } from "../lib/api";
import { clearReceiverToken, readReceiverToken } from "../lib/session-storage";
import type {
  ReceivedFile,
  ReceiverRuntime,
  TransferProgress,
  TransportDiagnostics,
} from "../lib/transfer";
import { TransferRateSampler } from "../lib/transfer/transfer-rate-sampler";
import { claimReceiverSession } from "./receive-flow-claim";
import {
  clearReceivedFiles,
  revokeReceivedFiles,
  stopReceiverRuntime,
} from "./receive-flow-cleanup";
import { loadReceiverSession } from "./receive-flow-loader";
import { useSenderEndedPolling } from "./receive-flow-polling";
import type { ReceiveFlowState } from "./receive-flow-types";
import { initialProgress, type ReceiverStage, sessionIdFromEntry } from "./receive-flow-utils";
import { clearCachedReceivedFiles } from "./received-file-cache";

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
  const [transportDiagnostics, setTransportDiagnostics] = useState<TransportDiagnostics | null>(
    null,
  );
  const [progress, setProgress] = useState<TransferProgress>(initialProgress(null));
  const [speed, setSpeed] = useState<number | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [retriesRemaining, setRetriesRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runtimeRef = useRef<ReceiverRuntime | null>(null);
  const speedSampler = useMemo(() => new TransferRateSampler(), []);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);
  const progressBytesRef = useRef(0);
  const previousSessionIdRef = useRef<string | null>(null);
  const sessionLoadRef = useRef<{ key: string; promise: Promise<void> } | null>(null);

  const initialSessionId = useMemo(
    () => routeSessionId ?? searchParams.get("session"),
    [routeSessionId, searchParams],
  );

  const loadSession = useCallback(
    (sessionId: string, canonicalizeRoute: boolean) => {
      const key = `${sessionId}:${canonicalizeRoute}`;
      const pending = sessionLoadRef.current;
      if (pending?.key === key) return pending.promise;

      const promise = loadReceiverSession(sessionId, canonicalizeRoute, {
        navigate,
        setSession,
        setProgress,
        setMode,
        setStage,
        setStatus,
        setError,
        setRetriesRemaining,
        setReceivedFiles,
      }).finally(() => {
        if (sessionLoadRef.current?.promise === promise) sessionLoadRef.current = null;
      });
      sessionLoadRef.current = { key, promise };
      return promise;
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
    progressBytesRef.current = progress.completedBytes;
  }, [progress.completedBytes]);
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

  useEffect(() => {
    if (stage !== "receiving") return;
    const timer = setInterval(() => {
      const nextSpeed = speedSampler.sample(progressBytesRef.current);
      if (nextSpeed !== undefined) setSpeed(nextSpeed);
    }, 250);
    return () => clearInterval(timer);
  }, [speedSampler, stage]);

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
    setTransportDiagnostics(null);
    await claimReceiverSession({
      session,
      currentReceiverToken: session ? readReceiverToken(session.sessionId) : null,
      runtimeRef,
      speedSampler,
      progressBytesRef,
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
      setTransportDiagnostics,
    });
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
      const release = await releaseSession(session.sessionId, token);
      if (release.release === "invalid-token") {
        setSession(release.session);
        setProgress(initialProgress(release.session));
        setMode(release.session.transferMode);
        setStatus("Receiver Token 无效，当前 claim 未释放。请刷新后重试。");
        return;
      }
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
    transportDiagnostics,
  };
}
