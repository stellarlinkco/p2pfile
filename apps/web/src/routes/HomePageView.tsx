import { EmptyHint, ManifestPanel, ModeDisclosure, ProgressPanel } from "../components/session-ui";
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
  return (
    <div className="mx-auto grid max-w-[1568px] gap-3 px-4 py-3">
      <h1 className="rounded-xl border border-neutral-200 bg-white px-5 py-3 font-bold text-neutral-950 text-xl shadow-sm">
        浏览器直接传文件
      </h1>
      <div className="grid min-h-[calc(100vh-190px)] gap-3 xl:grid-cols-[1fr_1fr_0.94fr]">
        <section className="grid content-start gap-3">
          <SenderPanel sender={sender} />
          <ModeDisclosure mode={sender.mode} status={sender.status} />
          <div data-testid="current-file-progress">
            <ProgressPanel progress={sender.progress} speed={sender.speed} />
          </div>
          <div data-testid="overall-progress" className="hidden" />
          {sender.stage === "completed" ? <CompletedSenderView /> : null}
          {sender.stage === "ended" ? <EndedSenderView /> : null}
        </section>

        <section className="grid content-start gap-3">
          {sender.manifest.length > 0 ? (
            <div data-testid="frozen-manifest">
              <ManifestPanel
                caption="接收方 claim 前看到同一 metadata-only preview。"
                files={sender.manifest}
                title="Frozen Manifest"
                totalBytes={sender.totalBytes}
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

        <section className="grid content-start gap-3">
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
