import type { Profile } from "./models";

export type SetupAction = "setup" | "browserSignIn";
export interface SetupJob {
  finished: Promise<number | undefined>;
  reveal(): void;
}
interface SetupHost {
  profiles(): Promise<Profile[]>;
  launch(action: SetupAction, profile?: Profile): Promise<SetupJob | undefined>;
  complete(before: Profile[]): Promise<void>;
  failed(): Promise<void>;
}

// The CLI owns capability checks, port allocation, browser sign-in and recovery.
// VS Code owns the entry point, terminal lifecycle and return to the inbox.
export class GuidedSetup {
  private pending?: Promise<void>;
  private job?: SetupJob;
  private disposed = false;
  constructor(private readonly host: SetupHost) {}
  get busy() {
    return !!this.pending;
  }
  execute(action: SetupAction = "setup", profile?: Profile): Promise<void> {
    if (this.pending) {
      this.job?.reveal();
      return this.pending;
    }
    if (this.disposed) return Promise.resolve();
    this.pending = this.run(action, profile).finally(() => {
      this.pending = undefined;
      this.job = undefined;
    });
    return this.pending;
  }
  private async run(action: SetupAction, profile?: Profile) {
    const before = await this.host.profiles();
    if (this.disposed) return;
    this.job = await this.host.launch(action, profile);
    if (!this.job) return;
    const code = await this.job.finished;
    if (this.disposed) return;
    if (code === 0) await this.host.complete(before);
    else if (code !== undefined) await this.host.failed();
  }
  dispose() {
    this.disposed = true;
  }
}

export function completedProfile(
  before: Profile[],
  after: Profile[],
  previous?: string,
): string | undefined {
  const active = after.find((p) => p.active);
  // Canceling a wizard must not replace an independently selected editor profile.
  if (
    active &&
    (!before.some((p) => p.name === active.name && p.active) ||
      !previous ||
      !after.some((p) => p.name === previous))
  )
    return active.name;
  return previous ?? active?.name;
}

export function supportsGuidedSetup(version: string, schema: unknown): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (!(major > 0 || minor > 2 || (minor === 2 && patch >= 2))) return false;
  const commands = (schema as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(commands)) return false;
  const init = commands.find((c) => c?.name === "init");
  return (
    Array.isArray(init?.args) &&
    ["--desktop-client", "--auto-start"].every((name) =>
      init.args.some((a: { name?: unknown }) => a?.name === name),
    ) &&
    commands.some((c) => c?.name === "desktop login")
  );
}
