import { test } from "node:test";
import assert from "node:assert/strict";
import { continuesMessage, withMemberAvatars } from "../src/conversation-model";
import { chat, message, type Message } from "../src/models";

const first: Message = {
  id: "first",
  sender: "Alex",
  senderId: "user:one",
  text: "Hello",
  time: new Date(2026, 9, 14, 9, 0).toISOString(),
  clientId: "",
  delivery: "",
};
test("message groups require known identity, matching name and a nearby chronological local day", () => {
  const next = (minutes: number, patch: Partial<Message> = {}) => ({
    ...first,
    id: "next",
    time: new Date(Date.parse(first.time) + minutes * 60_000).toISOString(),
    ...patch,
  });
  assert.equal(continuesMessage(first, next(5)), true);
  for (const candidate of [
    next(5.01),
    next(-1),
    next(1, { senderId: "user:two" }),
    next(1, { sender: "Someone else" }),
    next(1, { senderId: undefined }),
    next(1, { time: "unknown" }),
  ])
    assert.equal(continuesMessage(first, candidate), false);
  assert.equal(continuesMessage(undefined, next(1)), false);
  assert.equal(
    continuesMessage(
      { ...first, senderId: undefined },
      next(1, { senderId: undefined }),
    ),
    false,
  );
  assert.equal(
    continuesMessage(
      { ...first, time: new Date(2026, 9, 14, 23, 59).toISOString() },
      next(0, { time: new Date(2026, 9, 15, 0, 1).toISOString() }),
    ),
    false,
  );
});
test("normalization keeps sender identity separate from display names and application identities", () => {
  const user = message({ from: { user: { id: "one", displayName: "Alex" } } });
  const other = message({ from: { user: { id: "two", displayName: "Alex" } } });
  const app = message({
    from: { application: { id: "one", displayName: "Alex" } },
  });
  assert.equal(user.senderId, "user:one");
  assert.notEqual(user.senderId, other.senderId);
  assert.notEqual(user.senderId, app.senderId);
  assert.equal(
    message({ from: { user: { displayName: "Alex" } } }).senderId,
    undefined,
  );
});

const photo = "data:image/png;base64,iVBORw0KGgo=";
test("chat photos reach message senders by member identity, never display name or conversation photo", () => {
  const conversation = chat({
    id: "chat",
    avatarData: photo,
    members: [
      { userId: "one", displayName: "Alex", avatarData: photo },
      {
        userId: "two",
        displayName: "Alex",
        avatarData: "https://example.test/photo",
      },
    ],
  });
  const rows = withMemberAvatars(
    [
      first,
      { ...first, id: "namesake", senderId: "user:two" },
      { ...first, id: "bot", senderId: "application:one" },
      { ...first, id: "unknown", senderId: undefined },
    ],
    conversation,
  );
  assert.equal(conversation.avatar, photo);
  assert.deepEqual(
    rows.map((m) => m.avatar),
    [photo, undefined, undefined, undefined],
  );
  assert.equal(first.avatar, undefined, "Session messages are not mutated");
  assert.equal(
    withMemberAvatars([first], chat({ id: "other", avatarData: photo }))[0]
      ?.avatar,
    undefined,
  );
});
test("conflicting member photos fail closed and refreshed chat metadata replaces old photos", () => {
  const other = "data:image/jpeg;base64,YWJj";
  const conversation = chat({
    members: [
      { userId: "one", avatarData: photo },
      { userId: "one", avatarData: other },
    ],
  });
  assert.equal(withMemberAvatars([first], conversation)[0]?.avatar, undefined);
  const enriched = withMemberAvatars(
    [first],
    chat({ members: [{ userId: "one", avatarData: photo }] }),
  );
  assert.equal(enriched[0]?.avatar, photo);
  assert.equal(
    withMemberAvatars(enriched, chat({ members: [] }))[0]?.avatar,
    undefined,
  );
});
