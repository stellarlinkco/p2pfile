export function HomePage() {
  return (
    <div className="mx-auto grid min-h-[calc(100vh-73px)] max-w-6xl gap-10 px-6 py-14 lg:grid-cols-[1.2fr_0.8fr]">
      <section className="space-y-6">
        <span className="inline-flex rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-sm text-cyan-200">
          无需先上传到云端
        </span>
        <div className="space-y-4">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            浏览器直接传文件
          </h1>
          <p className="max-w-2xl text-base leading-7 text-slate-300 sm:text-lg">
            默认点对点直传；复杂网络下自动切换中继，并明确告诉用户当前传输模式。
          </p>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-slate-950/40">
          <h2 className="text-xl font-semibold">发送文件</h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            创建一个短时会话，冻结文件清单，然后分享 Share Link、Access Code 或 QR Code。
          </p>
          <button
            className="mt-6 inline-flex rounded-xl bg-cyan-400 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-300"
            type="button"
          >
            创建会话
          </button>
        </article>

        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-slate-950/40">
          <h2 className="text-xl font-semibold">接收文件</h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            粘贴 Share Link 或输入 Access Code，查看 Frozen Manifest 后整体接收。
          </p>
          <a
            className="mt-6 inline-flex rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-white transition hover:border-slate-500"
            href="/receive"
          >
            打开接收页
          </a>
        </article>
      </section>
    </div>
  );
}
