import type { TransferMode } from "@p2pfile/shared";
import type { SessionPublicView } from "../lib/api";
import { claimSession, getSession } from "../lib/api";
import { readReceiverToken } from "../lib/session-storage";
import type { TransferProgress } from "../lib/transfer";
import {
  initialProgress,
  RETRY_EXHAUSTED_STATUS,
  type ReceiverStage,
  receiverStageFromClaim,
  receiverStageFromSession,
} from "./receive-flow-utils";

export type ReceiveSessionLoaderContext = {
  navigate: (to: string, options: { replace: boolean }) => void;
  setSession: (session: SessionPublicView | null) => void;
  setProgress: (progress: TransferProgress) => void;
  setMode: (mode: TransferMode | null) => void;
  setStage: (stage: ReceiverStage) => void;
  setStatus: (status: string) => void;
  setError: (error: string | null) => void;
  setRetriesRemaining: (retriesRemaining: number | null) => void;
};

const MANIFEST_LOADED_STATUS = "Frozen Manifest 已载入。点击“接收全部文件”后才会开始传输。";

function applySessionStage(context: ReceiveSessionLoaderContext, session: SessionPublicView) {
  const stage = receiverStageFromSession(session);
  context.setStage(stage);
  context.setStatus(stage === "retry-exhausted" ? RETRY_EXHAUSTED_STATUS : MANIFEST_LOADED_STATUS);
}

export async function loadReceiverSession(
  sessionId: string,
  canonicalizeRoute: boolean,
  context: ReceiveSessionLoaderContext,
) {
  context.setStage("loading");
  context.setError(null);
  context.setRetriesRemaining(null);
  context.setStatus("正在读取会话 metadata-only manifest…");

  try {
    const nextSession = await getSession(sessionId);
    const receiverToken = readReceiverToken(sessionId);

    if (nextSession.status === "completed-view") {
      const completed = await claimSession(sessionId, receiverToken);
      context.setSession(completed.session);
      context.setProgress(initialProgress(completed.session));
      context.setMode(completed.session.transferMode);
      context.setStage(receiverStageFromClaim(completed));
      context.setStatus(
        completed.originalReceiver
          ? "Completed Session View：该接收方可查看短暂只读结果态。"
          : "Completion Notice：该会话已完成；如需重新接收，请让发送方重新创建。",
      );
    } else if (nextSession.status === "claimed") {
      const claimed = await claimSession(sessionId, receiverToken);
      if (claimed.claim === "occupied") {
        context.setSession(claimed.session);
        context.setProgress(initialProgress(claimed.session));
        context.setMode(claimed.session.transferMode);
        context.setStage("occupied");
        context.setStatus("Occupied Session Notice：已有另一个接收方 claim 了该会话。");
      } else {
        context.setSession(claimed.session);
        context.setProgress(initialProgress(claimed.session));
        context.setMode(claimed.session.transferMode);
        if (claimed.claim === "claimed") {
          context.setRetriesRemaining(claimed.retriesRemaining);
        }
        applySessionStage(context, claimed.session);
      }
    } else {
      context.setSession(nextSession);
      context.setProgress(initialProgress(nextSession));
      context.setMode(nextSession.transferMode);
      applySessionStage(context, nextSession);
    }

    if (canonicalizeRoute) {
      context.navigate(`/f/${nextSession.sessionId}`, { replace: true });
    }
  } catch (loadError) {
    context.setError(loadError instanceof Error ? loadError.message : "无法打开会话。");
    context.setStage("failed");
    context.setStatus("无法打开 Temporary Session Window，请检查 Share Link 或 Access Code。");
  }
}
