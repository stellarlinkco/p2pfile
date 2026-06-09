import { ReceivePageView } from "./ReceivePageView";
import { useReceiveFlow } from "./receive-flow";

export function ReceivePage() {
  return <ReceivePageView flow={useReceiveFlow()} />;
}
