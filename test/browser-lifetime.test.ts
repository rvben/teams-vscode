import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { BrowserLifetime, BROWSER_CLIENT_ENV } from "../src/browser-lifetime";
import { Cli, classifyError } from "../src/cli";

const token = "1234567890abcdef1234567890abcdef";
async function fixture(
  source: string,
  run: (script: string, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "teams-browser-lifetime-"));
  const script = join(dir, "fake cli.cjs");
  await writeFile(script, source);
  try {
    await run(script, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function eventually(check: () => Promise<void>) {
  const end = Date.now() + 5_000;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= end) throw error;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
const supervisor = `
  const fs = require('node:fs');
  process.stdout.write(JSON.stringify({protocol:1,client:'${token}'}).slice(0,12));
  setTimeout(()=>process.stdout.write(JSON.stringify({protocol:1,client:'${token}'}).slice(12)+'\\n'),10);
  process.stdin.resume();
  process.stdin.on('end',()=>setTimeout(()=>{fs.appendFileSync(process.env.CLEANUP,'closed\\n');},Number(process.env.DELAY)||0));
`;

test("split ready messages, literal arguments, and idempotent graceful shutdown", async () => {
  await fixture(
    `require('node:fs').writeFileSync(process.env.ARGS,JSON.stringify(process.argv.slice(2)));${supervisor}`,
    async (script, dir) => {
      const cleanup = join(dir, "cleanup"),
        args = join(dir, "args");
      const lifetime = new BrowserLifetime(process.execPath, [script], true, {
        ...process.env,
        CLEANUP: cleanup,
        ARGS: args,
      });
      assert.equal(await lifetime.ready, token);
      assert(lifetime.running);
      assert.deepEqual(JSON.parse(await readFile(args, "utf8")), [
        "--json",
        "desktop",
        "supervise",
        "--keep-alive",
      ]);
      const closing = lifetime.close();
      assert.equal(closing, lifetime.close());
      await closing;
      assert(!lifetime.running);
      assert.equal(await readFile(cleanup, "utf8"), "closed\n");
    },
  );
});

test("shutdown deadline leaves the supervisor alive to finish browser cleanup", async () => {
  await fixture(supervisor, async (script, dir) => {
    const cleanup = join(dir, "cleanup");
    const lifetime = new BrowserLifetime(process.execPath, [script], false, {
      ...process.env,
      CLEANUP: cleanup,
      DELAY: "150",
    });
    await lifetime.ready;
    await lifetime.close(10);
    await eventually(async () =>
      assert.equal(await readFile(cleanup, "utf8"), "closed\n"),
    );
  });
});

test("startup rejects malformed, oversized, unsupported, missing, and stalled supervisors", async () => {
  for (const source of [
    `console.log('not json');process.stdin.resume();`,
    `console.log(JSON.stringify({protocol:2,client:'${token}'}));process.stdin.resume();`,
    `console.log(JSON.stringify({protocol:1,client:'../private'}));process.stdin.resume();`,
    `console.log('x'.repeat(4097));process.stdin.resume();`,
    `process.stdin.resume();`,
    `process.exit(1);`,
  ]) {
    await fixture(source, async (script) => {
      const lifetime = new BrowserLifetime(
        process.execPath,
        [script],
        false,
        process.env,
        150,
      );
      await assert.rejects(
        lifetime.ready,
        /Automatic browser cleanup could not start/,
      );
      await lifetime.close();
    });
  }
  const missing = new BrowserLifetime(
    join(tmpdir(), "missing-teams-supervisor-81723"),
    [],
    false,
  );
  await assert.rejects(
    missing.ready,
    /Automatic browser cleanup could not start/,
  );
  await missing.close();
});

test("shutdown during startup never delivers a usable token", async () => {
  await fixture(
    `setTimeout(()=>console.log(JSON.stringify({protocol:1,client:'${token}'})),100);process.stdin.resume();`,
    async (script) => {
      const lifetime = new BrowserLifetime(process.execPath, [script], false);
      const rejected = assert.rejects(lifetime.ready);
      await lifetime.close();
      await rejected;
    },
  );
});

test(
  "CLI propagates tokens and updates policy without spawning another supervisor",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(
      `
    const args=process.argv.slice(2);
    if(args.includes('schema')) console.log(JSON.stringify({version:'0.2.2',commands:['profile list','chats list','messages list','messages send','messages status','desktop supervise'].map(name=>({name}))}));
    else if(args.includes('supervise')) { ${supervisor} }
    else console.log(JSON.stringify({client:process.env.${BROWSER_CLIENT_ENV},keep:args.includes('--keep-alive')}));
  `,
      async (script, dir) => {
        const cleanup = join(dir, "cleanup");
        // The test fixture passes its cleanup destination as an environment override.
        const old = process.env.CLEANUP;
        process.env.CLEANUP = cleanup;
        const cli = new Cli(process.execPath, () => {}, [script]);
        try {
          await cli.verify();
          assert(cli.browserLifetimeSupported);
          await cli.startBrowserLifetime(false);
          assert.equal(cli.environment[BROWSER_CLIENT_ENV], token);
          assert.equal(
            ((await cli.call(["chats", "list"])) as any).client,
            token,
          );
          await cli.startBrowserLifetime(true);
          assert.equal(cli.environment.TEAMS_DESKTOP_BROWSER_KEEP_ALIVE, "1");
          await cli.close();
          await eventually(async () =>
            assert.equal(
              (await readFile(cleanup, "utf8")).trim().split("\n").length,
              1,
            ),
          );
          await assert.rejects(cli.call(["chats", "list"]));
        } finally {
          await cli.close();
          if (old === undefined) delete process.env.CLEANUP;
          else process.env.CLEANUP = old;
        }
      },
    );
  },
);

test("older CLIs retain manual lifecycle without invoking an unknown command", async () => {
  await fixture(
    `console.log(JSON.stringify({version:'0.2.2',commands:['profile list','chats list','messages list','messages send','messages status'].map(name=>({name}))}));`,
    async (script) => {
      const cli = new Cli(process.execPath, () => {}, [script]);
      await cli.verify();
      assert(!cli.browserLifetimeSupported);
      await cli.startBrowserLifetime(false);
      assert.equal(cli.environment[BROWSER_CLIENT_ENV], undefined);
      await cli.close();
    },
  );
});

test("a supervisor detects abrupt parent exit through pipe EOF", async () => {
  await fixture(supervisor, async (script, dir) => {
    const cleanup = join(dir, "cleanup");
    const parent = join(dir, "parent.cjs");
    await writeFile(
      parent,
      `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,[${JSON.stringify(script)}],{detached:true,stdio:['pipe','pipe','ignore'],env:{...process.env,CLEANUP:${JSON.stringify(cleanup)}}});
      let ready='';child.stdout.on('data',data=>{ready+=data;if(ready.includes('\\n')) process.exit(23);});
    `,
    );
    const child = spawn(process.execPath, [parent], { stdio: "ignore" });
    const [code] = await once(child, "exit");
    assert.equal(code, 23);
    await eventually(async () =>
      assert.equal(await readFile(cleanup, "utf8"), "closed\n"),
    );
  });
});

test(
  "failed supervisor startup is a safe send rejection and does not block metadata",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(
      `
    const args=process.argv.slice(2);
    if(args.includes('schema')) console.log(JSON.stringify({version:'0.2.2',commands:['profile list','chats list','messages list','messages send','messages status','desktop supervise'].map(name=>({name}))}));
    else if(args.includes('supervise')) process.exit(1);
    else console.log(JSON.stringify({ok:true}));
  `,
      async (script) => {
        const cli = new Cli(process.execPath, () => {}, [script]);
        await cli.verify();
        const starting = cli.startBrowserLifetime(false);
        const rejected = assert.rejects(
          cli.call(["messages", "send"], { mutation: true }),
          (error: any) =>
            error.kind === "browser_supervision" && error.uncertain === false,
        );
        await assert.rejects(
          starting,
          (error: any) => error.kind === "browser_supervision",
        );
        await rejected;
        assert.deepEqual(await cli.call(["profile", "list"]), { ok: true });
        assert.deepEqual(await cli.call(["desktop", "recover"]), { ok: true });
        await cli.close();
      },
    );
  },
);

