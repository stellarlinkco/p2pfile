import { expect, test } from "bun:test";
import { app } from "./index";

test("status endpoint returns ok", async () => {
  const response = await app.request("http://localhost/api/status");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toEqual({
    ok: true,
    service: "signal",
    product: "P2P File",
  });
});
