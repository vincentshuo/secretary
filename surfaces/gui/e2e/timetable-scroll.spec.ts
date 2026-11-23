import { expect, test } from "@playwright/test";

test("scrolls the timetable to the last evening period inside the window", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-17T04:00:00Z"));
  await page.goto("/?module=curriculum");
  const board = page.locator(".curriculum-scroll");
  const evening = page.getByRole("button", { name: /可持续旅游与数字创新/ });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 600 }]) {
    await page.setViewportSize(viewport);
    await board.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(page.locator(".curriculum-axis-period").last()).toBeInViewport({ ratio: 1 });
    await evening.scrollIntoViewIfNeeded();
    await expect(evening).toBeInViewport({ ratio: 1 });
    await evening.click();
    await expect(page.getByRole("dialog")).toContainText("20:55");
    await page.keyboard.press("Escape");
  }
});
