import { APP_NAME } from "@p2pfile/shared";
import { Link, Route, Routes } from "react-router-dom";
import { HomePage } from "./routes/HomePage";
import { ReceivePage } from "./routes/ReceivePage";

export function App() {
  return (
    <div className="min-h-screen text-neutral-950">
      <header className="sticky top-0 z-20 border-neutral-200 border-b bg-white/88 shadow-sm backdrop-blur-2xl">
        <div className="mx-auto flex max-w-[1568px] items-center justify-between gap-3 px-3 py-3 sm:px-4">
          <Link className="flex min-w-0 items-center gap-3" to="/">
            <span className="grid size-9 place-items-center rounded-xl bg-teal-700 font-bold text-white shadow-sm sm:size-10">
              P2P
            </span>
            <span className="font-bold text-xl tracking-tight sm:text-2xl">{APP_NAME}</span>
          </Link>

          <nav className="flex items-center gap-1 text-sm sm:gap-2">
            <Link className="rounded-xl px-3 py-2 transition hover:bg-neutral-100" to="/">
              发送
            </Link>
            <Link className="rounded-xl px-3 py-2 transition hover:bg-neutral-100" to="/receive">
              接收
            </Link>
          </nav>
        </div>
        <div className="mx-auto hidden max-w-[1568px] px-4 pb-3 text-neutral-500 text-sm md:block">
          浏览器直传文件；链接、访问码和二维码都指向同一个会话入口。
        </div>
      </header>

      <main aria-label="app-shell">
        <Routes>
          <Route element={<HomePage />} path="/" />
          <Route element={<ReceivePage />} path="/receive" />
          <Route element={<ReceivePage />} path="/f/:sessionId" />
        </Routes>
      </main>
    </div>
  );
}
