import type { TransferMode } from "@p2pfile/shared";
import { type RefObject, useEffect } from "react";
import { getSession, type SessionPublicView } from "../lib/api";
import type { ReceiverRuntime, TransferProgress } from "../lib/transfer";
import { stopReceiverRuntime } from "./receive-flow-cleanup";
import { initialProgress, type ReceiverStage } from "./receive-flow-utils";

type SenderEndedPollingOptions = {
  session: SessionPublicView | null;
  stage: ReceiverStage;
  runtimeRef: RefObject<ReceiverRuntime | null>;
  setSession: (session: SessionPublicView | null) => void;
  setProgress: (progress: TransferProgress) => void;
  setMode: (mode: TransferMode | null) => void;
  setStage: (stage: ReceiverStage) => void;
  setStatus: (status: string) => void;
};

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
