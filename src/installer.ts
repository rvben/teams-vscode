import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  access,
  constants,
} from "node:fs/promises";
import { join, delimiter, isAbsolute } from "node:path";
import { get } from "node:https";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";

export const CLI_VERSION = "0.3.0";
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
          "User-Agent": "teams-companion/0.1.0",
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
export async function installCli(root: string): Promise<string> {
  const name = archiveName();
  const [archive, sums] = await Promise.all([
    download(base + name),
    download(base + "SHA256SUMS", 1024 * 1024),
  ]);
  verifyChecksum(archive, sums.toString("utf8"), name);
  const exe = process.platform === "win32" ? "teams.exe" : "teams";
  const binary = await extractExecutable(archive, exe);
  const dir = join(root, "cli", CLI_VERSION);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, exe);
  const temp = target + "." + process.pid + ".tmp";
  await writeFile(temp, binary, { mode: 0o700 });
  await chmod(temp, 0o700);
  await rename(temp, target);
  await writeFile(
    target + ".sha256",
    createHash("sha256").update(binary).digest("hex"),
    { mode: 0o600 },
  );
  return target;
}
export async function resolveCli(
  configured: string,
  root: string,
): Promise<string> {
  if (configured) {
    if (!isAbsolute(configured))
      throw new Error(
        "Select an absolute path to a trusted Teams CLI executable.",
      );
    await access(configured, constants.X_OK);
    return configured;
  }
  const name = process.platform === "win32" ? "teams.exe" : "teams";
  // Never execute a workspace-relative PATH entry in an untrusted workspace.
  for (const dir of (process.env.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)) {
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  const cached = join(root, "cli", CLI_VERSION, name);
  try {
    const [bytes, hash] = await Promise.all([
      readFile(cached),
      readFile(cached + ".sha256", "utf8"),
    ]);
    if (createHash("sha256").update(bytes).digest("hex") !== hash.trim())
      throw new Error("hash");
    return cached;
  } catch {
    throw new Error(
      "Teams CLI was not found. Select an executable or download the verified CLI.",
    );
  }
}
