import type { Profile } from "./models";
import { obj } from "./models";

export type DesktopAction = "connect" | "disconnect" | "recover";
export type DesktopState =
  "connected" | "disconnected" | "recovery" | "unavailable";

// Endpoint availability is metadata, not proof of sign-in or chat access.
export function desktopState(value: unknown): DesktopState {
  const result = obj(value);
  if (obj(result.management).needs_recovery === true) return "recovery";
  if (result.endpoint_available === true) return "connected";
  if (obj(result.connection).status === "no_listener") return "disconnected";
  return "unavailable";
}

interface DesktopHost {
  profiles(): Promise<Profile[]>;
  current(): Profile | undefined;
  choose(
    profiles: Profile[],
    canCreate: boolean,
  ): Promise<Profile | "new" | undefined>;
  create(): Promise<Profile | undefined>;
  noProfile(): Promise<void>;
  confirm(action: DesktopAction, profile: Profile): Promise<boolean>;
  select(profile: Profile): Promise<void>;
  run(action: DesktopAction, profile: Profile): Promise<void>;
  busy(value: boolean): void;
  refresh(): Promise<void>;
}

// One wizard/operation per window. Neither activation nor status checks use this path.
export class DesktopActions {
  private running = false;
  constructor(private readonly host: DesktopHost) {}
  async execute(action: DesktopAction, preferred?: Profile): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.host.busy(true);
    try {
      const profiles = await this.host.profiles();
      const current = preferred ?? this.host.current();
      let profile = profiles.find(
        (p) => p.name === current?.name && p.backend === "desktop",
      );
      if (!profile) {
        const desktop = profiles.filter((p) => p.backend === "desktop");
        let choice: Profile | "new" | undefined;
        if (desktop.length === 1) choice = desktop[0];
        else if (desktop.length > 1)
          choice = await this.host.choose(desktop, action === "connect");
        else if (action === "connect") choice = "new";
        else {
          await this.host.noProfile();
          return;
        }
        profile = choice === "new" ? await this.host.create() : choice;
      }
      if (!profile || !(await this.host.confirm(action, profile))) return;
      await this.host.select(profile);
      await this.host.run(action, profile);
    } finally {
      this.running = false;
      this.host.busy(false);
      await this.host.refresh();
    }
  }
}

export function newDesktopProfileName(profiles: Profile[]): string {
  const names = new Set(profiles.map((p) => p.name));
  let name = "vscode-desktop";
  for (let n = 2; names.has(name); n++) name = `vscode-desktop-${n}`;
  return name;
}

export type DesktopAccount = "personal" | "work-school";
export function accountProfileArgs(
  config: unknown,
  account: DesktopAccount,
): string[] {
  const c = obj(config);
  if (
    c.backend !== "desktop" ||
    !Number.isInteger(c.desktop_port) ||
    Number(c.desktop_port) < 1024 ||
    Number(c.desktop_port) > 65535
  )
    throw new Error("Refresh the desktop profile before choosing an account.");
  return [
    "init",
    "--backend",
    "desktop",
    "--no-login",
    "--desktop-port",
    String(c.desktop_port),
    "--desktop-account",
    account,
    ...(c.read_only === false ? ["--allow-send"] : []),
  ];
}
export function accountProfileName(
  existing: Profile[],
  base: string,
  account: DesktopAccount,
): string {
  const names = new Set(existing.map((p) => p.name));
  const suffix = account === "personal" ? "personal" : "work";
  for (let n = 1; ; n++) {
    const tail = `-${suffix}${n > 1 ? `-${n}` : ""}`;
    const name = base.slice(0, 64 - tail.length) + tail;
    if (!names.has(name)) return name;
  }
}
