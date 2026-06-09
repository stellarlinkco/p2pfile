import { APP_NAME } from "@p2pfile/shared";
import { Link, Route, Routes } from "react-router-dom";
import { HomePage } from "./routes/HomePage";
import { ReceivePage } from "./routes/ReceivePage";

export function App() {
  return (
    <div className="min-h-screen text-neutral-950">
      <header className="sticky top-0 z-20 border-neutral-200 border-b bg-white/88 shadow-sm backdrop-blur-2xl">
        <div className="mx-auto grid max-w-[1568px] grid-cols-[auto_1fr_auto] items-center gap-5 px-7 py-4">
          <Link className="flex items-center gap-3" to="/">
            <span className="grid size-10 place-items-center rounded-xl bg-teal-700 font-bold text-white shadow-sm">
              P2P
            </span>
            <span className="font-bold text-2xl tracking-tight">{APP_NAME}</span>
          </Link>

          <p className="text-neutral-600 text-sm">
            浏览器直传文件；Share Link / Access Code 用于进入同一个 Temporary Session Window。
          </p>

          <nav className="flex items-center gap-2 text-sm">
            <Link className="rounded-xl px-3 py-2 transition hover:bg-neutral-100" to="/">
              发送
            </Link>
            <Link className="rounded-xl px-3 py-2 transition hover:bg-neutral-100" to="/receive">
              接收
            </Link>
          </nav>
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
