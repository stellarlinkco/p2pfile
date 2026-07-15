import { expect, test } from "@playwright/test";

test("home page renders focused send and receive entry points", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "创建传输" })).toBeVisible();
  await expect(page.getByRole("link", { name: "接收文件", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "文件传输" })).toBeVisible();
});

test("send and receive screens remain width-safe at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "创建传输" })).toBeVisible();
  await expect(page.getByTestId("create-session-button")).toBeVisible();
  await expect(page.getByTestId("session-status")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  await page.goto("/receive");
  await expect(page.getByRole("heading", { name: "打开传输" })).toBeVisible();
  await expect(page.getByTestId("receiver-entry-input")).toBeVisible();
  await expect(page.getByTestId("receiver-open-session-button")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});
