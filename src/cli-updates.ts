/** Download separately; activate only when the host can safely hand off work. */
export type CliUpdateState = "idle" | "downloading" | "pending" | "failed";
export interface UpgradeHost<T> {
  prepare(): Promise<T>;
  activate(candidate: T, isCurrent: () => boolean): Promise<boolean>;
  discard(candidate: T): Promise<void>;
  changed(state: CliUpdateState): void;
}
export class CliUpgrade<T> {
  state: CliUpdateState = "idle";
  private work?: Promise<void>;
  private workGeneration = 0;
  private candidate?: T;
  private applying?: Promise<void>;
  private generation = 0;
  constructor(private readonly host: UpgradeHost<T>) {}
  request(): Promise<void> {
    if (this.work)
      return this.workGeneration === this.generation
        ? this.work
        : this.work.then(() => this.request());
    if (this.candidate) return this.apply();
    const generation = this.generation;
    this.workGeneration = generation;
    this.set("downloading");
    this.work = (async () => {
      try {
        const candidate = await this.host.prepare();
        if (generation !== this.generation) {
          await this.host.discard(candidate);
          return;
        }
        this.candidate = candidate;
        this.set("pending");
        await this.apply();
      } catch {
        if (generation === this.generation) this.set("failed");
      }
    })().finally(() => {
      this.work = undefined;
    });
    return this.work;
  }
  apply(): Promise<void> {
    if (this.applying) return this.applying;
    const candidate = this.candidate,
      generation = this.generation;
    if (!candidate) return Promise.resolve();
    this.applying = (async () => {
      try {
        if (
          await this.host.activate(
            candidate,
            () =>
              generation === this.generation && this.candidate === candidate,
          )
        ) {
          if (generation === this.generation) {
            this.candidate = undefined;
            this.set("idle");
          }
        }
      } catch {
        if (generation === this.generation) {
          this.candidate = undefined;
          await this.host.discard(candidate);
          this.set("failed");
        }
      }
    })().finally(() => {
      this.applying = undefined;
    });
    return this.applying;
  }
  cancel() {
    ++this.generation;
    const candidate = this.candidate;
    this.candidate = undefined;
    if (candidate) void this.host.discard(candidate).catch(() => {});
    this.set("idle");
  }
  private set(state: CliUpdateState) {
    this.state = state;
    this.host.changed(state);
  }
}

export function needsManagedUpgrade(installed: string, recommended: string) {
  const parse = (version: string) =>
    /^\d+\.\d+\.\d+$/.test(version)
      ? version.split(".").map(Number)
      : undefined;
  const a = parse(installed),
    b = parse(recommended);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}
