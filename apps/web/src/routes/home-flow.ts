import type { FileManifestItem, TransferMode } from "@p2pfile/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildShareUrl,
  createSession,
  endSession,
  type SessionPublicView,
  sendEndSessionBeacon,
} from "../lib/api";
import type { SenderRuntime, TransferProgress } from "../lib/transfer";
import { startSenderRuntime } from "../lib/transfer";

export type SenderStage =
  | "idle"
  | "creating"
  | "waiting"
  | "transferring"
  | "completed"
  | "ended"
  | "failed";

export type SenderShareState = {
  session: SessionPublicView;
  senderToken: string;
  shareUrl: string;
};

export type SenderFlowState = {
  createCurrentSession: () => Promise<void>;
  endCurrentSession: () => Promise<void>;
  error: string | null;
  manifest: FileManifestItem[];
  mode: TransferMode | null;
  progress: TransferProgress;
  selectedFiles: File[];
  setSelectedFiles: (files: File[]) => void;
  shareState: SenderShareState | null;
  speed: number | null;
  stage: SenderStage;
  status: string;
  totalBytes: number;
};

function manifestFromFiles(files: File[]) {
  return files.map((file, index) => ({
    id: `local-${index + 1}`,
    name: file.name,
    size: file.size,
  })) satisfies FileManifestItem[];
}

function progressFromFiles(files: File[]): TransferProgress {
  return {
    fileId: null,
    fileName: null,
    fileBytes: 0,
    fileTotalBytes: 0,
    completedBytes: 0,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    completedFiles: 0,
    totalFiles: files.length,
  };
}

export function useSenderFlow(): SenderFlowState {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [stage, setStage] = useState<SenderStage>("idle");
  const [status, setStatus] = useState("选择文件后创建 Temporary Session Window。");
  const [error, setError] = useState<string | null>(null);
  const [shareState, setShareState] = useState<SenderShareState | null>(null);
  const [mode, setMode] = useState<TransferMode | null>(null);
  const [progress, setProgress] = useState<TransferProgress>(progressFromFiles([]));
  const [speed, setSpeed] = useState<number | null>(null);
  const runtimeRef = useRef<SenderRuntime | null>(null);
  const sampleRef = useRef<{ bytes: number; at: number } | null>(null);
  const stageRef = useRef<SenderStage>("idle");

  const manifest = useMemo(() => manifestFromFiles(selectedFiles), [selectedFiles]);
  const totalBytes = useMemo(() => manifest.reduce((sum, file) => sum + file.size, 0), [manifest]);

  useEffect(() => {
    return () => {
      runtimeRef.current?.stop();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    const handleUnload = () => {
      if (!shareState || stageRef.current === "completed") {
        return;
      }

      runtimeRef.current?.markSenderLeft();
      void endSession(shareState.session.sessionId, shareState.senderToken, true).catch(
        () => undefined,
      );
      sendEndSessionBeacon(shareState.session.sessionId, shareState.senderToken);
    };

    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("pagehide", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pagehide", handleUnload);
    };
  }, [shareState]);

  async function createCurrentSession() {
    if (selectedFiles.length === 0) {
      setError("请先选择至少一个文件。");
      return;
    }

    runtimeRef.current?.stop();
    runtimeRef.current = null;
    setError(null);
    setStage("creating");
    setStatus("正在冻结文件清单并创建会话…");
    setMode(null);
    setSpeed(null);
    sampleRef.current = null;
    setProgress(progressFromFiles(selectedFiles));

    try {
      const response = await createSession(manifest);
      const session = {
        ...response.session,
        sharePath: `/f/${response.sessionId}`,
      } satisfies SessionPublicView;
      setShareState({
        session,
        senderToken: response.senderToken,
        shareUrl: buildShareUrl(`/f/${response.sessionId}`),
      });
      setStage("waiting");
      setStatus("会话已创建。等待接收方 claim 并建立连接。");

      runtimeRef.current = await startSenderRuntime(
        response.sessionId,
        response.senderToken,
        selectedFiles,
        {
          onStatus(nextStatus) {
            setStatus(nextStatus);
            setStage(
              nextStatus.includes("Transfer") || nextStatus.includes("Transferring")
                ? "transferring"
                : "waiting",
            );
          },
          onMode(nextMode) {
            setMode(nextMode);
          },
          onProgress(nextProgress) {
            setProgress(nextProgress);
            setStage("transferring");
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
          onComplete() {
            setStage("completed");
            setStatus("Completed Session View：所有文件已发送完成。");
          },
          onError(message) {
            setError(message);
            setStage("failed");
            setStatus("连接失败。请重新创建会话。");
          },
        },
      );
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "创建会话失败。");
      setStage("failed");
      setStatus("创建失败，请重试。");
    }
  }

  async function endCurrentSession() {
    if (!shareState) {
      return;
    }

    try {
      runtimeRef.current?.markSenderLeft();
      await endSession(shareState.session.sessionId, shareState.senderToken, true);
      runtimeRef.current?.stop();
      runtimeRef.current = null;
      setStage("ended");
      setStatus("Sender-Ended Session：当前会话已结束。");
    } catch (endError) {
      setError(endError instanceof Error ? endError.message : "结束会话失败。");
    }
  }

  return {
    createCurrentSession,
    endCurrentSession,
    error,
    manifest,
    mode,
    progress,
    selectedFiles,
    setSelectedFiles,
    shareState,
    speed,
    stage,
    status,
    totalBytes,
  };
}
