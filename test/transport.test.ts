import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cli, CliError, parseError } from "../src/cli";
import {
  plain,
  page,
  message,
  chat,
  mergeMessages,
  accountLabel,
} from "../src/models";

async function fixture(
  source: string,
  run: (cli: Cli, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "teams-transport-"));
  const script = join(dir, "fake cli");
  await writeFile(script, source, { mode: 0o700 });
  try {
    await run(new Cli(process.execPath, () => {}, [script]), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("transport sends text through stdin and passes literal argument boundaries", async () => {
  await fixture(
    `let body='';process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),body})));`,
    async (cli) => {
      const body = "hello\n$(touch nope) `whoami` & <script>alert(1)</script>";
      const result = (await cli.call(
        [
          "--yes",
          "messages",
          "send",
          "--chat",
          "id; echo secret",
          "--body",
          "-",
        ],
        { profile: "test profile", body, mutation: true },
      )) as any;
      assert.deepEqual(result.args, [
        "--json",
        "--profile",
        "test profile",
        "--yes",
        "messages",
        "send",
        "--chat",
        "id; echo secret",
        "--body",
        "-",
      ]);
      assert.equal(result.body, body);
      assert(!result.args.includes(body));
    },
  );
});
test("documented rejection is safe; process death and malformed success are uncertain", async () => {
  for (const [source, kind, uncertain] of [
    [
      `console.error(JSON.stringify({error:{kind:'read_only',message:'private'}}));process.exit(3);`,
      "read_only",
      false,
    ],
    [`process.exit(1);`, "transport", true],
    [`console.log('not json');`, "protocol", true],
    [
      `console.error('note\\n'+JSON.stringify({error:{kind:'unconfirmed',clientMessageId:'100000000000000001'}}));process.exit(8);`,
      "unconfirmed",
      true,
    ],
  ] as const) {
    await fixture(source, async (cli) => {
      await assert.rejects(
        cli.call(["messages", "send"], { mutation: true }),
        (e) =>
          e instanceof CliError &&
          e.kind === kind &&
          e.uncertain === uncertain &&
          !e.message.includes("private"),
      );
    });
  }
});
test("timeout, cancellation and output limits fail closed", async () => {
  await fixture(`setTimeout(()=>console.log('{}'),2000);`, async (cli) => {
    await assert.rejects(
      cli.call(["messages", "send"], { mutation: true, timeout: 50 }),
      (e) => e instanceof CliError && e.uncertain,
    );
    const controller = new AbortController();
    const read = cli.call(["messages", "list"], { signal: controller.signal });
    controller.abort();
    await assert.rejects(
      read,
      (e) => e instanceof CliError && e.kind === "cancelled" && !e.uncertain,
    );
  });
  await fixture(
    `process.stdout.write('x'.repeat(9*1024*1024));`,
    async (cli) => {
      await assert.rejects(
        cli.call(["messages", "list"]),
        (e) => e instanceof CliError && e.kind === "protocol",
      );
    },
  );
});
test("missing executable cannot have submitted a send", async () => {
  await assert.rejects(
    new Cli(join(tmpdir(), "missing-teams-cli-21321")).call(
      ["messages", "send"],
      { mutation: true },
    ),
    (e) => e instanceof CliError && !e.uncertain,
  );
});
test("HTML becomes inert text and nullable cache data normalizes", () => {
  assert.equal(
    accountLabel("desktop", { desktop_account: "personal" }),
    "Personal account",
  );
  assert.equal(
    accountLabel("desktop", { desktop_account: "work_school" }),
    "Work or school",
  );
  assert.equal(
    accountLabel("desktop", { desktop_account: "work-school" }),
    "Work or school",
  );
  for (const config of [
    null,
    {},
    { desktop_account: "auto" },
    { desktop_account: "unknown" },
    { name: "personal" },
  ])
    assert.equal(accountLabel("desktop", config), "Teams account");
  assert.equal(accountLabel("graph"), "Work or school");
  assert.equal(
    plain(
      '<p>One &amp; two<br>three</p><script>secret()</script><img src=x onerror="oops()">',
      true,
    ),
    "One & two\nthree",
  );
  assert.equal(
    chat({
      id: "c",
      lastMessagePreview: null,
      members: [{ displayName: "Sample" }],
    }).title,
    "Sample",
  );
  const p = page(
    {
      items: [
        {
          id: "1",
          body: { contentType: "html", content: "<b>Hello</b>" },
          from: { user: { displayName: "Sample" } },
        },
      ],
      source: "desktop_cache",
      next_cursor: "opaque",
    },
    message,
  );
  assert(p.cached);
  assert.equal(p.items[0]?.text, "Hello");
  assert.equal(p.cursor, "opaque");
  assert.throws(() => page({}, message));
  assert.equal(mergeMessages(p.items, p.items).length, 1);
  assert.deepEqual(parseError('progress\n{"error":{"kind":"auth"}}'), {
    kind: "auth",
  });
});

test("Mixed-account diagnostics produce actionable copy without leaking raw CLI output", async () => {
  await fixture(
    `console.error(JSON.stringify({error:{kind:'desktop_error',message:'Multiple Teams accounts are available; private account details must never be echoed'}}));process.exit(5);`,
    async (cli) => {
      await assert.rejects(
        cli.call(["messages", "list"]),
        (e) =>
          e instanceof CliError &&
          e.kind === "desktop_account_ambiguous" &&
          e.message.includes("Choose Personal or Work or school") &&
          !e.message.includes("private") &&
          !e.message.includes("unavailable"),
      );
    },
  );
  await fixture(
    `console.error(JSON.stringify({error:{kind:'desktop_error',message:'private unexpected detail'}}));process.exit(5);`,
    async (cli) => {
      await assert.rejects(
        cli.call(["messages", "list"]),
        (e) =>
          e instanceof CliError &&
          e.kind === "desktop_error" &&
          !e.message.includes("private"),
      );
    },
  );
});
