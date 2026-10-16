import { needsManagedUpgrade } from "./cli-updates";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  access,
  constants,
  realpath,
  lstat,
  rm,
  mkdtemp,
  stat,
  open,
  readdir,
} from "node:fs/promises";
import { join, delimiter, isAbsolute, resolve, relative, sep } from "node:path";
import { get } from "node:https";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";

export const CLI_VERSION = "0.2.3";
// Pin the tested release bytes independently of mutable release metadata.
export const CLI_CHECKSUMS: Readonly<Record<string, string>> = {
  "teams-cli-v0.2.3-aarch64-apple-darwin.tar.gz":
    "729548ef90db1a9e39a23a379244b170f8fef14b08e131b93191e982a6fd74f2",
  "teams-cli-v0.2.3-x86_64-apple-darwin.tar.gz":
    "86a52478d63e84f93ae661b679b91bb609a6d821a55d42a78dd960414eea861e",
  "teams-cli-v0.2.3-x86_64-pc-windows-msvc.tar.gz":
    "b96be012268e1b1d0d9fd85be912b4eaf2c50e7cd3676446c14d64badf8de51e",
  "teams-cli-v0.2.3-x86_64-unknown-linux-gnu.tar.gz":
    "1584e66a4c8159075c4dc40aa16d7058f661b2f6e372344072dabdd53c6e5af5",
};
const base = `https://github.com/rvben/teams-cli/releases/download/v${CLI_VERSION}/`;
const hosts = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
export function download(
  url: string,
  limit = 64 * 1024 * 1024,
  redirects = 0,
): Promise<Buffer> {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    !hosts.has(u.hostname) ||
    u.username ||
    u.password ||
    redirects > 5
  )
    throw new Error("Untrusted CLI download location.");
  return new Promise((resolve, reject) => {
    const req = get(
      u,
      {
        headers: {
          "User-Agent": "teams-companion",
          Accept: "application/octet-stream",
        },
      },
      (res) => {
        if (
          res.statusCode &&
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          res.resume();
          try {
            download(
              new URL(res.headers.location, u).href,
              limit,
              redirects + 1,
            ).then(resolve, reject);
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(
              "CLI download failed. Check your connection and try again.",
            ),
          );
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (b: Buffer) => {
          size += b.length;
          if (size > limit)
            res.destroy(new Error("CLI download exceeded the size limit."));
          else chunks.push(b);
        });
        res.on("error", () =>
          reject(new Error("CLI download was interrupted.")),
        );
        res.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    req.setTimeout(60_000, () =>
      req.destroy(new Error("CLI download timed out.")),
    );
    req.on("error", () =>
      reject(new Error("CLI download failed. Check your network connection.")),
    );
  });
}
export function archiveName(
  platform = process.platform,
  arch = process.arch,
): string {
  const target =
    platform === "darwin"
      ? arch === "arm64"
        ? "aarch64-apple-darwin"
        : arch === "x64"
          ? "x86_64-apple-darwin"
          : ""
      : platform === "win32" && (arch === "x64" || arch === "arm64")
        ? "x86_64-pc-windows-msvc"
        : platform === "linux" && arch === "x64"
          ? "x86_64-unknown-linux-gnu"
          : "";
  if (!target)
    throw new Error(
      "No verified native download is available for this host. Install Teams CLI yourself and select its executable.",
    );
  return `teams-cli-v${CLI_VERSION}-${target}.tar.gz`;
}
export function verifyChecksum(
  bytes: Buffer,
  sums: string,
  name: string,
): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sums.match(
    new RegExp(`^([a-fA-F0-9]{64})\\s+\\*?(?:\\./)?${escaped}$`, "m"),
  );
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (
    !match?.[1] ||
    !timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(match[1], "hex"))
  )
    throw new Error("CLI checksum verification failed. Nothing was installed.");
  return actual;
}
export async function extractExecutable(
  archive: Buffer,
  name: string,
): Promise<Buffer> {
  const tar = extract();
  let binary: Buffer | undefined;
  const done = new Promise<Buffer>((resolve, reject) => {
    tar.on("entry", (header, stream, next) => {
      const clean = header.name.replace(/^\.\//, "");
      const chunks: Buffer[] = [];
      let size = 0;
      if (clean === name && (header.type !== "file" || binary)) {
        stream.resume();
        tar.destroy(new Error("Invalid CLI archive."));
        return;
      }
      stream.on("data", (chunk: unknown) => {
        const b = Buffer.from(chunk as Uint8Array);
        if (clean === name) {
          size += b.length;
          if (size > 64 * 1024 * 1024)
            tar.destroy(new Error("Executable too large."));
          else chunks.push(b);
        }
      });
      stream.on("end", () => {
        if (clean === name) binary = Buffer.concat(chunks);
        next();
      });
      stream.on("error", reject);
    });
    tar.on("error", reject);
    tar.on("finish", () =>
      binary?.length
        ? resolve(binary)
        : reject(new Error("CLI executable missing from archive.")),
    );
  });
  try {
    tar.end(gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 }));
  } catch {
    tar.destroy(new Error("Invalid CLI archive."));
  }
  return done;
}
export interface CliSelection {
  executable: string;
  source: "managed" | "configured" | "path";
  managedVersion?: string;
}
export function managedVersion(
  executable: string,
  root: string,
): string | undefined {
  const parts = relative(resolve(root, "cli"), resolve(executable)).split(sep);
  const name = process.platform === "win32" ? "teams.exe" : "teams";
  return parts.length === 2 &&
    /^\d+\.\d+\.\d+$/.test(parts[0]!) &&
    parts[1] === name
    ? parts[0]
    : undefined;
}
export function managedPath(root: string, version = CLI_VERSION): string {
  return join(
    root,
    "cli",
    version,
    process.platform === "win32" ? "teams.exe" : "teams",
  );
}
export async function verifyManaged(
  executable: string,
  root: string,
): Promise<void> {
  const version = managedVersion(executable, root);
  if (
    !version ||
    !(await lstat(executable)).isFile() ||
    (await realpath(executable)) !== managedPath(await realpath(root), version)
  )
    throw new Error(
      "The managed CLI location could not be verified. Download the recommended CLI again.",
    );
  const [bytes, hash] = await Promise.all([
    readFile(executable),
    readFile(executable + ".sha256", "utf8"),
  ]);
  if (
    !/^[a-f0-9]{64}$/.test(hash.trim()) ||
    createHash("sha256").update(bytes).digest("hex") !== hash.trim()
  )
    throw new Error(
      "The managed CLI checksum changed. Download the recommended CLI again.",
    );
  await access(executable, constants.X_OK);
}
export class InstallBusy extends Error {}

