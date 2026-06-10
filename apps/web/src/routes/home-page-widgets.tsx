export function FlowTimeline() {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h3 className="mb-4 font-bold text-lg">传输流程</h3>
      <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
        {[
          ["1", "选文件"],
          ["2", "发链接"],
          ["3", "接收"],
          ["4", "完成"],
        ].map(([step, title]) => (
          <div className="grid gap-2" key={step}>
            <span className="mx-auto grid size-11 place-items-center rounded-full border-2 border-teal-600 font-bold text-xl text-teal-700">
              {step}
            </span>
            <strong className="text-sm sm:text-base">{title}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
