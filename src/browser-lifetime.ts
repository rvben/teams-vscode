import { spawn, type ChildProcess } from "node:child_process";

export const BROWSER_CLIENT_ENV = "TEAMS_DESKTOP_BROWSER_CLIENT";
export const BROWSER_KEEP_ALIVE_ENV = "TEAMS_DESKTOP_BROWSER_KEEP_ALIVE";

// The CLI owns browser identity checks and cross-window coordination. A pipe gives
// it an exit signal even when VS Code crashes or forcibly terminates this host.
export class BrowserLifetime {
  readonly ready: Promise<string>;
  private child: ChildProcess;
  private ended: Promise<void>;
  private closing?: Promise<void>;
  private stopped = false;
  private alive = true;

  constructor(
    executable: string,
    prefix: readonly string[],
    keepAlive: boolean,
    env: NodeJS.ProcessEnv = process.env,
    startupTimeout = 5_000,
  ) {
    this.child = spawn(
      executable,
      [
        ...prefix,
        "--json",
        "desktop",
        "supervise",
        ...(keepAlive ? ["--keep-alive"] : []),
      ],
      {
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
        env,
      },
    );
    const child = this.child;
    this.ended = new Promise((resolve) => {
      child.once("close", () => {
        this.alive = false;
        resolve();
      });
    });
    this.ready = new Promise((resolve, reject) => {
      let output = "";
      let settled = false;
      const timer = setTimeout(() => fail(), startupTimeout);
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin?.end();
        reject(
          new Error(
            "Automatic browser cleanup could not start. Check the selected CLI and reconnect Teams.",
          ),
        );
      };
      child.once("error", fail);
      child.once("close", fail);
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", fail);
      child.stdout?.on("data", (data: Buffer) => {
        if (settled) return;
        output += data.toString("utf8");
        if (Buffer.byteLength(output) > 4096) return fail();
        const end = output.indexOf("\n");
        if (end < 0) return;
        try {
          const value = JSON.parse(output.slice(0, end));
          if (
            this.stopped ||
            value.protocol !== 1 ||
            typeof value.client !== "string" ||
            !/^[a-f0-9]{32}$/.test(value.client)
          )
            return fail();
          settled = true;
          clearTimeout(timer);
          resolve(value.client);
        } catch {
          fail();
        }
      });
    });
    // Cleanup can take longer than VS Code's deactivate deadline. Let the CLI finish
    // on its own; never kill a supervisor while it is closing a verified browser.
    child.unref();
    for (const stream of [child.stdin, child.stdout])
      (stream as { unref?: () => void } | null)?.unref?.();
  }

  get running() {
    return this.alive && !this.stopped;
  }

  close(timeout = 4_000): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.child.stdin?.end();
    this.closing = new Promise((resolve) => {
      const timer = setTimeout(resolve, timeout);
      void this.ended.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.closing;
  }
}
