import { websocket } from "hono/bun";
import { createApp } from "./app";

const runtime = createApp();

export const app = runtime.app;
export const store = runtime.store;

export default {
  port: 3001,
  fetch: app.fetch,
  websocket,
};
