import { json, notFound } from "./responses";
import type { SessionDirectoryRegisterPayload } from "./session-record";

export class SessionDirectory implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/register") {
      const payload = (await request.json()) as SessionDirectoryRegisterPayload;
      const existing = await this.state.storage.get<string>(payload.accessCode);
      if (existing) return json({ message: "access code exists" }, { status: 409 });
      await this.state.storage.put(payload.accessCode, payload.sessionId);
      return json({ ok: true });
    }

    const resolveMatch = url.pathname.match(/^\/resolve\/([^/]+)$/);
    if (request.method === "GET" && resolveMatch) {
      const sessionId = await this.state.storage.get<string>(resolveMatch[1] ?? "");
      if (!sessionId) return notFound("session not found");
      return json({ sessionId });
    }

    const deleteMatch = url.pathname.match(/^\/delete\/([^/]+)$/);
    if (request.method === "POST" && deleteMatch) {
      await this.state.storage.delete(deleteMatch[1] ?? "");
      return json({ ok: true });
    }

    return notFound("directory route not found");
  }
}
