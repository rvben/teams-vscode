import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const file = `${manifest.name}-${manifest.version}.vsix`;
const bytes = await readFile(file),
  zip = await JSZip.loadAsync(bytes);
const allowed = new Set([
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/THIRD_PARTY_NOTICES.md",
  "extension/changelog.md",
  "extension/package.json",
  "extension/readme.md",
  "extension/dist/conversation.css",
  "extension/dist/conversation.js",
  "extension/dist/extension.js",
  "extension/dist/sidebar.js",
  "extension/dist/sidebar.css",
  "extension/media/teams.svg",
]);
const files = Object.values(zip.files).filter((f) => !f.dir);
for (const entry of files)
  if (!allowed.has(entry.name))
    throw new Error("Unexpected file in VSIX: " + entry.name);
for (const path of allowed)
  if (!zip.files[path]) throw new Error("Missing file: " + path);
const packagedManifest = JSON.parse(
  await zip.files["extension/package.json"].async("string"),
);
if (
  packagedManifest.name !== manifest.name ||
  packagedManifest.publisher !== manifest.publisher ||
  packagedManifest.version !== manifest.version ||
  packagedManifest.preview !== true
)
  throw new Error("Experimental extension manifest mismatch.");
const vsixManifest = await zip.files["extension.vsixmanifest"].async("string");
const galleryFlags =
  vsixManifest
    .match(/<GalleryFlags>([^<]*)<\/GalleryFlags>/)?.[1]
    .split(/\s+/) ?? [];
if (
  !vsixManifest.includes(
    'Id="Microsoft.VisualStudio.Code.PreRelease" Value="true"',
  ) ||
  !galleryFlags.includes("Preview")
)
  throw new Error("VSIX must be marked as a preview and pre-release.");
for (const name of [
  "extension.js",
  "conversation.js",
  "conversation.css",
  "sidebar.js",
  "sidebar.css",
]) {
  const packaged =
    await zip.files["extension/dist/" + name].async("nodebuffer");
  if (!packaged.equals(await readFile("dist/" + name)))
    throw new Error("Bundle mismatch: " + name);
  const text = packaged.toString("utf8");
  if (
    text.includes("/Users/") ||
    text.includes("/private/tmp/") ||
    text.includes("synthetic-chat-")
  )
    throw new Error("Private or fixture material in bundle.");
}
console.log(
  JSON.stringify({
    file,
    files: files.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    preRelease: true,
    verified: true,
  }),
);
