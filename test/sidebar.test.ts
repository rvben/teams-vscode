import { test } from "node:test";
import assert from "node:assert/strict";
import {
  avatarData,
  filterChats,
  initials,
  validSidebarAction,
  sidebarLayout,
  chatTime,
} from "../src/sidebar-model";
import { chat } from "../src/models";

test("sidebar avatar input stays local and system/deleted previews do not expose markup or old text", () => {
  for (const value of [
    "https://example.com/tracker.png",
    "file:///private/avatar.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64," + "a".repeat(350_000),
  ])
    assert.equal(avatarData(value), "");
  assert.equal(
    avatarData("data:image/png;base64,iVBORw0KGgo="),
    "data:image/png;base64,iVBORw0KGgo=",
  );
  assert.equal(
    chat({
      lastMessagePreview: {
        messageType: "systemEventMessage",
        body: {
          contentType: "text",
          content: "<addmember>private</addmember>",
        },
      },
    }).preview,
    "Conversation updated",
  );
  assert.equal(
    chat({
      lastMessagePreview: {
        isDeleted: true,
        body: { content: "deleted private text" },
      },
    }).preview,
    "Message deleted",
  );
  assert.equal(initials("李 明"), "李明");
  assert.equal(initials("Morgan Reed"), "MR");
  assert.equal(initials(""), "?");
});
test("unread state is only inferred when read and message timestamps are known", () => {
  assert.equal(
    chat({ lastMessagePreview: { createdDateTime: "2026-10-14T10:00:00Z" } })
      .unread,
    undefined,
  );
  assert.equal(
    chat({
      viewpoint: { lastMessageReadDateTime: "invalid" },
      lastMessagePreview: { createdDateTime: "2026-10-14T10:00:00Z" },
    }).unread,
    undefined,
  );
  const c = chat({
    id: "1",
    topic: "Release plan",
    chatType: "group",
    viewpoint: { lastMessageReadDateTime: "2026-10-14T09:00:00Z" },
    lastMessagePreview: {
      createdDateTime: "2026-10-14T10:00:00Z",
      body: { contentType: "html", content: "<p>Windows &amp; WSL</p>" },
    },
  });
  assert.equal(c.unread, true);
  assert.equal(filterChats([c], "release windows", "unread").length, 1);
  assert.equal(filterChats([c], "mac", "groups").length, 0);
  assert.equal(
    chat({ isUnread: false, viewpoint: { isRead: false } }).unread,
    false,
  );
});
test("sidebar commands validate scope, identifiers and the layout allowlist", () => {
  assert(
    validSidebarAction(
      { type: "open", scope: "s", profile: "p", id: "1" },
      "s",
    ),
  );
  assert(
    !validSidebarAction(
      { type: "open", scope: "old", profile: "p", id: "1" },
      "s",
    ),
  );
  assert(
    !validSidebarAction(
      { type: "open", scope: "s", profile: "p", id: {} },
      "s",
    ),
  );
  assert(
    !validSidebarAction(
      { type: "layout", scope: "s", layout: "injected" },
      "s",
    ),
  );
  assert(!validSidebarAction({ type: "send", scope: "s" }, "s"));
  assert(!validSidebarAction({ type: "executeCommand", scope: "s" }, "s"));
  assert.equal(sidebarLayout("unknown"), "teams");
  assert.equal(chatTime("invalid"), "");
  assert.equal(
    chatTime("2026-10-13T12:00:00", new Date("2026-10-14T12:00:00")),
    "Yesterday",
  );
});
