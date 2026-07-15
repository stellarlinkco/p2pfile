import { APP_NAME } from "@p2pfile/shared";
import { Link, Route, Routes } from "react-router-dom";
import { HomePage } from "./routes/HomePage";
import { ReceivePage } from "./routes/ReceivePage";

export function App() {
  return (
    <div className="min-h-screen text-neutral-950">
      <header className="sticky top-0 z-20 border-neutral-200 border-b bg-white/92 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-3 px-3 py-3 sm:px-5">
          <Link className="flex min-w-0 items-center gap-2" to="/">
            <span className="grid size-9 place-items-center rounded-lg bg-teal-700 font-bold text-sm text-white">
              P2P
            </span>
            <span className="font-bold text-lg tracking-tight">{APP_NAME}</span>
          </Link>

          <nav aria-label="文件传输" className="flex items-center gap-1 text-sm">
            <Link
              className="min-h-11 rounded-lg px-3 py-2 font-medium transition-colors hover:bg-neutral-100 active:scale-[0.96]"
              to="/"
            >
              发送
            </Link>
            <Link
              className="min-h-11 rounded-lg px-3 py-2 font-medium transition-colors hover:bg-neutral-100 active:scale-[0.96]"
              to="/receive"
            >
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
