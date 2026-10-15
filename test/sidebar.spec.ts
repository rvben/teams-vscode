import { test, expect, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import type { SidebarState } from "../src/sidebar-model";

const state: SidebarState = {
  scope: "fixture",
  profile: "Personal demo",
  accountLabel: "Personal account",
  canSwitchProfile: true,
  backend: "desktop",
  layout: "teams",
  loading: false,
  ready: true,
  error: "",
  cached: true,
  hasMore: true,
  connection: "connected",
  selected: "1",
  chats: [
    {
      id: "1",
      title: "Morgan Reed",
      preview: "The Windows and WSL checks passed.",
      kind: "oneOnOne",
      unread: true,
      updated: new Date().toISOString(),
    },
    {
      id: "2",
      title: "Release planning",
      preview: "Alex: Can we ship the updated setup notes this afternoon?",
      kind: "group",
      updated: "2026-10-13T10:00:00Z",
    },
    {
      id: "3",
      title: "Design review",
      preview: "The next review is Thursday.",
      kind: "meeting",
      updated: "2026-10-12T10:00:00Z",
    },
    {
      id: "4",
      title: "Alex Chen",
      preview: "Thanks, I’ll take a look.",
      kind: "oneOnOne",
    },
  ],
};
async function render(page: Page, patch: Partial<SidebarState> = {}) {
  await page.evaluate(
    (s) => window.postMessage({ type: "sidebarState", state: s }, "*"),
    { ...state, ...patch },
  );
  await expect(page.locator(".account-row")).toBeVisible({
    visible: patch.canSwitchProfile ?? state.canSwitchProfile,
  });
}
test("sidebar layouts switch immediately and open rows with profile-bound IDs", async ({
  page,
}) => {
  await page.goto("/sidebar");
  await render(page);
  await expect(page.locator(".profile-button")).toHaveAttribute(
    "title",
    /Profile: Personal demo/,
  );
  await expect(page.locator(".provenance")).toHaveText(
    "From Teams on this computer",
  );
  for (const value of ["compact", "comfortable", "teams"]) {
    await render(page, { layout: value as SidebarState["layout"] });
    await expect(page.locator("#app")).toHaveAttribute("data-layout", value);
  }
  await page
    .getByRole("option")
    .filter({ hasText: "Release planning" })
    .click();
  const sent = await page.evaluate(() => (window as any).sent);
  expect(sent.find((m: any) => m.type === "open")).toEqual({
    type: "open",
    scope: "fixture",
    profile: "Personal demo",
    id: "2",
  });
  expect(sent.some((m: any) => m.type === "send")).toBe(false);
});
test("search, filters, keyboard navigation and pagination work together", async ({
  page,
}) => {
  await page.goto("/sidebar");
  await render(page);
  await page.getByRole("button", { name: /^Unread/ }).click();
  await expect(
    page.getByRole("listbox", { name: "Conversations" }).getByRole("option"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Groups", exact: true }).click();
  await expect(
    page.getByRole("listbox", { name: "Conversations" }).getByRole("option"),
  ).toHaveCount(2);
  await page.getByRole("searchbox").fill("not found");
  await expect(
    page.getByRole("heading", { name: "No matching chats" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load more conversations" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(
    page.getByRole("listbox", { name: "Conversations" }).getByRole("option"),
  ).toHaveCount(4);
  await page.getByRole("searchbox").press("ArrowDown");
  await expect(
    page
      .getByRole("listbox", { name: "Conversations" })
      .getByRole("option")
      .first(),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(
      () =>
        (window as any).sent.filter((m: any) => m.type === "open").at(-1).id,
    ),
  ).toBe("2");
  await page.getByRole("button", { name: "Load more conversations" }).click();
  expect(await page.evaluate(() => (window as any).sent.at(-1).type)).toBe(
    "more",
  );
});
test("sidebar treats names as text, rejects external avatars, recovers image failure and shows account recovery", async ({
  page,
}) => {
  await page.goto("/sidebar");
  await render(page, {
    chats: [
      {
        id: "a",
        title: "<script>window.hacked=true</script>",
        preview: "<img onerror=alert(1)>",
        kind: "group",
        avatar: "https://example.com/tracker.png",
      },
    ],
  });
  await expect(page.locator(".chat-row img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).hacked)).toBeUndefined();
  await render(page, {
    chats: [
      {
        ...state.chats[0]!,
        avatar:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhB8AAAAASUVORK5CYII=",
      },
    ],
  });
  await expect(page.locator(".chat-row img")).toBeVisible();
  expect(
    await page
      .locator(".chat-row img")
      .evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
  ).toBe(true);
  await render(page, {
    chats: [{ ...state.chats[0]!, avatar: "data:image/png;base64,YmFk" }],
  });
  await expect(page.locator(".initials")).toHaveText("MR");
  await expect(page.locator(".chat-row img")).toHaveCount(0);
  await render(page, {
    error: "More than one Teams account is available.",
    connection: "account",
  });
  await page.getByRole("button", { name: "Choose Teams account" }).click();
  expect(await page.evaluate(() => (window as any).sent.at(-1).type)).toBe(
    "selectAccount",
  );
  await render(page);
  await expect(page.locator(".sidebar-notice")).toBeHidden();
});
test("sidebar layouts adapt to narrow, light and high contrast themes — batched visual evidence", async ({
  page,
}) => {
  await mkdir(".impeccable/review", { recursive: true });
  for (const mode of [
    { layout: "teams", theme: "dark", width: 340 },
    { layout: "compact", theme: "dark", width: 340 },
    { layout: "comfortable", theme: "light", width: 340 },
    { layout: "teams", theme: "light", width: 220 },
  ] as const) {
    await page.setViewportSize({ width: mode.width, height: 760 });
    await page.goto("/sidebar?theme=" + mode.theme);
    await render(page, { layout: mode.layout });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: `.impeccable/review/sidebar-${mode.layout}-${mode.theme}-${mode.width}.png`,
    });
  }
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await expect(page.getByRole("searchbox")).toBeVisible();
});

test("single-account sidebar hides the chooser and restores it when another account becomes available", async ({
  page,
}) => {
  await page.goto("/sidebar");
  await render(page, { canSwitchProfile: false });
  await expect(
    page.getByRole("button", { name: "Personal account", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toBeVisible();
  await page.getByRole("searchbox").fill("Release");
  await render(page, { canSwitchProfile: true });
  const chooser = page.getByRole("button", {
    name: "Personal account",
    exact: true,
  });
  await chooser.click();
  expect(await page.evaluate(() => (window as any).sent.at(-1).type)).toBe(
    "profile",
  );
  await chooser.focus();
  await render(page, { canSwitchProfile: false });
  await expect(page.getByRole("searchbox")).toBeFocused();
  await expect(page.getByRole("searchbox")).toHaveValue("Release");
  await expect(
    page.getByRole("listbox", { name: "Conversations" }).getByRole("option"),
  ).toHaveCount(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await mkdir(".local-research/single-account", { recursive: true });
  await page.screenshot({
    path: ".local-research/single-account/sidebar-single.png",
  });
});

test("narrow sidebar gives search the full row without duplicating native title actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 260, height: 700 });
  await page.goto("/sidebar");
  await render(page, { canSwitchProfile: false });
  await expect(page.getByRole("button", { name: "New message" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Refresh conversations" }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  const search = page.getByRole("searchbox");
  const box = await search.boundingBox();
  expect(box!.width).toBeGreaterThan(200);
  await search.focus();
  await search.press("Tab");
  await expect(
    page.getByRole("button", { name: "All", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".impeccable/review/sidebar-toolbar-narrow.png",
  });
});
