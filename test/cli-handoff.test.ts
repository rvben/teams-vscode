import { test } from "node:test";
import assert from "node:assert/strict";
import { joinBrowsers } from "../src/cli-handoff";
import type { Profile } from "../src/models";
const browser: Profile = {
  name: "browser",
  backend: "desktop",
  readOnly: true,
  active: true,
};
test("browser handoff joins before status and skips deleted or native profiles", async () => {
  const events: string[] = [];
  assert(
    await joinBrowsers(
      {
        call: async (args) => {
          events.push(args.join(" "));
          if (args[0] === "profile") return { items: [browser] };
          if (args[0] === "config") return { desktop_client: "browser_core" };
          return {};
        },
        startBrowserLifetime: async () => {
          events.push("join");
        },
      },
      [browser, { ...browser, name: "deleted" }],
      false,
    ),
  );
  assert.deepEqual(events, [
    "profile list",
    "config show",
    "join",
    "desktop status",
  ]);
});
test("transient browser handoff errors keep a verified candidate available for retry", async () => {
  let attempts = 0;
  const api = {
    call: async (args: string[]) => {
      if (args[0] === "profile") return { items: [browser] };
      if (args[0] === "config") return { desktop_client: "browser" };
      if (++attempts === 1) throw new Error("browser busy");
      return {};
    },
    startBrowserLifetime: async () => {},
  };
  assert.equal(await joinBrowsers(api, [browser], false), false);
  assert.equal(await joinBrowsers(api, [browser], false), true);
});

test("a stopped browser does not block switching or request a connection", async () => {
  const commands: string[] = [];
  assert(
    await joinBrowsers(
      {
        call: async (args) => {
          commands.push(args.join(" "));
          if (args[0] === "profile") return { items: [browser] };
          if (args[0] === "config") return { desktop_client: "browser" };
          return { endpoint_available: false, management: { managed: false } };
        },
        startBrowserLifetime: async () => {},
      },
      [browser],
      false,
    ),
  );
  assert(!commands.some((command) => /connect|login/.test(command)));
});
test("a lasting connection error remains recoverable and exposes its reason", async () => {
  const reasons: unknown[] = [];
  const failure = new Error("configuration needs recovery");
  const api = {
    call: async () => {
      throw failure;
    },
    startBrowserLifetime: async () => {},
  };
  for (let attempt = 0; attempt < 2; attempt++)
    assert.equal(
      await joinBrowsers(api, [browser], false, (error) => reasons.push(error)),
      false,
    );
  assert.deepEqual(reasons, [failure, failure]);
});
