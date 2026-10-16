import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingStore, PendingConflict } from "../src/pending";
import { Conversation } from "../src/session";
import { Api, CliError } from "../src/cli";

async function fixture(
  run: (store: PendingStore, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "teams-state-"));
  try {
    await run(new PendingStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const profile = {
  name: "sample",
  backend: "desktop" as const,
  readOnly: false,
  active: true,
};
const message = (id: string, time: string) => ({
  id,
  createdDateTime: time,
  body: { content: "Synthetic fixture" },
  from: { user: { displayName: "Sample" } },
});
test("exclusive durable send claim survives restart without message text", () =>
  fixture(async (store, root) => {
    const results = await Promise.allSettled([
      store.claim("scope"),
      store.claim("scope"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const pending = await new PendingStore(root).read("scope");
    assert(pending);
    await store.markUnknown("scope", pending.operation, "100000000000000001");
    const data = await readFile(
      join(root, store.key("scope") + ".json"),
      "utf8",
    );
    assert(!data.includes("body"));
    assert(!data.includes("Synthetic"));
    await assert.rejects(
      store.clear("scope", "other-operation"),
      PendingConflict,
    );
    assert(await store.read("scope"));
    await store.clear("scope", pending.operation);
    assert.equal(await store.read("scope"), undefined);
  }));
test("corrupt journal blocks rather than silently discarding a possibly submitted send", () =>
  fixture(async (store, root) => {
    await writeFile(join(root, store.key("scope") + ".json"), "partial");
    await assert.rejects(store.read("scope"), PendingConflict);
    await assert.rejects(store.claim("scope"), PendingConflict);
  }));
test("another window cannot clear a send still running in a live host", () =>
  fixture(async (store, root) => {
    const record = await store.claim("scope");
    const other = new PendingStore(root);
    assert(other.isActive(record));
    await assert.rejects(
      other.clear("scope", record.operation),
      /still running/,
    );
    await assert.rejects(other.acknowledgeCorrupt("scope"), /journal changed/);
    await store.markUnknown("scope", record.operation);
    await other.clear("scope", record.operation);
    assert.equal(await store.read("scope"), undefined);
  }));
test("failed or unknown delivery returned with an ID stays guarded", () =>
  fixture(async (store) => {
    const api: Api = {
      async call(args) {
        return args.includes("send")
          ? {
              id: "accepted",
              clientMessageId: "100000000000000001",
              delivery_state: "unknown",
            }
          : { items: [] };
      },
    };
    const c = new Conversation(api, profile, "chat", "scope", store, () => {});
    c.draft = "Synthetic";
    await c.send(true);
    assert(c.pending);
    assert.equal(c.draft, "Synthetic");
  }));
test("unknown send is never automatically retried; absent reconciliation is not failure", () =>
  fixture(async (store) => {
    let sends = 0;
    let status = "unknown";
    const api: Api = {
      async call(args) {
        if (args.includes("send")) {
          sends++;
          throw new CliError("unconfirmed", true, "100000000000000001");
        }
        if (args[1] === "status")
          return {
            delivery_state: status,
            found: status !== "unknown",
            chatId: "chat",
            clientMessageId: "100000000000000001",
          };
        return { items: [], source: "desktop_cache" };
      },
    };
    const c = new Conversation(api, profile, "chat", "scope", store, () => {});
    await c.initialize();
    c.draft = "Synthetic reply";
    await c.send(true);
    assert.equal(sends, 1);
    assert(c.pending);
    assert.equal(c.draft, "Synthetic reply");
    await c.check();
    assert(c.pending);
    await assert.rejects(c.send(true));
    assert.equal(sends, 1);
    status = "delivered";
    await c.check();
    assert(!c.pending);
    assert.equal(c.draft, "");
    assert.equal(sends, 1);
  }));
test("safe rejection keeps draft and releases claim; replies are opt-in", () =>
  fixture(async (store) => {
    let calls = 0;
    const api: Api = {
      async call(args) {
        calls++;
        if (args.includes("send")) throw new CliError("read_only");
        return { items: [] };
      },
    };
    const c = new Conversation(api, profile, "c", "scope", store, () => {});
    c.draft = "Synthetic";
    await assert.rejects(c.send(false));
    assert.equal(calls, 0);
    await c.send(true);
    assert(!c.pending);
    assert.equal(c.draft, "Synthetic");
    assert.equal(await store.read("scope"), undefined);
    assert.match(
      c.operationError,
      /read-only/,
      "Send rejection remains visible after history refresh",
    );
  }));
test("concurrent checks are coalesced and mismatched evidence never unlocks replies", () =>
  fixture(async (store) => {
    const record = await store.claim("scope");
    await store.markUnknown("scope", record.operation, "100000000000000001");
    let reads = 0;
    let done!: (value: unknown) => void;
    const api: Api = {
      async call() {
        reads++;
        return new Promise((r) => (done = r));
      },
    };
    const c = new Conversation(api, profile, "chat", "scope", store, () => {});
    await c.initialize();
    const first = c.check();
    const second = c.check();
    assert.equal(reads, 1);
    done({
      found: true,
      chatId: "different-chat",
      clientMessageId: "100000000000000001",
      delivery_state: "delivered",
    });
    await Promise.all([first, second]);
    assert(c.pending);
    assert(await store.read("scope"));
  }));
test("closing while sending keeps durable outcome protection", () =>
  fixture(async (store) => {
    let complete!: (value: unknown) => void;
    const api: Api = {
      call: () => new Promise((resolve) => (complete = resolve)),
    };
    const c = new Conversation(api, profile, "c", "scope", store, () => {});
    c.draft = "Synthetic";
    const sending = c.send(true);
    while (!c.sending) await new Promise((r) => setTimeout(r, 1));
    c.dispose();
    assert(await store.read("scope"));
    complete({ id: "sent" });
    await sending;
    assert.equal(await store.read("scope"), undefined);
  }));
test("pagination merges duplicates without losing older cursor and cancelled reads cannot repopulate disposed scope", () =>
  fixture(async (store) => {
    let n = 0;
    let late!: (v: unknown) => void;
    const api: Api = {
      async call() {
        n++;
        if (n === 1)
          return { items: [message("2", "2026-01-02")], next_cursor: "older" };
        if (n === 2)
          return {
            items: [message("1", "2026-01-01"), message("2", "2026-01-02")],
            next_cursor: "oldest",
          };
        if (n === 3) return { items: [message("3", "2026-01-03")] };
        return new Promise((r) => (late = r));
      },
    };
    const c = new Conversation(api, profile, "c", "scope", store, () => {});
    await c.refresh();
    await c.refresh(true);
    await c.refresh();
    assert.deepEqual(
      c.messages.map((m) => m.id),
      ["1", "2", "3"],
    );
    assert.equal(c.cursor, "oldest");
    const read = c.refresh();
    while (!late) await new Promise((r) => setTimeout(r, 1));
    c.dispose();
    late({ items: [message("4", "2026-01-04")] });
    await read;
    assert.equal(c.messages.length, 3);
  }));

test("An ambiguous account offers account selection and clears after a successful read", () =>
  fixture(async (store) => {
    let ambiguous = true;
    const api: Api = {
      call: async () => {
        if (ambiguous) throw new CliError("desktop_account_ambiguous");
        return {
          items: [message("sample", "2026-10-14T12:00:00Z")],
          source: "desktop_cache",
        };
      },
    };
    const session = new Conversation(
      api,
      profile,
      "chat",
      "scope",
      store,
      () => {},
    );
    await assert.rejects(session.refresh());
    assert.equal(session.recovery, "selectAccount");
    assert(!session.error.includes("unavailable"));
    assert.equal(session.messages.length, 0);
    ambiguous = false;
    await session.refresh();
    assert.equal(session.error, "");
    assert.equal(session.recovery, undefined);
    assert.equal(session.messages.length, 1);
  }));

test("pre-submission lifecycle failures release the send claim and retain the draft", () =>
  fixture(async (store) => {
    for (const kind of [
      "browser_supervision",
      "desktop_busy",
      "desktop_disconnected",
      "desktop_prerequisites",
    ]) {
      const api: Api = {
        async call(args) {
          if (args.includes("send")) throw new CliError(kind, false);
          return { items: [] };
        },
      };
      const session = new Conversation(
        api,
        profile,
        "chat",
        "scope",
        store,
        () => {},
      );
      session.draft = "Synthetic reply";
      await session.send(true);
      assert.equal(session.pending, undefined);
      assert.equal(await store.read("scope"), undefined);
      assert.equal(session.draft, "Synthetic reply");
      assert(!session.note.includes("outcome unknown"));
      if (kind === "desktop_disconnected")
        assert.equal(session.recovery, "connection");
    }
  }));
