import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import {
  archiveName,
  CLI_CHECKSUMS,
  verifyChecksum,
  extractExecutable,
  download,
} from "../src/installer";

test("downloads select the local host and reject unsupported architectures", () => {
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
    ["linux", "x64"],
  ] as const)
    assert.match(
      CLI_CHECKSUMS[archiveName(platform, arch)]!,
      /^[a-f0-9]{64}$/,
      "Every supported release target has a pinned archive hash",
    );
  assert.match(archiveName("darwin", "arm64"), /aarch64-apple/);
  assert.match(archiveName("win32", "x64"), /windows/);
  assert.throws(() => archiveName("linux", "arm64"));
  assert.throws(() => download("http://github.com/test"));
  assert.throws(() => download("https://example.com/test"));
});
test("checksum validation rejects mismatches and missing entries", () => {
  const data = Buffer.from("synthetic executable"),
    hash = createHash("sha256").update(data).digest("hex");
  assert.equal(
    verifyChecksum(data, `${hash}  ./teams.tar.gz`, "teams.tar.gz"),
    hash,
  );
  assert.throws(() =>
    verifyChecksum(data, `${"0".repeat(64)}  teams.tar.gz`, "teams.tar.gz"),
  );
  assert.throws(() =>
    verifyChecksum(data, `${hash}  other.tar.gz`, "teams.tar.gz"),
  );
});
async function archive(
  entries: {
    name: string;
    content?: string;
    type?: "file" | "symlink";
    linkname?: string;
  }[],
) {
  const p = pack(),
    parts: Buffer[] = [];
  p.on("data", (b) => parts.push(Buffer.from(b as Uint8Array)));
  for (const entry of entries)
    p.entry(
      {
        name: entry.name,
        type: entry.type ?? "file",
        linkname: entry.linkname,
      },
      entry.content ?? "",
    );
  p.finalize();
  await new Promise<void>((r) => p.on("end", () => r()));
  return gzipSync(Buffer.concat(parts));
}
test("extracts only the exact regular executable without writing archive paths", async () => {
  const data = await archive([
    { name: "../../escape", content: "evil" },
    { name: "./teams", content: "good" },
  ]);
  assert.equal((await extractExecutable(data, "teams")).toString(), "good");
  await assert.rejects(
    extractExecutable(
      await archive([{ name: "teams", type: "symlink", linkname: "/bin/sh" }]),
      "teams",
    ),
  );
  await assert.rejects(
    extractExecutable(
      await archive([{ name: "other", content: "missing" }]),
      "teams",
    ),
  );
});

