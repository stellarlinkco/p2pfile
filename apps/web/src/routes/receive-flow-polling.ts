import type { TransferMode } from "@p2pfile/shared";
import { type Dispatch, type RefObject, type SetStateAction, useEffect } from "react";
import { getSession, type SessionPublicView } from "../lib/api";
import type { ReceiverRuntime, TransferProgress } from "../lib/transfer";
import { stopReceiverRuntime } from "./receive-flow-cleanup";
import {
  initialProgress,
  progressFromCommitted,
  RECONNECTING_STATUS,
  type ReceiverStage,
} from "./receive-flow-utils";

type SenderEndedPollingOptions = {
  session: SessionPublicView | null;
  stage: ReceiverStage;
  runtimeRef: RefObject<ReceiverRuntime | null>;
  setSession: (session: SessionPublicView | null) => void;
  setProgress: Dispatch<SetStateAction<TransferProgress>>;
  setMode: (mode: TransferMode | null) => void;
  setStage: (stage: ReceiverStage) => void;
  setStatus: (status: string) => void;
};

export function reconnectingProgressFromCurrent(
  session: SessionPublicView,
  current: TransferProgress,
) {
  const committedBytesByFileId = new Map<string, number>();
  for (const file of current.files ?? []) {
    if (file.fileBytes > 0) {
      committedBytesByFileId.set(file.fileId, file.fileBytes);
    }
  }
  return progressFromCommitted(session, committedBytesByFileId);
}

export function useSenderEndedPolling({
  session,
  stage,
  runtimeRef,
  setSession,
  setProgress,
  setMode,
  setStage,
  setStatus,
}: SenderEndedPollingOptions) {
  useEffect(() => {
    if (!session || (stage !== "manifest" && stage !== "connecting" && stage !== "receiving")) {
      return;
    }

    const sessionId = session.sessionId;
    const refresh = async () => {
      try {
        const latest = await getSession(sessionId);
        if (latest.status === "reconnecting") {
          setSession(latest);
          setProgress((current) => reconnectingProgressFromCurrent(latest, current));
          setMode(latest.transferMode);
          stopReceiverRuntime(runtimeRef);
          setStage("reconnecting");
          setStatus(RECONNECTING_STATUS);
          return;
        }

        if (latest.status !== "ended") {
          return;
        }

        setSession(latest);
        setProgress(initialProgress(latest));
        setMode(latest.transferMode);
        stopReceiverRuntime(runtimeRef);
        setStage("ended");
        setStatus("Sender-Ended Session：发送方已离开，请请求重新创建会话。");
      } catch {
        // Ignore transient polling failures.
      }
    };

    const timer = window.setInterval(() => {
      void refresh();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [session, stage, runtimeRef, setSession, setProgress, setMode, setStage, setStatus]);
}
