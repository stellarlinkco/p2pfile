export function ReceivePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-14">
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-slate-950/40">
        <h1 className="text-2xl font-semibold tracking-tight">接收文件</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          第一版默认以 Share Link 为主入口，Access Code
          为备用入口。这里先保留接收页骨架，后续接入会话解析、Frozen Manifest、claim 与传输状态。
        </p>
      </div>
    </div>
  );
}
