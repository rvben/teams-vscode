import { test } from "node:test";
import assert from "node:assert/strict";
import { CliUpgrade, needsManagedUpgrade } from "../src/cli-updates";
import { Cli } from "../src/cli";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("managed upgrades compare stable versions numerically and never downgrade", () => {
  assert(needsManagedUpgrade("0.2.2", "0.2.3"));
  assert(needsManagedUpgrade("0.2.9", "0.2.10"));
  for (const installed of [
    "0.2.3",
    "0.2.4",
    "1.0.0",
    "invalid",
    "0.2.2-beta.1",
  ])
    assert(!needsManagedUpgrade(installed, "0.2.3"));
});

test("downloads coalesce, stay pending while busy, then switch exactly once", async () => {
  const ready = deferred<string>();
  let idle = false,
    prepares = 0,
    activated = 0;
  const states: string[] = [];
  const upgrade = new CliUpgrade({
    prepare: () => {
      prepares++;
      return ready.promise;
    },
    activate: async () => {
      if (!idle) return false;
      activated++;
      return true;
    },
    discard: async () => {},
    changed: (state) => states.push(state),
  });
  const first = upgrade.request(),
    second = upgrade.request();
  assert.equal(first, second);
  ready.resolve("verified");
  await first;
  assert.equal(prepares, 1);
  assert.equal(upgrade.state, "pending");
  assert.equal(activated, 0);
  idle = true;
  await Promise.all([upgrade.apply(), upgrade.apply()]);
  assert.equal(activated, 1);
  assert.deepEqual(states, ["downloading", "pending", "idle"]);
});

test("failed downloads preserve the active CLI and support an explicit retry", async () => {
  let attempts = 0,
    switched = false;
  const upgrade = new CliUpgrade({
    prepare: async () => {
      if (++attempts === 1) throw new Error("checksum");
      return "valid";
    },
    activate: async () => {
      switched = true;
      return true;
    },
    discard: async () => {},
    changed: () => {},
  });
  await upgrade.request();
  assert.equal(upgrade.state, "failed");
  assert.equal(switched, false);
  await upgrade.request();
  assert.equal(switched, true);
  assert.equal(upgrade.state, "idle");
});

test("changing selection during a download discards it; a new request is not lost", async () => {
  const ready = deferred<string>();
  let prepares = 0;
  const discarded: string[] = [],
    active: string[] = [];
  const upgrade = new CliUpgrade({
    prepare: async () => (++prepares === 1 ? ready.promise : "new selection"),
    activate: async (candidate) => {
      active.push(candidate);
      return true;
    },
    discard: async (candidate) => {
      discarded.push(candidate);
    },
    changed: () => {},
  });
  const first = upgrade.request();
  upgrade.cancel();
  const second = upgrade.request();
  ready.resolve("obsolete");
  await Promise.all([first, second]);
  assert.deepEqual(discarded, ["obsolete"]);
  assert.deepEqual(active, ["new selection"]);
});

test("canceling a pending switch keeps the current selection", async () => {
  let discarded = false;
  const upgrade = new CliUpgrade({
    prepare: async () => "staged",
    activate: async () => false,
    discard: async () => {
      discarded = true;
    },
    changed: () => {},
  });
  await upgrade.request();
  upgrade.cancel();
  await upgrade.apply();
  assert(discarded);
  assert.equal(upgrade.state, "idle");
});

test("CLI handoff waits for real subprocess work and keeps existing API references usable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teams-cli-handoff-"));
  try {
    const script = join(dir, "cli.cjs");
    await writeFile(
      script,
      `const args=process.argv.slice(2);setTimeout(()=>console.log(JSON.stringify({generation:args[0]})),args.includes('slow')?100:0);`,
    );
    const previous = new Cli(process.execPath, () => {}, [script, "old"]);
    const next = new Cli(process.execPath, () => {}, [script, "new"]);
    const running = previous.call(["slow"], { mutation: true });
    assert.equal(previous.handoff(next), false);
    assert.deepEqual(await running, { generation: "old" });
    assert(previous.handoff(next));
    await previous.close();
    assert.deepEqual(await previous.call(["read"]), { generation: "new" });
    assert.deepEqual(await previous.call(["send"], { mutation: true }), {
      generation: "new",
    });
    await next.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancel during browser joining invalidates activation even after a new request", async () => {
  const joining = deferred<void>(),
    joined = deferred<void>();
  let prepared = 0;
  const active: number[] = [],
    discarded: number[] = [];
  const upgrade = new CliUpgrade({
    prepare: async () => ++prepared,
    activate: async (candidate, isCurrent) => {
      assert(isCurrent());
      if (candidate === 1) {
        joining.resolve();
        await joined.promise;
      }
      if (!isCurrent()) return false;
      active.push(candidate);
      return true;
    },
    discard: async (candidate) => {
      discarded.push(candidate);
    },
    changed: () => {},
  });
  const first = upgrade.request();
  await joining.promise;
  upgrade.cancel();
  const second = upgrade.request();
  joined.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(discarded, [1]);
  assert.deepEqual(active, [2]);
  assert.equal(upgrade.state, "idle");
});

test("CLI handoff refuses a candidate closed by cancellation", async () => {
  const previous = new Cli(process.execPath);
  const discarded = new Cli(process.execPath);
  await discarded.close();
  assert.equal(previous.handoff(discarded), false);
  const replacement = new Cli(process.execPath);
  assert.equal(previous.handoff(replacement), true);
  await previous.close();
  await replacement.close();
});