test("legacy managed selections are recognized and verified without taking over user executables", async () => {
  const { mkdtemp, mkdir, writeFile, rm, symlink } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { managedVersion, managedPath, resolveCliSelection } =
    await import("../src/installer.js");
  const root = await mkdtemp(join(tmpdir(), "teams-managed-cli-"));
  try {
    const path = managedPath(root, "0.2.2");
    await mkdir(join(root, "cli", "0.2.2"), { recursive: true });
    const bytes = Buffer.from("old verified CLI");
    await writeFile(path, bytes, { mode: 0o700 });
    await writeFile(
      path + ".sha256",
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(await resolveCliSelection(path, root), {
      executable: path,
      source: "managed",
      managedVersion: "0.2.2",
    });
    const next = managedPath(root);
    await mkdir(join(root, "cli", "0.2.3"));
    await writeFile(next, bytes, { mode: 0o700 });
    await writeFile(
      next + ".sha256",
      createHash("sha256").update(bytes).digest("hex"),
    );
    const saved = { configured: path, executable: next };
    assert.equal(
      (await resolveCliSelection(path, root, saved)).executable,
      next,
    );
    await rm(path);
    assert.equal(
      (await resolveCliSelection(path, root, saved)).executable,
      next,
      "A remembered upgrade survives removal of its obsolete original binary",
    );
    await writeFile(path, bytes, { mode: 0o700 });
    const custom = join(root, "custom-cli");
    await writeFile(custom, "user CLI", { mode: 0o700 });
    assert.equal(
      (await resolveCliSelection(custom, root)).source,
      "configured",
    );
    assert.equal(
      (
        await resolveCliSelection(custom, root, {
          configured: custom,
          executable: next,
        })
      ).source,
      "configured",
      "Remembered upgrades never override a user-owned executable",
    );
    assert.equal(
      managedVersion(join(root, "cli", "nested", "0.2.2", "teams"), root),
      undefined,
    );
    await writeFile(path, "modified");
    await assert.rejects(resolveCliSelection(path, root), /checksum changed/);
    if (process.platform !== "win32") {
      const linked = managedPath(root, "0.2.1");
      await mkdir(join(root, "cli", "0.2.1"));
      await symlink(custom, linked);
      await assert.rejects(
        resolveCliSelection(linked, root),
        /location could not be verified/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified installs are staged, validated before selection, and immutable across windows", async () => {
  const { mkdtemp, readFile, rm, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { installCli, archiveName, managedPath, resolveCliSelection } =
    await import("../src/installer.js");
  const root = await mkdtemp(join(tmpdir(), "teams-cli-install-"));
  try {
    const name = process.platform === "win32" ? "teams.exe" : "teams";
    const bytes = await archive([{ name, content: "verified CLI" }]);
    const sum = createHash("sha256").update(bytes).digest("hex");
    const download = async (url: string) =>
      url.endsWith("SHA256SUMS")
        ? Buffer.from(`${sum}  ${archiveName()}`)
        : bytes;
    await assert.rejects(installCli(root, { download }), /checksum/);
    await assert.rejects(
      installCli(root, {
        download,
        checksum: sum,
        verify: async () => {
          throw new Error("incompatible");
        },
      }),
      /incompatible/,
    );
    await assert.rejects(readFile(managedPath(root)));
    assert.deepEqual(await readdir(join(root, "cli")), []);
    let verified = 0;
    const verify = async (path: string) => {
      assert.equal(await readFile(path, "utf8"), "verified CLI");
      verified++;
    };
    const [one, two] = await Promise.all([
      installCli(root, { download, checksum: sum, verify }),
      installCli(root, { download, checksum: sum, verify }),
    ]);
    assert.equal(one, two);
    assert.equal(verified, 2);
    assert.equal((await resolveCliSelection(one, root)).source, "managed");
    assert.deepEqual(await readdir(join(root, "cli")), ["0.2.3"]);
    const changed = await archive([{ name, content: "different bytes" }]);
    const different = async (url: string) =>
      url.endsWith("SHA256SUMS")
        ? Buffer.from(
            `${createHash("sha256").update(changed).digest("hex")}  ${archiveName()}`,
          )
        : changed;
    await assert.rejects(
      installCli(root, {
        download: different,
        reuse: false,
        checksum: createHash("sha256").update(changed).digest("hex"),
        verify,
      }),
      /expected|differs|verified CLI/,
    );
    assert.equal(await readFile(one, "utf8"), "verified CLI");
    assert.equal(
      await installCli(root, {
        download: async () => {
          throw new Error("No network permitted");
        },
        verify,
      }),
      one,
    );
    const { writeFile } = await import("node:fs/promises");
    await writeFile(one + ".sha256", "interrupted legacy install");
    const repaired = await Promise.all([
      installCli(root, { download, checksum: sum, verify }),
      installCli(root, { download, checksum: sum, verify }),
    ]);
    assert.deepEqual(repaired, [one, one]);
    assert.equal((await resolveCliSelection(one, root)).source, "managed");
    assert.deepEqual(
      await readdir(join(root, "cli")),
      ["0.2.3"],
      "Successful concurrent repairs remove recovery material and their lock",
    );
    const { utimes } = await import("node:fs/promises");
    const { mkdir } = await import("node:fs/promises");
    const abandoned = join(root, "cli", ".download-abandoned.stale");
    await mkdir(abandoned);
    const abandonedTime = new Date(Date.now() - 7_200_000);
    await utimes(abandoned, abandonedTime, abandonedTime);
    const lock = join(root, "cli", ".install.lock");
    await writeFile(lock, "interrupted process");
    const old = new Date(Date.now() - 180_000);
    await utimes(lock, old, old);
    assert.equal(
      await installCli(root, { download, checksum: sum, verify, reuse: false }),
      one,
    );
    assert.deepEqual(
      await readdir(join(root, "cli")),
      ["0.2.3"],
      "An abandoned publication lock is recovered",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
