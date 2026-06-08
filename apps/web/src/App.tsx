import { APP_NAME } from "@p2pfile/shared";
import { Link, Route, Routes } from "react-router-dom";
import { HomePage } from "./routes/HomePage";
import { ReceivePage } from "./routes/ReceivePage";

export function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <header className="border-b border-slate-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link className="text-lg font-semibold tracking-tight" to="/">
            {APP_NAME}
          </Link>
          <nav className="flex gap-4 text-sm text-slate-300">
            <Link className="hover:text-white" to="/">
              发送
            </Link>
            <Link className="hover:text-white" to="/receive">
              接收
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <Routes>
          <Route element={<HomePage />} path="/" />
          <Route element={<ReceivePage />} path="/receive" />
        </Routes>
      </main>
    </div>
  );
}
