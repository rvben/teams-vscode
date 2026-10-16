import test from "node:test";
import assert from "node:assert/strict";
import {
  GuidedSetup,
  completedProfile,
  supportsGuidedSetup,
} from "../src/guided-setup";
import type { Profile } from "../src/models";

const personal: Profile = {
  name: "personal-demo",
  backend: "desktop",
  readOnly: true,
  active: true,
};
const work: Profile = {
  name: "work-demo",
  backend: "graph",
  readOnly: true,
  active: false,
};
function fixture() {
  const events: string[] = [];
  let finish!: (code: number | undefined) => void;
  const finished = new Promise<number | undefined>((resolve) => {
    finish = resolve;
  });
  const host = {
    profiles: async () => [personal, work],
    launch: async () => {
      events.push("launch");
      return { finished, reveal: () => events.push("reveal") };
    },
    complete: async (before: Profile[]) => {
      assert.deepEqual(before, [personal, work]);
      events.push("complete");
    },
    failed: async () => {
      events.push("failed");
    },
  };
  return { events, finish, host, setup: new GuidedSetup(host) };
}
test("guided setup waits for a real process success and repeated clicks reveal the existing task", async () => {
  const f = fixture();
  const first = f.setup.execute();
  await new Promise(setImmediate);
  assert.deepEqual(f.events, ["launch"]);
  assert.equal(f.setup.execute(), first);
  assert.deepEqual(f.events, ["launch", "reveal"]);
  f.finish(0);
  await first;
  assert.deepEqual(f.events, ["launch", "reveal", "complete"]);
});
test("failed and canceled setup never report success; subsequent attempts remain available", async () => {
  for (const code of [1, undefined]) {
    const f = fixture();
    const pending = f.setup.execute();
    f.finish(code);
    await pending;
    assert(!f.events.includes("complete"));
    assert.equal(f.events.includes("failed"), code === 1);
    await f.setup.execute();
    assert.equal(f.events.filter((e) => e === "launch").length, 2);
  }
});
test("disposing during sign-in leaves the user's task alone and prevents late UI changes", async () => {
  const f = fixture();
  const pending = f.setup.execute("browserSignIn", personal);
  await new Promise(setImmediate);
  f.setup.dispose();
  f.finish(0);
  await pending;
  await f.setup.execute();
  assert.deepEqual(f.events, ["launch"]);
});
test("successful setup follows a changed CLI account; canceling preserves the editor's independent profile", () => {
  assert.equal(
    completedProfile([personal, work], [personal, work], work.name),
    work.name,
  );
  const after = [
    { ...personal, active: false },
    { ...work, active: true },
  ];
  assert.equal(
    completedProfile([personal, work], after, personal.name),
    work.name,
  );
  assert.equal(completedProfile([], [personal], undefined), personal.name);
  assert.equal(completedProfile([work], [personal], work.name), personal.name);
});
test("browser setup requires the stable CLI version and the actual guided setup contract", () => {
  const schema = {
    commands: [
      {
        name: "init",
        args: [{ name: "--desktop-client" }, { name: "--auto-start" }],
      },
      { name: "desktop login" },
    ],
  };
  for (const version of ["0.2.2", "0.3.0", "1.0.0"])
    assert(supportsGuidedSetup(version, schema));
  for (const version of ["0.1.11", "0.2.1", "0.2.2-alpha.1", "invalid"])
    assert(!supportsGuidedSetup(version, schema));
  for (const value of [
    null,
    {},
    { commands: [] },
    { commands: [{ name: "init" }] },
  ])
    assert(!supportsGuidedSetup("0.2.2", value));
});

test("setup stays busy before the terminal exists and through completion", async () => {
  let profilesReady!: (value: Profile[]) => void;
  let finish!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const setup = new GuidedSetup({
    profiles: () =>
      new Promise((resolve) => {
        profilesReady = resolve;
      }),
    launch: async () => ({ finished, reveal() {} }),
    complete: async () => {
      assert(setup.busy);
    },
    failed: async () => {},
  });
  const work = setup.execute();
  assert(
    setup.busy,
    "The pre-terminal capability/profile phase blocks handoff",
  );
  profilesReady([]);
  await new Promise(setImmediate);
  assert(setup.busy);
  finish(0);
  await work;
  assert.equal(setup.busy, false);
});
