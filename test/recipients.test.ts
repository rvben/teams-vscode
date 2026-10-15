import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recipient,
  searchRecipients,
  createConversation,
} from "../src/recipients";
import { CliError, type Api } from "../src/cli";
import { PendingStore } from "../src/pending";
const to = {
  id: "8:live:synthetic",
  name: "Synthetic Person",
  email: "person@example.invalid",
};
async function fixture(run: (s: PendingStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "teams-recipient-"));
  try {
    await run(new PendingStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("recipient parsing rejects unusable identities and keeps literal names", () => {
  assert.equal(recipient({ id: "", displayName: "No ID" }), undefined);
  assert.equal(recipient({ id: "8:bad\n", displayName: "Bad" }), undefined);
  assert.equal(
    recipient({ id: "8:a", displayName: "<b>Person</b>" })?.name,
    "<b>Person</b>",
  );
});
test("search binds the profile, trims query and deduplicates exact identities", async () => {
  const api: Api = {
    call: async (args, opts) => {
      assert.deepEqual(args, [
        "people",
        "search",
        "Synthetic",
        "--limit",
        "20",
      ]);
      assert.equal(opts?.profile, "account-a");
      return {
        items: [
          { id: to.id, displayName: to.name, email: to.email },
          { id: to.id, displayName: to.name },
          {},
        ],
        truncated: true,
      };
    },
  };
  const r = await searchRecipients(api, "account-a", " Synthetic ");
  assert.deepEqual(r.items, [to]);
  assert.equal(r.truncated, true);
});
test("short and control-containing queries make no request", async () => {
  let calls = 0;
  const api: Api = {
    call: async () => {
      calls++;
      return {};
    },
  };
  for (const q of [" ", "x", "ab\ncd", "x".repeat(257)])
    assert.deepEqual((await searchRecipients(api, "a", q)).items, []);
  assert.equal(calls, 0);
});
test("opening a chat never sends a message or passes message text", () =>
  fixture(async (s) => {
    let calls = 0;
    const api: Api = {
      call: async (args, opts) => {
        calls++;
        assert.deepEqual(args, [
          "--yes",
          "chats",
          "create",
          "--recipient",
          to.id,
        ]);
        assert.equal(opts?.profile, "account-a");
        assert.equal(opts?.mutation, true);
        assert.equal(opts?.body, undefined);
        return { id: "19:synthetic@thread.v2" };
      },
    };
    const chat = await createConversation(api, s, "account-a", "scope", to);
    assert.equal(chat.title, to.name);
    assert.equal(calls, 1);
    assert.equal(await s.read("scope"), undefined);
  }));
test("uncertain create is durable and a second attempt cannot replay it", () =>
  fixture(async (s, root) => {
    let calls = 0;
    const api: Api = {
      call: async () => {
        calls++;
        throw new CliError("timeout", true);
      },
    };
    await assert.rejects(createConversation(api, s, "a", "scope", to));
    assert.equal((await s.read("scope"))?.state, "unknown");
    await assert.rejects(
      createConversation(api, new PendingStore(root), "a", "scope", to),
    );
    assert.equal(calls, 1);
    const saved = await readFile(join(root, s.key("scope") + ".json"), "utf8");
    assert(!saved.includes(to.id));
    assert(!saved.includes(to.email));
  }));
test("definite rejection unlocks creation; malformed success remains guarded", () =>
  fixture(async (s) => {
    await assert.rejects(
      createConversation(
        {
          call: async () => {
            throw new CliError("read_only", false);
          },
        },
        s,
        "a",
        "scope",
        to,
      ),
    );
    assert.equal(await s.read("scope"), undefined);
    await assert.rejects(
      createConversation({ call: async () => ({}) }, s, "a", "scope", to),
    );
    assert.equal((await s.read("scope"))?.state, "unknown");
  }));
