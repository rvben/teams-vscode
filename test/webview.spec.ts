import { test, expect, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import type { ViewState } from "../src/protocol";

const photo =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhB8AAAAASUVORK5CYII=";

const state: ViewState = {
  scope: "fixture",
  title: "Release planning · Synthetic demo",
  profile: "Personal demo",
  accountLabel: "Personal account",
  backend: "desktop",
  cached: true,
  readOnly: false,
  repliesEnabled: true,
  messages: [
    {
      id: "1",
      sender: "Morgan (sample)",
      senderId: "user:morgan",
      text: "The Windows and WSL checks are complete. Reading, sending, and readback all passed.",
      time: "2026-10-14T09:12:00Z",
      clientId: "",
      delivery: "",
    },
    {
      id: "2",
      sender: "Alex (sample)",
      senderId: "user:alex",
      text: "Great. I’ll check the macOS package this afternoon.\n\nCan we keep the connection instructions next to the download?",
      time: "2026-10-14T09:14:00Z",
      clientId: "",
      delivery: "",
    },
    {
      id: "3",
      sender: "Morgan (sample)",
      senderId: "user:morgan",
      text: "Yes — include the read-only default and how to disconnect.\n\nA submitted message is different from confirmed delivery.",
      time: "2026-10-14T09:16:00Z",
      clientId: "",
      delivery: "",
    },
    {
      id: "4",
      sender: "Morgan (sample)",
      senderId: "user:morgan",
      text: "I’ll keep that distinction clear.",
      time: "2026-10-14T09:17:00Z",
      clientId: "",
      delivery: "",
    },
  ],
  cursor: "older",
  draft: "I’ll update the setup notes and check the package.",
  busy: false,
  sending: false,
  error: "",
  note: "",
  updated: "2026-10-14T09:17:00Z",
  pending: false,
  canCheck: false,
  sendOnEnter: false,
};
async function render(page: Page, patch: Partial<ViewState> = {}) {
  await page.evaluate(
    (s) => window.postMessage({ type: "state", state: s }, "*"),
    { ...state, ...patch },
  );
  await expect(page.locator("h1")).toContainText("Release planning");
}
test("conversation photos load in header and sender groups with Teams-aligned captions and bubbles", async ({
  page,
}) => {
  await page.goto("/");
  await render(page, {
    avatar: photo,
    memberAvatars: [{ senderId: "user:morgan", avatar: photo }],
  });
  await expect(page.locator(".conversation-avatar img")).toHaveCount(1);
  await expect(page.locator(".message-avatar img")).toHaveCount(2);
  await expect(page.locator(".message.continued .person-avatar")).toHaveCount(
    0,
  );
  for (const image of await page.locator(".person-avatar img").all())
    await expect
      .poll(() => image.evaluate((e: HTMLImageElement) => e.naturalWidth))
      .toBeGreaterThan(0);
  const positions = await page
    .locator(".message")
    .first()
    .evaluate((e) => {
      const bounds = (selector: string) =>
        e.querySelector(selector)!.getBoundingClientRect().toJSON();
      return {
        avatar: bounds(".message-avatar"),
        caption: bounds(".message-meta"),
        bubble: bounds(".message-text"),
      };
    });
  expect(Math.abs(positions.caption.x - positions.bubble.x)).toBeLessThan(1);
  expect(positions.caption.bottom).toBeLessThanOrEqual(positions.bubble.y);
  expect(Math.abs(positions.avatar.y - positions.bubble.y)).toBeLessThanOrEqual(
    2,
  );
  expect(positions.avatar.right).toBeLessThan(positions.bubble.x);
  await page.locator("textarea").fill("Keep this photo-refresh draft.");
  await render(page, {
    avatar: photo,
    draft: "Keep this photo-refresh draft.",
    memberAvatars: [
      { senderId: "user:morgan", avatar: photo },
      { senderId: "user:alex", avatar: photo },
    ],
  });
  await expect(page.locator(".message-avatar img")).toHaveCount(3);
  await expect(page.locator("textarea")).toHaveValue(
    "Keep this photo-refresh draft.",
  );
});
test("conversation photos reject remote and SVG URLs and recover from image failures", async ({
  page,
}) => {
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://"))
      remoteRequests.push(request.url());
  });
  await page.goto("/");
  await render(page, {
    avatar: "https://example.test/photo",
    memberAvatars: [
      { senderId: "user:morgan", avatar: "data:image/svg+xml;base64,PHN2Zz4=" },
      { senderId: "user:alex", avatar: "data:image/png;base64,YmFk" },
    ],
    messages: [
      { ...state.messages[0]!, avatar: "data:image/svg+xml;base64,PHN2Zz4=" },
      { ...state.messages[1]!, avatar: "data:image/png;base64,YmFk" },
    ],
  });
  await expect(page.locator(".person-avatar img")).toHaveCount(0);
  await expect(
    page.locator(".conversation-avatar .avatar-initials"),
  ).toHaveText("RP");
  await expect(
    page.locator(".message-avatar .avatar-initials").first(),
  ).toHaveText("MS");
  expect(remoteRequests).toEqual([]);
});
test("message hierarchy groups known senders while keeping every timestamp and draft intact", async ({
  page,
}) => {
  await page.goto("/");
  const first = state.messages[0]!;
  await render(page, {
    messages: [
      first,
      {
        ...first,
        id: "nearby",
        text: "A short follow-up.",
        time: "2026-10-14T09:13:00Z",
      },
      {
        ...first,
        id: "namesake",
        senderId: "user:someone-else",
        time: "2026-10-14T09:14:00Z",
      },
      { ...first, id: "later", time: "2026-10-14T10:00:00Z" },
      { ...first, id: "unknown", senderId: undefined, time: "invalid" },
    ],
  });
  await expect(page.locator(".message")).toHaveCount(5);
  await expect(page.locator(".message.continued")).toHaveCount(1);
  expect(
    await page
      .locator(".message-text")
      .first()
      .evaluate(
        (e) =>
          getComputedStyle(e).backgroundColor !==
          getComputedStyle(document.documentElement).backgroundColor,
      ),
  ).toBe(true);
  await expect(page.locator(".message-avatar")).toHaveCount(4);
  await expect(page.locator(".message.continued .sender")).toHaveCount(0);
  await expect(page.locator(".message time")).toHaveCount(5);
  for (const time of await page.locator(".message time").all()) {
    await expect(time).toBeVisible();
    await expect(time).toHaveAttribute("aria-label", /2026|Time unavailable/);
  }
  await expect(page.locator(".message").last()).toContainText(
    "Time unavailable",
  );
  await page.locator("textarea").fill("Keep this unsent draft.");
  await render(page, { busy: true, draft: "Keep this unsent draft." });
  await expect(page.locator("textarea")).toHaveValue("Keep this unsent draft.");
  expect(
    await page.evaluate(() =>
      (window as any).sent.some((m: any) => m.type === "send"),
    ),
  ).toBe(false);
});
test("conversation icon actions stay labeled, keyboard accessible and stable while refreshing", async ({
  page,
}) => {
  await page.goto("/");
  await render(page);
  const actions = page.getByRole("group", { name: "Conversation actions" });
  const refresh = actions.getByRole("button", { name: "Refresh messages" });
  const open = actions.getByRole("button", { name: "Open Teams in browser" });
  await expect(refresh).toHaveAttribute(
    "title",
    /Refresh messages\nLast checked/,
  );
  await expect(open).toHaveAttribute("title", "Open Teams in browser");
  await expect(actions.locator("button svg")).toHaveCount(2);
  await expect(actions).toHaveText("");
  await refresh.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(open).toBeFocused();
  await page.keyboard.press("Space");
  expect(
    await page.evaluate(() =>
      (window as any).sent.filter((m: any) =>
        ["refresh", "openTeams"].includes(m.type),
      ),
    ),
  ).toEqual([
    { type: "refresh", scope: "fixture" },
    { type: "openTeams", scope: "fixture" },
  ]);
  const width = (await actions.boundingBox())!.width;
  await render(page, { busy: true });
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh.locator("svg")).toHaveCount(1);
  expect((await actions.boundingBox())!.width).toBe(width);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await refresh
      .locator("svg")
      .evaluate((e) => getComputedStyle(e).animationName),
  ).toBe("none");
  await page.emulateMedia({ forcedColors: "active" });
  await expect(open).toBeVisible();
});
test("account details disclose profile, history limits and a dated check without header jargon", async ({
  page,
}) => {
  await page.goto("/");
  await render(page);
  await expect(page.locator(".account-summary")).toHaveText("Personal account");
  await expect(page.locator(".account-panel")).toBeHidden();
  await expect(page.locator(".header")).not.toContainText("Desktop cache");
  await expect(
    page.getByRole("button", { name: "Refresh messages" }),
  ).toHaveAttribute("title", /Last checked.*2026/);
  const status = await page.locator(".history-status").boundingBox();
  expect(status!.height).toBeLessThanOrEqual(1);
  await expect(
    page.getByRole("region", { name: "Message history" }),
  ).toHaveAttribute("aria-describedby", "history-status");
  const summary = page.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("region", {
    name: "Account and history details",
  });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Personal demo");
  await expect(panel).toContainText("Messages fromTeams on this computer");
  await expect(panel).toContainText("Earlier messages may be missing.");
  await expect(panel).not.toContainText("Invalid Date");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Show connection details" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).sent.at(-1))).toEqual({
    type: "connection",
    scope: "fixture",
  });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Space");
  await expect(panel).toBeVisible();
  await page.locator("h1").click();
  await expect(panel).toBeHidden();
  await render(page, {
    backend: "graph",
    cached: false,
    updated: "invalid",
    accountLabel: "Work or school",
  });
  await expect(summary).toHaveText("Work or school");
  await summary.click();
  await expect(panel).toContainText("Microsoft 365");
  await expect(panel).toContainText("Not checked yet");
  await expect(panel).not.toContainText("Earlier messages may be missing");
  await expect(
    page.getByRole("button", { name: "Refresh messages" }),
  ).toHaveAttribute("title", "Refresh messages");
});
test("cache limit stays at the history boundary and account names remain inert", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await render(page, {
    cursor: "",
    profile: "<script>window.hacked=true</script>".repeat(4),
    readOnly: true,
  });
  await expect(page.locator(".history-limit")).toBeVisible();
  await expect(page.locator(".read-only-label")).toBeVisible();
  await page.locator("summary").click();
  await expect(page.locator(".account-panel")).toContainText("<script>");
  expect(await page.evaluate(() => (window as any).hacked)).toBeUndefined();
  const box = (await page.locator(".account-panel").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(".account-panel")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Refresh messages" }),
  ).toBeFocused();
  await render(page, { cursor: "more" });
  await expect(page.locator(".history-limit")).toBeHidden();
  await render(page, { cursor: "", messages: [] });
  await expect(page.locator(".history-limit")).toBeHidden();
  await render(page, { cursor: "", cached: false });
  await expect(page.locator(".history-limit")).toBeHidden();
});
test("multiline composer sends only deliberately and suppresses double submission", async ({
  page,
}) => {
  await page.goto("/");
  await render(page, { draft: "" });
  await page.locator("textarea").fill("Line one");
  await page.locator("textarea").press("Enter");
  await page.locator("textarea").type("Line two");
  expect(await page.locator("textarea").inputValue()).toBe(
    "Line one\nLine two",
  );
  expect(
    await page.evaluate(
      () => (window as any).sent.filter((m: any) => m.type === "send").length,
    ),
  ).toBe(0);
  await page.locator("textarea").press("Control+Enter");
  await page.locator("textarea").press("Control+Enter");
  expect(
    await page.evaluate(
      () => (window as any).sent.filter((m: any) => m.type === "send").length,
    ),
  ).toBe(1);
});
test("hostile message markup stays inert; read-only and pending states block sends", async ({
  page,
}) => {
  await page.goto("/");
  await render(page, {
    messages: [
      {
        ...state.messages[0]!,
        text: '<img src=x onerror="window.hacked=true"> <script>window.hacked=true</script>',
      },
    ],
  });
  await expect(page.locator(".message-text")).toContainText("<img");
  expect(await page.evaluate(() => (window as any).hacked)).toBeUndefined();
  await expect(page.locator(".message img")).toHaveCount(0);
  await render(page, { readOnly: true });
  await expect(page.locator("textarea")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeHidden();
  await render(page, { pending: true, canCheck: true });
  await expect(page.locator("textarea")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Check send status" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
});
test("IME Enter does not send and out-of-scope state is ignored", async ({
  page,
}) => {
  await page.goto("/");
  await render(page, { sendOnEnter: true });
  await page
    .locator("textarea")
    .dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect(
    await page.evaluate(
      () => (window as any).sent.filter((m: any) => m.type === "send").length,
    ),
  ).toBe(0);
  await page.evaluate(
    (s) =>
      window.postMessage(
        {
          type: "state",
          state: { ...s, scope: "other", title: "Wrong profile" },
        },
        "*",
      ),
    state,
  );
  await expect(page.locator("h1")).not.toContainText("Wrong profile");
});
test("new messages preserve reading position and expose jump to latest", async ({
  page,
}) => {
  await page.goto("/");
  const messages = Array.from({ length: 40 }, (_, i) => ({
    ...state.messages[i % 3]!,
    id: String(i),
    time: `2026-10-14T09:${String(i).padStart(2, "0")}:00Z`,
  }));
  await render(page, { messages });
  await page.locator(".history").evaluate((e) => (e.scrollTop = 100));
  await render(page, {
    messages: [
      ...messages,
      { ...state.messages[0]!, id: "new", time: "2026-10-14T10:00:00Z" },
    ],
  });
  expect(await page.locator(".history").evaluate((e) => e.scrollTop)).toBe(100);
  await expect(
    page.getByRole("button", { name: "New messages · jump to latest" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New messages · jump to latest" })
    .click();
  await expect(page.locator(".jump")).toBeHidden();
});
test("theme, compact layout and accessible controls — batched visual evidence", async ({
  page,
}) => {
  await mkdir(".impeccable/review", { recursive: true });
  for (const v of [
    { name: "desktop", w: 1100, h: 800, theme: "dark" },
    { name: "light", w: 1100, h: 800, theme: "light" },
    { name: "mobile", w: 390, h: 844, theme: "dark" },
    { name: "pending", w: 600, h: 800, theme: "dark" },
    { name: "account-details", w: 390, h: 844, theme: "light" },
    { name: "hierarchy-narrow", w: 320, h: 760, theme: "light" },
    { name: "hierarchy-contrast", w: 760, h: 900, theme: "dark" },
    { name: "hierarchy-zoom", w: 600, h: 1000, theme: "dark" },
  ]) {
    await page.emulateMedia({ forcedColors: "none" });
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.goto("/?theme=" + v.theme);
    await render(
      page,
      v.name === "pending"
        ? {
            pending: true,
            canCheck: true,
            note: "Send outcome unknown. Check before sending another copy.",
          }
        : v.name === "hierarchy-narrow"
          ? {
              messages: [
                {
                  ...state.messages[0]!,
                  sender: "Alexandria Long Display Name العربية 日本語",
                  text:
                    "A long unbroken link wraps safely: https://example.test/" +
                    "long-path-".repeat(20),
                },
                {
                  ...state.messages[0]!,
                  id: "follow-up",
                  sender: "Alexandria Long Display Name العربية 日本語",
                  time: "2026-10-14T09:13:00Z",
                  text: "Follow-up with a visible time.",
                },
              ],
            }
          : {},
    );
    if (v.name === "hierarchy-contrast")
      await page.emulateMedia({ forcedColors: "active" });
    if (v.name === "hierarchy-zoom")
      await page.evaluate(() =>
        document.documentElement.style.setProperty(
          "--vscode-font-size",
          "26px",
        ),
      );
    if (v.name === "account-details") await page.locator("summary").click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const violations = (await new AxeBuilder({ page }).analyze()).violations;
    expect(violations).toEqual([]);
    await page.screenshot({
      path: `.impeccable/review/${v.name}.png`,
      fullPage: true,
    });
  }
});

test("Mixed account errors offer a clickable recovery action and block sending", async ({
  page,
}) => {
  await page.goto("/");
  await render(page, {
    messages: [],
    error:
      "More than one Teams account is available. Choose Personal or Work or school for this connection.",
    recovery: "selectAccount",
  });
  const choose = page.getByRole("button", {
    name: "Choose Teams account",
    exact: true,
  });
  await expect(choose).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await choose.click();
  expect(
    await page.evaluate(
      () =>
        (window as any).sent.filter((m: any) => m.type === "selectAccount")
          .length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      (window as any).sent.some((m: any) => m.type === "send"),
    ),
  ).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await render(page, { error: "", recovery: undefined });
  await expect(choose).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
});
