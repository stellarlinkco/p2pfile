import type { TransferMode } from "@p2pfile/shared";
import type { SessionPublicView } from "../lib/api";
import { claimSession, getSession, validateReceiverToken } from "../lib/api";
import { clearReceiverToken, readReceiverToken } from "../lib/session-storage";
import type { ReceivedFile, TransferProgress } from "../lib/transfer";
import {
  initialProgress,
  progressFromCommitted,
  RECONNECTING_STATUS,
  RETRY_EXHAUSTED_STATUS,
  type ReceiverStage,
  receiverStageFromSession,
} from "./receive-flow-utils";
import { readCachedActiveReceiveProgress, readCachedReceivedFiles } from "./received-file-cache";

export type ReceiveSessionLoaderContext = {
  navigate: (to: string, options: { replace: boolean }) => void;
  setSession: (session: SessionPublicView | null) => void;
  setProgress: (progress: TransferProgress) => void;
  setMode: (mode: TransferMode | null) => void;
  setStage: (stage: ReceiverStage) => void;
  setStatus: (status: string) => void;
  setError: (error: string | null) => void;
  setRetriesRemaining: (retriesRemaining: number | null) => void;
  setReceivedFiles: (files: ReceivedFile[]) => void;
};

const MANIFEST_LOADED_STATUS = "Frozen Manifest 已载入。点击“接收全部文件”后才会开始传输。";

function applySessionStage(context: ReceiveSessionLoaderContext, session: SessionPublicView) {
  const stage = receiverStageFromSession(session);
  context.setStage(stage);
  context.setStatus(
    stage === "retry-exhausted"
      ? RETRY_EXHAUSTED_STATUS
      : stage === "reconnecting"
        ? RECONNECTING_STATUS
        : MANIFEST_LOADED_STATUS,
  );
}

async function progressForLoadedSession(sessionId: string, session: SessionPublicView) {
  const committedBytesByFileId = readCachedActiveReceiveProgress(sessionId, session.files);
  for (const file of await readCachedReceivedFiles(sessionId, session.files)) {
    committedBytesByFileId.set(file.id, file.size);
  }
  return progressFromCommitted(session, committedBytesByFileId);
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
      if (completed.originalReceiver) {
        context.setReceivedFiles(await readCachedReceivedFiles(sessionId, completed.session.files));
        context.setStage("completed");
        context.setStatus("Completed Session View：该接收方可查看短暂只读结果态。");
      } else {
        context.setReceivedFiles([]);
        context.setStage("completion-notice");
        context.setStatus("Completion Notice：该会话已完成；如需重新接收，请让发送方重新创建。");
      }
    } else if (
      nextSession.status === "claimed" ||
      nextSession.status === "connecting" ||
      nextSession.status === "reconnecting" ||
      nextSession.status === "transferring"
    ) {
      context.setSession(nextSession);
      context.setProgress(await progressForLoadedSession(sessionId, nextSession));
      context.setMode(nextSession.transferMode);
      if (!receiverToken || !(await validateReceiverToken(sessionId, receiverToken))) {
        context.setStage("occupied");
        context.setStatus("Occupied Session Notice：已有另一个接收方 claim 了该会话。");
        if (receiverToken) clearReceiverToken(sessionId);
      } else {
        if (typeof nextSession.retriesRemaining === "number") {
          context.setRetriesRemaining(nextSession.retriesRemaining);
        }
        applySessionStage(context, nextSession);
      }
    } else {
      context.setSession(nextSession);
      context.setProgress(await progressForLoadedSession(sessionId, nextSession));
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