test(
  "a killed supervisor can restart without blocking Graph or manual cleanup",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(
      `
    const fs=require('node:fs'), args=process.argv.slice(2);
    if(args.includes('schema')) console.log(JSON.stringify({version:'0.2.2',commands:['profile list','chats list','messages list','messages send','messages status','desktop supervise'].map(name=>({name}))}));
    else if(args.includes('supervise')) {
      fs.writeFileSync(process.env.PID_FILE,String(process.pid));
      console.log(JSON.stringify({protocol:1,client:'${token}'}));process.stdin.resume();
    } else console.log(JSON.stringify({client:process.env.${BROWSER_CLIENT_ENV} || null}));
  `,
      async (script, dir) => {
        const previous = process.env.PID_FILE;
        process.env.PID_FILE = join(dir, "pid");
        const cli = new Cli(process.execPath, () => {}, [script]);
        try {
          await cli.verify();
          await cli.startBrowserLifetime(false);
          const first = Number(await readFile(process.env.PID_FILE, "utf8"));
          process.kill(first, "SIGKILL");
          await new Promise((r) => setTimeout(r, 100));
          await cli.call(["chats", "list"], { profile: "graph" });
          assert.deepEqual(await cli.call(["desktop", "disconnect"]), {
            client: null,
          });
          await cli.startBrowserLifetime(false);
          const second = Number(await readFile(process.env.PID_FILE, "utf8"));
          assert.notEqual(first, second);
        } finally {
          await cli.close();
          if (previous === undefined) delete process.env.PID_FILE;
          else process.env.PID_FILE = previous;
        }
      },
    );
  },
);

