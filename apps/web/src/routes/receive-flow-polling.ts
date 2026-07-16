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
  setStage: Dispatch<SetStateAction<ReceiverStage>>;
  setStatus: Dispatch<SetStateAction<string>>;
};

export function shouldStopReceiverRuntimeForReconnectingPoll(stage: ReceiverStage) {
  // A sender signaling reconnect does not invalidate an established DataChannel.
  // Stopping it would discard live transfer state and force a false resume.
  return stage === "manifest" || stage === "connecting";
}

export function isReceiverRuntimeActive(runtime: ReceiverRuntime | null | undefined) {
  return runtime?.isAlive() === true;
}

export function isReceiverRuntimeEstablished(runtime: ReceiverRuntime | null | undefined) {
  return runtime?.isEstablished() === true;
}

export function receiverStageForReconnectingPoll(
  stage: ReceiverStage,
  runtime: ReceiverRuntime | null | undefined,
): ReceiverStage {
  return stage === "receiving" && isReceiverRuntimeEstablished(runtime)
    ? "receiving"
    : "reconnecting";
}

export function shouldRestartReceiverFromReconnectingPoll(
  stage: ReceiverStage,
  runtime: ReceiverRuntime | null | undefined,
) {
  return (
    stage === "reconnecting" || (stage === "receiving" && !isReceiverRuntimeEstablished(runtime))
  );
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
  // completed-view must not be treated as "sender is back" recovery; doing so
  // overwrites stage "completed" and hides Completed Session View after a
  // mid-transfer sender signal reconnect.
  return (
    (stage === "reconnecting" || stage === "receiving") &&
    session.status !== "reconnecting" &&
    session.status !== "ended" &&
    session.status !== "completed-view" &&
    !session.ended &&
    !session.completed
  );
}

export function shouldEndFromSenderEndedPoll(session: SessionPublicView) {
  return session.status === "ended" || session.ended;
}

const TERMINAL_RECEIVER_STAGES = new Set<ReceiverStage>([
  "completed",
  "completion-notice",
  "ended",
  "retry-exhausted",
]);

/**
 * An in-flight getSession poll must not downgrade a stage that already reached
 * a terminal UI state while the network request was outstanding.
 */
export function nextStageAfterSenderRecovery(
  current: ReceiverStage,
  preferred: "manifest" | "receiving",
): ReceiverStage {
  return TERMINAL_RECEIVER_STAGES.has(current) ? current : preferred;
}

export function nextStatusAfterSenderRecovery(current: string, preferred: string): string {
  if (
    current.startsWith("Completed Session View") ||
    current.startsWith("Sender-Ended Session") ||
    current.startsWith("Completion Notice")
  ) {
    return current;
  }
  return preferred;
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
          }
          setStage(receiverStageForReconnectingPoll(stage, runtimeRef.current));
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
          // Functional updates: an in-flight poll must not downgrade a stage that
          // already reached completed/ended while this refresh was awaiting getSession.
          if (shouldRestartReceiverFromReconnectingPoll(stage, runtimeRef.current)) {
            stopReceiverRuntime(runtimeRef);
            setStage((current) => nextStageAfterSenderRecovery(current, "manifest"));
            setStatus((current) =>
              nextStatusAfterSenderRecovery(current, "发送方已重新连接：请继续接收。"),
            );
          } else {
            setStage((current) => nextStageAfterSenderRecovery(current, "receiving"));
            setStatus((current) =>
              nextStatusAfterSenderRecovery(current, "发送方已重新连接，继续接收中。"),
            );
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
