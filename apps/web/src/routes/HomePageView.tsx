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
      <div className="px-1 py-1">
        <h1 className="font-bold text-lg text-neutral-950 tracking-tight sm:text-xl">
          浏览器直接传文件
        </h1>
        <p className="mt-1 text-neutral-500 text-sm">选中文件后创建会话，再分享链接或访问码。</p>
      </div>
      <div className="grid min-h-[calc(100vh-190px)] gap-3 xl:grid-cols-[1fr_1fr_0.94fr]">
        <section className="grid min-w-0 grid-cols-1 content-start gap-3">
          <SenderPanel sender={sender} />
          <ModeDisclosure mode={sender.mode} />
          <div data-testid="current-file-progress">
            <ProgressPanel progress={sender.progress} speed={sender.speed} />
          </div>
          <div data-testid="overall-progress">
            <OverallProgressPanel progress={sender.progress} />
          </div>
          {sender.stage === "completed" ? <CompletedSenderView /> : null}
          {sender.stage === "ended" ? <EndedSenderView /> : null}
        </section>

        <section className="grid min-w-0 grid-cols-1 content-start gap-3">
          {displayedManifest.length > 0 ? (
            <div className="min-w-0" data-testid="frozen-manifest">
              <ManifestPanel
                caption="接收前只显示文件名和大小。"
                files={displayedManifest}
                title="文件清单"
                totalBytes={displayedTotalBytes}
              />
            </div>
          ) : (
            <EmptyHint title="文件清单" body="选择文件后，这里会显示接收方可见的清单。" />
          )}
          <div className="hidden sm:block">
            <FlowTimeline />
          </div>
        </section>

        <section className="grid min-w-0 grid-cols-1 content-start gap-3">
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
