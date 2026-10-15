import test from "node:test";
import assert from "node:assert/strict";
import {
  DesktopActions,
  desktopState,
  newDesktopProfileName,
  accountProfileArgs,
  accountProfileName,
} from "../src/desktop";
import type { Profile } from "../src/models";

const graph: Profile = {
  name: "work",
  backend: "graph",
  readOnly: true,
  active: true,
};
const desktop: Profile = {
  name: "desktop",
  backend: "desktop",
  readOnly: true,
  active: false,
};
function fixture(list: Profile[] = [graph]) {
  const events: string[] = [];
  const host = {
    profiles: async () => list,
    current: () => graph,
    choose: async (
      _: Profile[],
      _canCreate: boolean,
    ): Promise<Profile | "new" | undefined> => desktop,
    create: async (): Promise<Profile | undefined> => {
      events.push("create");
      return desktop;
    },
    noProfile: async () => {
      events.push("noProfile");
    },
    confirm: async (): Promise<boolean> => {
      events.push("confirm");
      return true;
    },
    select: async (p: Profile) => {
      events.push(`select:${p.name}`);
    },
    run: async (action: string, p: Profile) => {
      events.push(`${action}:${p.name}`);
    },
    busy: (value: boolean) => {
      events.push(`busy:${value}`);
    },
    refresh: async () => {
      events.push("refresh");
    },
  };
  return { host, events, actions: new DesktopActions(host) };
}

test("Connect from Graph creates a desktop profile and confirms before connecting", async () => {
  const f = fixture();
  await f.actions.execute("connect");
  assert.deepEqual(f.events, [
    "busy:true",
    "create",
    "confirm",
    "select:desktop",
    "connect:desktop",
    "busy:false",
    "refresh",
  ]);
});

test("Connect from Graph selects the existing desktop profile without another setup", async () => {
  const f = fixture([graph, desktop]);
  await f.actions.execute("connect");
  assert(!f.events.includes("create"));
  assert(f.events.includes("connect:desktop"));
});

test("Canceling setup or confirmation never opens a debugging connection", async () => {
  for (const cancel of ["setup", "confirmation"]) {
    const f = fixture();
    if (cancel === "setup") f.host.create = async () => undefined;
    else f.host.confirm = async () => false;
    await f.actions.execute("connect");
    assert(
      !f.events.some(
        (e) => e.startsWith("connect:") || e.startsWith("select:"),
      ),
    );
    assert.deepEqual(f.events.slice(-2), ["busy:false", "refresh"]);
  }
});

test("Multiple desktop profiles are chosen explicitly; dismissing leaves them untouched", async () => {
  const second = { ...desktop, name: "second" };
  const f = fixture([graph, desktop, second]);
  f.host.choose = async (list, canCreate) => {
    assert.equal(list.length, 2);
    assert(canCreate);
    return undefined;
  };
  await f.actions.execute("connect");
  assert.deepEqual(f.events, ["busy:true", "busy:false", "refresh"]);
  f.host.choose = async () => second;
  await f.actions.execute("connect");
  assert(f.events.includes("connect:second"));
});

test("Disconnect and recovery never create a desktop profile", async () => {
  for (const action of ["disconnect", "recover"] as const) {
    const f = fixture();
    await f.actions.execute(action);
    assert.deepEqual(f.events, [
      "busy:true",
      "noProfile",
      "busy:false",
      "refresh",
    ]);
  }
});

test("Double click cannot launch concurrent connection wizards", async () => {
  const f = fixture([desktop]);
  let finish!: () => void;
  f.host.confirm = () =>
    new Promise<boolean>((resolve) => {
      finish = () => resolve(true);
    });
  const pending = f.actions.execute("connect");
  await new Promise((resolve) => setImmediate(resolve));
  await f.actions.execute("connect");
  finish();
  await pending;
  assert.equal(f.events.filter((e) => e === "connect:desktop").length, 1);
});

test("A failed restart unlocks controls and refreshes status for recovery", async () => {
  const f = fixture([desktop]);
  f.host.run = async () => {
    throw new Error("synthetic failure");
  };
  await assert.rejects(f.actions.execute("connect"), /synthetic/);
  assert.deepEqual(f.events.slice(-2), ["busy:false", "refresh"]);
  f.host.run = async () => {
    f.events.push("recovered");
  };
  await f.actions.execute("recover");
  assert(f.events.includes("recovered"));
});

test("Available metadata is separate from sign-in; interrupted setup takes priority", () => {
  assert.equal(
    desktopState({ endpoint_available: true, session_verified: false }),
    "connected",
  );
  assert.equal(
    desktopState({
      endpoint_available: true,
      management: { needs_recovery: true },
    }),
    "recovery",
  );
  assert.equal(
    desktopState({
      endpoint_available: false,
      connection: { status: "no_listener" },
    }),
    "disconnected",
  );
  assert.equal(
    desktopState({
      endpoint_available: false,
      connection: { status: "unsafe_listener_refused" },
    }),
    "unavailable",
  );
  assert.equal(desktopState(null), "unavailable");
});

test("New desktop profile names preserve all existing profiles", () => {
  assert.equal(newDesktopProfileName([graph]), "vscode-desktop");
  assert.equal(
    newDesktopProfileName([
      graph,
      { ...desktop, name: "vscode-desktop" },
      { ...desktop, name: "vscode-desktop-2" },
    ]),
    "vscode-desktop-3",
  );
});

test("Account-specific profiles preserve access and port without restarting Teams", async () => {
  assert.deepEqual(
    accountProfileArgs(
      { backend: "desktop", desktop_port: 19222, read_only: true },
      "personal",
    ),
    [
      "init",
      "--backend",
      "desktop",
      "--no-login",
      "--desktop-port",
      "19222",
      "--desktop-account",
      "personal",
    ],
  );
  const writable = accountProfileArgs(
    { backend: "desktop", desktop_port: 19222, read_only: false },
    "work-school",
  );
  assert(writable.includes("--allow-send"));
  assert(
    !accountProfileArgs(
      { backend: "desktop", desktop_port: 19222 },
      "personal",
    ).includes("--allow-send"),
  );
  for (const config of [
    { backend: "graph", desktop_port: 19222 },
    { backend: "desktop", desktop_port: 80 },
    { backend: "desktop", desktop_port: "19222" },
  ])
    assert.throws(() => accountProfileArgs(config, "personal"));
  const name = accountProfileName(
    [{ ...desktop, name: "test-personal" }],
    "test",
    "personal",
  );
  assert.equal(name, "test-personal-2");
  assert.equal(
    accountProfileName([], "x".repeat(64), "work-school").length,
    64,
  );
});
