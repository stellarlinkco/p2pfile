import { websocket } from "hono/bun";
import { createApp } from "./app";

const runtime = createApp({ redisUrl: process.env.REDIS_URL });

export const app = runtime.app;
export const store = runtime.store;

export default {
  port: 3001,
  fetch: app.fetch,
  websocket,
};
