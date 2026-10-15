import { obj, str } from "./models";

const repository = "https://github.com/rvben/teams-vscode";
const endpoint =
  "https://api.github.com/repos/rvben/teams-vscode/releases?per_page=30";
const day = 24 * 60 * 60 * 1000;
export interface ExtensionRelease {
  version: string;
  url: string;
  experimental: boolean;
}
function versionParts(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}
export function newerVersion(candidate: string, installed: string): boolean {
  const a = versionParts(candidate),
    b = versionParts(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

export function selectRelease(
  value: unknown,
  installed: string,
  includeExperimental: boolean,
): ExtensionRelease | undefined {
  if (!Array.isArray(value)) throw new Error("Invalid release response.");
  let newest: ExtensionRelease | undefined;
  for (const item of value) {
    const release = obj(item),
      tag = str(release.tag_name);
    const version = tag.startsWith("v") ? tag.slice(1) : "";
    if (
      release.draft !== false ||
      typeof release.prerelease !== "boolean" ||
      (release.prerelease && !includeExperimental) ||
      !str(release.published_at) ||
      !newerVersion(version, installed) ||
      str(release.html_url) !== `${repository}/releases/tag/${tag}`
    )
      continue;
    const assets = Array.isArray(release.assets) ? release.assets.map(obj) : [];
    if (
      !["SHA256SUMS", `teams-companion-${version}.vsix`].every((name) =>
        assets.some(
          (a) =>
            a.name === name &&
            a.state === "uploaded" &&
            a.browser_download_url ===
              `${repository}/releases/download/${tag}/${name}`,
        ),
      )
    )
      continue;
    if (!newest || newerVersion(version, newest.version))
      newest = {
        version,
        url: `${repository}/releases/tag/${tag}`,
        experimental: release.prerelease,
      };
  }
  return newest;
}

export async function fetchReleases(
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(endpoint, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "teams-companion",
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (!response.ok || !response.body) throw new Error("Release check failed.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024)
        throw new Error("Release response exceeded the size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

interface UpdateHost {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): Promise<void>;
  enabled(): boolean;
  fetch(): Promise<unknown>;
  available(release: ExtensionRelease): Promise<"open" | "skip" | undefined>;
  open(url: string): Promise<void>;
  current(): Promise<void>;
  failed(): Promise<void>;
  now(): number;
}
export class UpdateChecker {
  private pending?: Promise<void>;
  private manualRequested = false;
  private disposed = false;
  constructor(
    private readonly installed: string,
    private readonly experimental: boolean,
    private readonly host: UpdateHost,
  ) {}
  check(manual = false): Promise<void> {
    if (this.disposed || (!manual && !this.host.enabled()))
      return Promise.resolve();
    if (manual) this.manualRequested = true;
    if (this.pending) return this.pending;
    const last = this.host.get<number>("updates.lastCheck");
    const now = this.host.now();
    if (!manual && typeof last === "number" && last <= now && now - last < day)
      return Promise.resolve();
    this.pending = this.run(now).finally(() => {
      this.pending = undefined;
      this.manualRequested = false;
    });
    return this.pending;
  }
  private async run(now: number) {
    try {
      // Rate-limit failed automatic checks too; manual retry remains available.
      await this.host.set("updates.lastCheck", now);
      const release = selectRelease(
        await this.host.fetch(),
        this.installed,
        this.experimental,
      );
      if (this.disposed || (!this.manualRequested && !this.host.enabled()))
        return;
      if (!release) {
        if (this.manualRequested) await this.host.current();
        return;
      }
      if (
        !this.manualRequested &&
        this.host.get<string>("updates.skippedVersion") === release.version
      )
        return;
      const action = await this.host.available(release);
      if (this.disposed) return;
      if (action === "open") await this.host.open(release.url);
      else if (action === "skip")
        await this.host.set("updates.skippedVersion", release.version);
    } catch {
      if (this.manualRequested && !this.disposed) await this.host.failed();
    }
  }
  dispose() {
    this.disposed = true;
  }
}
