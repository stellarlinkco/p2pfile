import {
  EmptyHint,
  ManifestPanel,
  ModeDisclosure,
  OverallProgressPanel,
  ProgressPanel,
} from "../components/session-ui";
import type { SenderFlowState } from "./home-flow";
import {
  CompletedSenderView,
  EndedSenderView,
  SenderPanel,
  SharePlaceholder,
  ShareSurfaces,
} from "./home-page-panels";
import { FlowTimeline } from "./home-page-widgets";

type HomePageViewProps = { sender: SenderFlowState };

export function HomePageView({ sender }: HomePageViewProps) {
  const displayedManifest = sender.shareState?.session.files ?? sender.manifest;
  const displayedTotalBytes = sender.shareState?.session.totalBytes ?? sender.totalBytes;
  return (
    <div className="mx-auto grid w-full max-w-[1180px] gap-4 px-3 py-4 sm:px-5 sm:py-6 lg:grid-cols-[minmax(0,0.92fr)_minmax(360px,1.08fr)]">
      <section className="grid min-w-0 content-start gap-3">
        <SenderPanel sender={sender} />
        <div data-testid="current-file-progress">
          <ProgressPanel progress={sender.progress} speed={sender.speed} />
        </div>
        {sender.shareState ? (
          <ShareSurfaces sender={sender.shareState} progress={sender.progress} />
        ) : (
          <SharePlaceholder />
        )}
        <div className="lg:hidden">
          <ModeDisclosure
            mode={sender.mode}
            diagnostics={sender.transportDiagnostics}
            testId={null}
          />
        </div>
        {sender.stage === "completed" ? <CompletedSenderView /> : null}
        {sender.stage === "ended" ? <EndedSenderView /> : null}
      </section>

      <section className="grid min-w-0 content-start gap-3">
        {displayedManifest.length > 0 ? (
          <div className="min-w-0" data-testid="frozen-manifest">
            <ManifestPanel
              caption="接收前只显示文件名和大小。"
              fileProgress={sender.progress.files}
              files={displayedManifest}
              title="文件清单"
              totalBytes={displayedTotalBytes}
            />
          </div>
        ) : (
          <EmptyHint title="文件清单" body="选择文件后，这里会显示接收方可见的清单。" />
        )}
        <div className="hidden lg:block">
          <ModeDisclosure mode={sender.mode} diagnostics={sender.transportDiagnostics} />
        </div>
        <div data-testid="overall-progress">
          <OverallProgressPanel progress={sender.progress} />
        </div>
        <div className="hidden lg:block">
          <FlowTimeline />
        </div>
      </section>
    </div>
  );
}