test("known pre-submission CLI lifecycle errors are classified as safe", () => {
  assert.equal(
    classifyError(
      "desktop_error",
      "another browser connection command is running; retry shortly",
    ),
    "desktop_busy",
  );
  assert.equal(
    classifyError(
      "desktop_error",
      "the browser supervisor has closed; reopen Teams Companion before retrying",
    ),
    "browser_supervision",
  );
  assert.equal(
    classifyError("desktop_error", "an unrelated browser failure"),
    "desktop_error",
  );
});

test("an unsupervised CLI strips inherited lifecycle credentials", () => {
  const oldClient = process.env[BROWSER_CLIENT_ENV];
  const oldKeep = process.env.TEAMS_DESKTOP_BROWSER_KEEP_ALIVE;
  try {
    process.env[BROWSER_CLIENT_ENV] = "stale-token";
    process.env.TEAMS_DESKTOP_BROWSER_KEEP_ALIVE = "1";
    const cli = new Cli(process.execPath);
    assert.equal(cli.environment[BROWSER_CLIENT_ENV], undefined);
    assert.equal(cli.environment.TEAMS_DESKTOP_BROWSER_KEEP_ALIVE, undefined);
  } finally {
    if (oldClient === undefined) delete process.env[BROWSER_CLIENT_ENV];
    else process.env[BROWSER_CLIENT_ENV] = oldClient;
    if (oldKeep === undefined)
      delete process.env.TEAMS_DESKTOP_BROWSER_KEEP_ALIVE;
    else process.env.TEAMS_DESKTOP_BROWSER_KEEP_ALIVE = oldKeep;
  }
});

