import { expect, test } from "@playwright/test";

// The desktop bridge supplies the live directory in production. Exercise the same commands
// in browser CI without opening the developer's files or default browser.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const names = ["AI Engineer", "a16z", ...Array.from({ length: 48 }, (_, i) => "Channel " + i)];
    const channels = names.map((name, i) => ({
      id: name, name, documents: [{
        id: "file-" + i, title: name + " report", path: "Channel/" + name + "/report.html",
        channel: name, modified: "2026-11-25", date: "2026.11.25",
      }],
    }));
    Object.assign(window, {
      testChannels: channels,
      __TAURI__: {
        core: { invoke: async (command: string, args?: {path: string}) => {
          if (command === "list_local_reports") return structuredClone(channels);
          if (command === "open_local_report") document.body.dataset.openedReport = args?.path;
        } },
        event: { listen: async (_name: string, callback: EventListener) => {
          window.addEventListener("test-files-changed", callback);
          return () => window.removeEventListener("test-files-changed", callback);
        } },
      },
    });
  });
});

test("YouTube opens the channel library and preserves reading selections", async ({page}) => {
  await page.goto("/");
  await page.getByTestId("nav-youtube").click();
  const feed = page.locator(".youtube-feed");
  const list = feed.locator("#documents li");
  await expect(list.first()).toBeVisible();
  const frame = page.locator(".youtube-feed");
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 850 });
    await expect.poll(() => frame.evaluate(node => {
      const pane = node.getBoundingClientRect();
      const shell = node.parentElement!.getBoundingClientRect();
      return Math.max(Math.abs(shell.right - pane.right), Math.abs(shell.bottom - pane.bottom));
    })).toBeLessThanOrEqual(1);
    await expect(list.first()).toBeInViewport();
  }
  const filters = feed.getByRole("navigation", {name:"阅读状态"});
  await expect(filters.getByRole("button")).toHaveText(["未读", "已读", "精选"]);
  await expect(filters.locator('[aria-current="page"]')).toHaveText("未读");
  const title = await list.first().locator(".title").textContent();
  await list.first().getByRole("button", {name:"精选"}).click();
  await feed.getByRole("navigation").getByText("精选").click();
  await expect(list).toHaveCount(1);
  await expect(list.first().locator(".title")).toHaveText(title!);
  await list.first().getByRole("button", {name: title!}).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened-report", /^Channel\//);
  await page.goto("/?module=youtube");
  await feed.getByRole("navigation").getByText("精选").click();
  await expect(list.first().locator(".title")).toHaveText(title!);
});

test("global sidebar browses channels before navigating", async ({page}) => {
  await page.goto("/");
  await page.getByTestId("nav-curriculum").click();
  const sidebar = page.locator(".sidebar");
  await sidebar.dispatchEvent("wheel", {deltaX: 80, deltaY: 1});
  const channel = sidebar.getByRole("button", {name: /^AI Engineer/});
  await expect(channel).toBeVisible();
  await expect(page.locator(".youtube-feed")).toHaveCount(0);
  await channel.click();
  const feed = page.locator(".youtube-feed");
  await expect(feed.locator("#channel-name")).toHaveText("AI Engineer");
  await expect(feed.locator("aside")).toBeHidden();
  await expect(feed.locator("#documents li").first()).toBeVisible();
  await sidebar.getByRole("button", {name: /^a16z/}).click();
  await expect(feed.locator("#channel-name")).toHaveText("a16z");
  // Reverse in the same event burst, including same-direction inertia.
  await sidebar.evaluate(node => {
    for (const deltaX of [80, 8, 3, -20, -25]) {
      node.dispatchEvent(new WheelEvent("wheel", {deltaX, cancelable:true}));
    }
  });
  await expect(page.getByTestId("nav-youtube")).toBeVisible();
  await sidebar.dispatchEvent("wheel", {deltaX: 80});
  const scroll = sidebar.locator(".channel-directory-list");
  await expect(scroll).toHaveCSS("scrollbar-width", "none");
  await expect.poll(() => scroll.evaluate(node => {
    node.scrollTop = 100;
    return node.scrollTop;
  })).toBeGreaterThan(0);
  await sidebar.dispatchEvent("wheel", {deltaX: -80});
  await expect(page.getByTestId("nav-youtube")).toBeVisible();
  await expect(feed.locator("#channel-name")).toHaveText("a16z");
});

test("a running reader follows updates and preserves selections across renames and rewrites", async ({ page }) => {
  await page.goto("/");
  const row = page.locator("#documents li").filter({ hasText: "AI Engineer report" });
  await row.getByRole("button", { name: "精选" }).click();
  await page.getByRole("navigation", { name: "阅读状态" }).getByText("精选").click();
  await page.evaluate(() => {
    const channels = (window as any).testChannels;
    const doc = channels[0].documents.pop();
    Object.assign(doc, { title: "Updated title", channel: "a16z", path: "Channel/a16z/moved.html" });
    channels[1].documents.push(doc);
    window.dispatchEvent(new Event("test-files-changed"));
  });
  const moved = page.locator("#documents li").filter({ hasText: "Updated title" });
  await expect(moved.getByRole("button", { name: "精选" })).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    (window as any).testChannels[1].documents[1].id = "replacement-file";
    window.dispatchEvent(new Event("test-files-changed"));
  });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("reading-report-featured")!)))
    .toEqual(["replacement-file"]);
  await page.evaluate(() => {
    (window as any).testChannels[1].documents.pop();
    window.dispatchEvent(new Event("test-files-changed"));
  });
  await expect(moved).toHaveCount(0);
});
