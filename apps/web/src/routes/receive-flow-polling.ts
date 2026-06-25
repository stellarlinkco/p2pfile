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

export function shouldStopReceiverRuntimeForReconnectingPoll(stage: ReceiverStage) {
  return stage !== "receiving";
}

export function shouldPollSenderEndedForStage(stage: ReceiverStage) {
  return (
    stage === "manifest" ||
    stage === "connecting" ||
    stage === "receiving" ||
    stage === "reconnecting"
  );
}

export function shouldRecoverFromReconnectingPoll(
  stage: ReceiverStage,
  session: SessionPublicView,
) {
  return (
    (stage === "reconnecting" || stage === "receiving") &&
    session.status !== "reconnecting" &&
    session.status !== "ended" &&
    !session.ended
  );
}

export function shouldEndFromSenderEndedPoll(session: SessionPublicView) {
  return session.status === "ended" || session.ended;
}

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
    if (!session || !shouldPollSenderEndedForStage(stage)) {
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
          setStatus(RECONNECTING_STATUS);
          if (shouldStopReceiverRuntimeForReconnectingPoll(stage)) {
            stopReceiverRuntime(runtimeRef);
            setStage("reconnecting");
          }
          return;
        }

        if (shouldEndFromSenderEndedPoll(latest)) {
          setSession(latest);
          setProgress(initialProgress(latest));
          setMode(latest.transferMode);
          stopReceiverRuntime(runtimeRef);
          setStage("ended");
          setStatus("Sender-Ended Session：发送方已离开，请请求重新创建会话。");
          return;
        }

        if (shouldRecoverFromReconnectingPoll(stage, latest)) {
          setSession(latest);
          setMode(latest.transferMode);
          if (stage === "reconnecting") {
            setStage("manifest");
            setStatus("发送方已重新连接：请继续接收。");
          } else {
            setStatus("发送方已重新连接，继续接收中。");
          }
          return;
        }

        if (latest.status !== "ended") {
          return;
        }
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
