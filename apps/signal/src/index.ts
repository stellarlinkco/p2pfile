import { APP_NAME, AppStatusSchema } from "@p2pfile/shared";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";

export const app = new Hono();

app.get("/api/status", (c) => {
  return c.json(
    AppStatusSchema.parse({
      ok: true,
      service: "signal",
      product: APP_NAME,
    }),
  );
});

app.get(
  "/ws",
  upgradeWebSocket(() => {
    return {
      onMessage(_event, ws) {
        ws.send("ack");
      },
    };
  }),
);

export default {
  port: 3001,
  fetch: app.fetch,
  websocket,
};
