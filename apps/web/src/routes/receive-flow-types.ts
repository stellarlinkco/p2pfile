import type { TransferMode } from "@p2pfile/shared";
import type { SessionPublicView } from "../lib/api";
import type { ReceivedFile, TransferProgress } from "../lib/transfer";
import type { ReceiverStage } from "./receive-flow-utils";

export type ReceiveFlowState = {
  claimCurrentSession: () => Promise<void>;
  entryValue: string;
  error: string | null;
  mode: TransferMode | null;
  openEntry: () => Promise<void>;
  progress: TransferProgress;
  receivedFiles: ReceivedFile[];
  releaseCurrentClaim: () => Promise<void>;
  retriesRemaining: number | null;
  session: SessionPublicView | null;
  setEntryValue: (value: string) => void;
  speed: number | null;
  stage: ReceiverStage;
  status: string;
};