test("CLI pre-CDP lease rejections are safe for send retries", async () => {
  await fixture(
    `process.stderr.write(JSON.stringify({error:{kind:'desktop_error',message:'browser lease could not be established: process inspection unavailable'}})); process.exit(12);`,
    async (script) => {
      const cli = new Cli(process.execPath, () => {}, [script]);
      await assert.rejects(
        cli.call(["messages", "send"], { mutation: true }),
        (error: any) =>
          error.kind === "browser_supervision" && error.uncertain === false,
      );
      await cli.close();
    },
  );
});

test(
  "tab reads restart a dead supervisor once, while sends are never retried",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(
      `
    const fs=require('node:fs'), args=process.argv.slice(2), pidFile=process.env.PID_FILE;
    if(args.includes('schema')) console.log(JSON.stringify({version:'0.2.2',commands:['profile list','chats list','messages list','messages send','messages status','desktop supervise'].map(name=>({name}))}));
    else if(args.includes('supervise')) {
      fs.writeFileSync(pidFile,String(process.pid));
      console.log(JSON.stringify({protocol:1,client:'${token}'}));process.stdin.resume();
    } else {
      if(args.includes('send')) fs.appendFileSync(process.env.SEND_FILE,'attempt\\n');
      try{process.kill(Number(fs.readFileSync(pidFile,'utf8')),0);console.log(JSON.stringify({ok:true}));}
      catch {process.stderr.write(JSON.stringify({error:{kind:'desktop_error',message:'browser lease could not be established: the browser supervisor has closed'}}));process.exit(12);}
    }
  `,
      async (script, dir) => {
        const oldPid = process.env.PID_FILE,
          oldSend = process.env.SEND_FILE;
        process.env.PID_FILE = join(dir, "pid");
        process.env.SEND_FILE = join(dir, "sends");
        const cli = new Cli(process.execPath, () => {}, [script]);
        try {
          await cli.verify();
          await cli.startBrowserLifetime(false);
          let pid = Number(await readFile(process.env.PID_FILE, "utf8"));
          process.kill(pid, "SIGKILL");
          await new Promise((r) => setTimeout(r, 100));
          assert.deepEqual(await cli.call(["messages", "list"]), { ok: true });
          const replacement = Number(
            await readFile(process.env.PID_FILE, "utf8"),
          );
          assert.notEqual(pid, replacement);
          process.kill(replacement, "SIGKILL");
          await new Promise((r) => setTimeout(r, 100));
          await assert.rejects(
            cli.call(["messages", "send"], { mutation: true }),
            (error: any) =>
              error.kind === "browser_supervision" && !error.uncertain,
          );
          assert.equal(
            await readFile(process.env.SEND_FILE, "utf8"),
            "attempt\n",
          );
          assert.equal(
            Number(await readFile(process.env.PID_FILE, "utf8")),
            replacement,
          );
        } finally {
          await cli.close();
          if (oldPid === undefined) delete process.env.PID_FILE;
          else process.env.PID_FILE = oldPid;
          if (oldSend === undefined) delete process.env.SEND_FILE;
          else process.env.SEND_FILE = oldSend;
        }
      },
    );
  },
);

test("closed-browser reads and sends keep Connect recovery and safe retry semantics", async () => {
  for (const [detail, kind] of [
    [
      "No endpoint on this port: connect the browser before retrying",
      "desktop_disconnected",
    ],
    [
      "Browser prerequisites are not ready; no session access was attempted: missing browser",
      "desktop_prerequisites",
    ],
  ]) {
    await fixture(
      `process.stderr.write(JSON.stringify({error:{kind:'desktop_error',message:${JSON.stringify(detail)}}}));process.exit(5);`,
      async (script) => {
        const cli = new Cli(process.execPath, () => {}, [script]);
        for (const mutation of [false, true])
          await assert.rejects(
            cli.call(["messages", mutation ? "send" : "list"], { mutation }),
            (error: any) => error.kind === kind && !error.uncertain,
          );
        await cli.close();
      },
    );
  }
});
