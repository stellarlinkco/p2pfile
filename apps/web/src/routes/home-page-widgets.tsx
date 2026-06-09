export function FlowTimeline() {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h3 className="mb-5 font-bold text-xl">传输流程</h3>
      <div className="grid grid-cols-4 gap-3 text-center">
        {[
          ["1", "Select", "freeze manifest\n冻结文件并冻结清单"],
          ["2", "Share", "Share Link / Access Code / QR Code\n分享链接或访问码"],
          ["3", "Claim", "receiver claims exclusive session\n接收方申请独占会话"],
          ["4", "Complete", "read-only completed view\n只读完成视图"],
        ].map(([step, title, body]) => (
          <div className="grid gap-2" key={step}>
            <span className="mx-auto grid size-12 place-items-center rounded-full border-2 border-teal-600 font-bold text-2xl text-teal-700">
              {step}
            </span>
            <strong>{title}</strong>
            <span className="whitespace-pre-line text-neutral-600 text-sm leading-5">{body}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
