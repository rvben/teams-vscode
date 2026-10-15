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
  constructor(
    readonly executable: string,
    private log: (event: string) => void = () => {},
    private prefix: readonly string[] = [],
  ) {}
  call(args: string[], options: CallOptions = {}): Promise<unknown> {
    if (options.signal?.aborted)
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
        env: options.env ?? process.env,
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
