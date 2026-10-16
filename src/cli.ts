import {
  BrowserLifetime,
  BROWSER_CLIENT_ENV,
  BROWSER_KEEP_ALIVE_ENV,
} from "./browser-lifetime";
import { spawn } from "node:child_process";
import { obj, str, friendly } from "./models";

export class CliError extends Error {
  constructor(
    public kind: string,
    public uncertain = false,
    public clientId = "",
    public retryAfter = 0,
    public exitCode: number | null = null,
  ) {
    super(friendly(kind));
    this.name = "CliError";
  }
}
export interface CallOptions {
  profile?: string;
  body?: string;
  signal?: AbortSignal;
  timeout?: number;
  mutation?: boolean;
  env?: NodeJS.ProcessEnv;
}
export interface Api {
  call(args: string[], options?: CallOptions): Promise<unknown>;
}
export class Cli implements Api {
  private commands = new Set<string>();
  private lifetime?: BrowserLifetime;
  private keepAlive = false;
  private starting?: Promise<void>;
  private clientToken?: string;
  private closed = false;
  get environment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env[BROWSER_CLIENT_ENV];
    delete env[BROWSER_KEEP_ALIVE_ENV];
    return {
      ...env,
      ...(this.clientToken
        ? {
            [BROWSER_CLIENT_ENV]: this.clientToken,
            [BROWSER_KEEP_ALIVE_ENV]: this.keepAlive ? "1" : "0",
          }
        : {}),
    };
  }
  get browserLifetimeSupported() {
    return this.commands.has("desktop supervise");
  }
  startBrowserLifetime(keepAlive: boolean): Promise<void> {
    if (process.platform === "win32" || !this.browserLifetimeSupported)
      return Promise.resolve();
    if (this.closed) return Promise.reject(new CliError("cancelled"));
    this.keepAlive = keepAlive;
    if (this.lifetime?.running) return this.starting!;
    if (this.lifetime) {
      void this.lifetime.close(0);
      this.lifetime = undefined;
      this.starting = undefined;
      this.clientToken = undefined;
    }
    const lifetime = new BrowserLifetime(
      this.executable,
      this.prefix,
      keepAlive,
    );
    this.lifetime = lifetime;
    this.starting = lifetime.ready
      .then((token) => {
        if (this.closed || !lifetime.running || this.lifetime !== lifetime)
          throw new CliError("cancelled");
        this.clientToken = token;
      })
      .catch(async (error) => {
        await lifetime.close();
        if (this.lifetime === lifetime) {
          this.lifetime = undefined;
          this.starting = undefined;
          this.clientToken = undefined;
        }
        throw error instanceof CliError
          ? error
          : new CliError("browser_supervision");
      });
    return this.starting;
  }
  async close(): Promise<void> {
    this.closed = true;
    // The detached supervisor owns cleanup and the reload grace period.
    await this.lifetime?.close(0);
  }
  constructor(
    readonly executable: string,
    private log: (event: string) => void = () => {},
    private prefix: readonly string[] = [],
  ) {}
  async call(args: string[], options: CallOptions = {}): Promise<unknown> {
    try {
      return await this.callOnce(args, options);
    } catch (error) {
      if (
        !options.mutation &&
        error instanceof CliError &&
        error.kind === "browser_supervision" &&
        this.lifetime &&
        !this.lifetime.running &&
        !this.closed &&
        !options.signal?.aborted
      ) {
        await this.startBrowserLifetime(this.keepAlive);
        return this.callOnce(args, options);
      }
      throw error;
    }
  }
  private async callOnce(
    args: string[],
    options: CallOptions,
  ): Promise<unknown> {
    const desktop = args.indexOf("desktop");
    const cleanup =
      desktop >= 0 &&
      ["disconnect", "recover"].includes(args[desktop + 1] ?? "");
    const metadata = ["schema", "profile", "config"].includes(args[0] ?? "");
    if (!cleanup && !metadata) await this.starting;
    if (this.closed || options.signal?.aborted)
      return Promise.reject(new CliError("cancelled"));
    return new Promise((resolve, reject) => {
      const argv = [
        ...this.prefix,
        "--json",
        ...(options.profile ? ["--profile", options.profile] : []),
        ...args,
      ];
      const child = spawn(this.executable, argv, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...this.environment,
          ...options.env,
          ...(cleanup
            ? {
                [BROWSER_CLIENT_ENV]: undefined,
                [BROWSER_KEEP_ALIVE_ENV]: undefined,
              }
            : {}),
        },
      });
      let stdout: Buffer[] = [],
        stderr: Buffer[] = [],
        outSize = 0,
        errSize = 0,
        finished = false,
        spawned = false;
      const finish = (error?: CliError, value?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        this.log(
          `${args
            .slice(0, 2)
            .filter((a) => !a.startsWith("--"))
            .join(
              " ",
            )}: ${error ? error.kind : "ok"}${error?.exitCode != null ? ` (${error.exitCode})` : ""}`,
        );
        if (error) reject(error);
        else resolve(value);
      };
      const fail = (kind: string) => {
        finish(new CliError(kind, !!options.mutation && spawned));
        child.kill();
      };
      const abort = () => {
        if (!options.mutation) fail("cancelled");
      };
      const timer = setTimeout(
        () => fail("timeout"),
        options.timeout ?? (options.mutation ? 60_000 : 30_000),
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("spawn", () => {
        spawned = true;
      });
      child.once("error", () => finish(new CliError("missing_cli", false)));
      child.stdin.on("error", () => {});
      child.stdout.on("data", (b: Buffer) => {
        outSize += b.length;
        if (outSize > 8 * 1024 * 1024) fail("protocol");
        else stdout.push(b);
      });
      child.stderr.on("data", (b: Buffer) => {
        errSize += b.length;
        if (errSize > 1024 * 1024) fail("protocol");
        else stderr.push(b);
      });
      child.once("close", (code) => {
        if (finished) return;
        const output = Buffer.concat(stdout).toString("utf8"),
          errors = Buffer.concat(stderr).toString("utf8");
        if (code === 0) {
          try {
            finish(undefined, JSON.parse(output));
          } catch {
            finish(new CliError("protocol", !!options.mutation && spawned));
          }
          return;
        }
        const e = parseError(errors);
        // Only documented rejection kinds prove no submission. All other write failures stay guarded.
        const safe = new Set([
          "invalid_input",
          "auth",
          "read_only",
          "permission_denied",
          "not_found",
          "rate_limit",
          "tty_required",
          "confirmation_required",
          "unsupported",
          "desktop_busy",
          "desktop_disconnected",
          "desktop_prerequisites",
          "browser_supervision",
        ]);
        const kind = classifyError(str(e.kind) || "transport", str(e.message));
        finish(
          new CliError(
            kind,
            !!options.mutation && spawned && !safe.has(kind),
            /^\d{18}$/.test(str(e.clientMessageId))
              ? str(e.clientMessageId)
              : "",
            typeof e.retry_after_seconds === "number"
              ? Math.min(3600, Math.max(0, e.retry_after_seconds))
              : 0,
            code,
          ),
        );
      });
      child.stdin.end(options.body ?? "");
    });
  }
  async verify(): Promise<string> {
    const schema = obj(await this.call(["schema"]));
    const version = str(schema.version),
      parts = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
    if (
      !parts ||
      (Number(parts[1]) === 0 &&
        (Number(parts[2]) < 1 ||
          (Number(parts[2]) === 1 && Number(parts[3]) < 11))) ||
      parts[4]
    )
      throw new Error("Teams CLI 0.1.11 or newer stable is required.");
    const names = Array.isArray(schema.commands)
      ? schema.commands.map((c) => str(obj(c).name))
      : [];
    this.commands = new Set(names);
    for (const name of [
      "profile list",
      "chats list",
      "messages list",
      "messages send",
      "messages status",
    ])
      if (!names.includes(name))
        throw new Error(
          `Teams CLI is missing ${name}. Select a compatible executable.`,
        );
    return version;
  }
}
export function parseError(stderr: string): Record<string, unknown> {
  try {
    return obj(obj(JSON.parse(stderr)).error);
  } catch {}
  for (let i = stderr.indexOf("{"); i >= 0; i = stderr.indexOf("{", i + 1)) {
    try {
      const parsed = obj(JSON.parse(stderr.slice(i).trim()));
      if (parsed.error) return obj(parsed.error);
    } catch {}
  }
  return {};
}

// Map only known, non-identifying CLI diagnostics. Raw error text stays out of UI/logs.
export function classifyError(kind: string, detail: string): string {
  if (kind !== "desktop_error") return kind;
  if (
    detail.startsWith(
      "Browser prerequisites are not ready; no session access was attempted:",
    )
  )
    return "desktop_prerequisites";
  if (detail.startsWith("another browser connection command is running"))
    return "desktop_busy";
  if (
    detail.startsWith("browser lease could not be established:") ||
    detail.startsWith("the browser supervisor has closed") ||
    detail.startsWith("invalid browser supervisor token")
  )
    return "browser_supervision";
  if (detail.startsWith("Multiple Teams accounts are available;"))
    return "desktop_account_ambiguous";
  if (detail.startsWith("No endpoint on this port:"))
    return "desktop_disconnected";
  if (detail.startsWith("No Teams window is available"))
    return "desktop_no_window";
  if (detail.startsWith("The Teams cache layout was not recognised;"))
    return "desktop_cache_unsupported";
  return kind;
}