async function installationLock(parent: string): Promise<() => Promise<void>> {
  const path = join(parent, ".install.lock");
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(token);
      } finally {
        await file.close();
      }
      return async () => {
        if ((await readFile(path, "utf8").catch(() => "")) === token)
          await rm(path, { force: true }).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > 120_000) {
        const stale = path + "." + token;
        try {
          await rename(path, stale);
          await rm(stale, { force: true });
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new InstallBusy(
    "Another window is installing Teams CLI. Try again shortly.",
  );
}
export interface InstallOptions {
  download?: typeof download;
  verify?: (executable: string) => Promise<void>;
  checksum?: string;
  reuse?: boolean;
}
export async function installCli(
  root: string,
  options: InstallOptions = {},
): Promise<string> {
  if (options.reuse !== false) {
    const cached = managedPath(root);
    try {
      await verifyManaged(cached, root);
      await options.verify?.(cached);
      return cached;
    } catch {}
  }
  const name = archiveName(),
    fetch = options.download ?? download;
  const archive = await fetch(base + name);
  verifyChecksum(
    archive,
    `${options.checksum ?? CLI_CHECKSUMS[name]}  ${name}`,
    name,
  );
  const exe = process.platform === "win32" ? "teams.exe" : "teams";
  const binary = await extractExecutable(archive, exe);
  const parent = join(root, "cli");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, ".download-"));
  const staged = join(staging, exe),
    destination = join(parent, CLI_VERSION);
  let unlock: (() => Promise<void>) | undefined;
  let quarantine: string | undefined;
  let published = false;
  try {
    await writeFile(staged, binary, { mode: 0o700, flag: "wx" });
    await chmod(staged, 0o700);
    await writeFile(
      staged + ".sha256",
      createHash("sha256").update(binary).digest("hex"),
      { mode: 0o600, flag: "wx" },
    );
    await options.verify?.(staged);
    unlock = await installationLock(parent);
    // Retire abandoned staging/recovery directories after interrupted installs.
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !/^\.download-[A-Za-z0-9]+(?:\.stale)?$/.test(entry.name)
      )
        continue;
      const abandoned = join(parent, entry.name);
      const info = await stat(abandoned).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > 60 * 60 * 1000)
        await rm(abandoned, {
          recursive: true,
          force: true,
          maxRetries: 1,
          retryDelay: 100,
        }).catch(() => {});
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(staging, destination);
        break;
      } catch (error) {
        if (attempt >= 6)
          throw new Error(
            "The CLI installation is locked or its permissions prevent changes. Close other Teams Companion windows, check storage permissions, then retry. Your current CLI was kept.",
          );
        const exists = await stat(destination).then(
          () => true,
          () => false,
        );
        if (exists) {
          let valid = false;
          try {
            await verifyManaged(join(destination, exe), root);
            valid = true;
          } catch {}
          if (valid) {
            if (
              createHash("sha256")
                .update(await readFile(join(destination, exe)))
                .digest("hex") !==
              createHash("sha256").update(binary).digest("hex")
            )
              throw new Error(
                "The installed CLI differs from this verified release. It was left untouched.",
              );
            break;
          }
          // Recover a partial legacy install without overwriting a live binary.
          // A locked Windows directory stays untouched and is retried below.
          try {
            await rename(destination, staging + ".stale");
            quarantine = staging + ".stale";
          } catch {}
        } else if (
          ![
            "ENOENT",
            "EPERM",
            "EACCES",
            "EBUSY",
            "EEXIST",
            "ENOTEMPTY",
          ].includes((error as NodeJS.ErrnoException).code ?? "")
        ) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 100 * (attempt + 1)),
        );
      }
    }
    published = true;
    return join(destination, exe);
  } finally {
    if (published && quarantine)
      await rm(quarantine, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }).catch(() => {});
    await unlock?.();
    await rm(staging, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    }).catch(() => {});
  }
}
export async function resolveCliSelection(
  configured: string,
  root: string,
  saved?: { configured: string; executable: string },
): Promise<CliSelection> {
  const originalVersion =
    configured && isAbsolute(configured) && managedVersion(configured, root);
  const savedVersion = saved && managedVersion(saved.executable, root);
  if (
    originalVersion &&
    saved?.configured === configured &&
    savedVersion &&
    needsManagedUpgrade(originalVersion, savedVersion)
  ) {
    try {
      return await resolveCliSelection(saved.executable, root);
    } catch {}
  }
  if (configured) {
    if (!isAbsolute(configured))
      throw new Error(
        "Select an absolute path to a trusted Teams CLI executable.",
      );
    const version = managedVersion(configured, root);
    if (version) {
      await verifyManaged(configured, root);
      return {
        executable: configured,
        source: "managed",
        managedVersion: version,
      };
    }
    await access(configured, constants.X_OK);
    return { executable: configured, source: "configured" };
  }
  const name = process.platform === "win32" ? "teams.exe" : "teams";
  for (const dir of (process.env.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)) {
    const executable = join(dir, name);
    try {
      await access(executable, constants.X_OK);
      const version = managedVersion(executable, root);
      if (version) {
        await verifyManaged(executable, root);
        return { executable, source: "managed", managedVersion: version };
      }
      return { executable, source: "path" };
    } catch {}
  }
  const cached = managedPath(root);
  try {
    await verifyManaged(cached, root);
    return {
      executable: cached,
      source: "managed",
      managedVersion: CLI_VERSION,
    };
  } catch {
    throw new Error(
      "Teams CLI was not found. Select an executable or download the verified CLI.",
    );
  }
}
export async function resolveCli(
  configured: string,
  root: string,
): Promise<string> {
  return (await resolveCliSelection(configured, root)).executable;
}
