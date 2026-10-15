import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import {
  archiveName,
  verifyChecksum,
  extractExecutable,
  download,
} from "../src/installer";

test("downloads select the local host and reject unsupported architectures", () => {
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
