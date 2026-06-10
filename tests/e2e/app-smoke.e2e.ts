import { expect, test } from "@playwright/test";

test("home page renders sender and receiver entry points", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /浏览器直接传文件/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /发送文件/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "接收页", exact: true })).toBeVisible();
});
