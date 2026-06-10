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
    <div className="mx-auto grid w-full max-w-[1568px] gap-3 px-3 py-3 sm:px-4">
      <h1 className="rounded-xl border border-neutral-200 bg-white px-5 py-3 font-bold text-neutral-950 text-xl shadow-sm">
        浏览器直接传文件
      </h1>
      <div className="grid min-h-[calc(100vh-190px)] gap-3 xl:grid-cols-[1fr_1fr_0.94fr]">
        <section className="grid min-w-0 content-start gap-3">
          <SenderPanel sender={sender} />
          <ModeDisclosure mode={sender.mode} status={sender.status} />
          <div data-testid="current-file-progress">
            <ProgressPanel progress={sender.progress} speed={sender.speed} />
          </div>
          <div data-testid="overall-progress">
            <OverallProgressPanel progress={sender.progress} />
          </div>
          {sender.stage === "completed" ? <CompletedSenderView /> : null}
          {sender.stage === "ended" ? <EndedSenderView /> : null}
        </section>

        <section className="grid min-w-0 content-start gap-3">
          {displayedManifest.length > 0 ? (
            <div className="min-w-0" data-testid="frozen-manifest">
              <ManifestPanel
                caption="接收方 claim 前看到同一 metadata-only preview。"
                files={displayedManifest}
                title="Frozen Manifest"
                totalBytes={displayedTotalBytes}
              />
            </div>
          ) : (
            <EmptyHint
              title="Frozen Manifest"
              body="选择文件后这里会展示 metadata-only 文件清单；接收方 claim 前看不到文件内容。"
            />
          )}
          <FlowTimeline />
        </section>

        <section className="grid min-w-0 content-start gap-3">
          {sender.shareState ? (
            <ShareSurfaces sender={sender.shareState} progress={sender.progress} />
          ) : (
            <SharePlaceholder />
          )}
        </section>
      </div>
    </div>
  );
}
