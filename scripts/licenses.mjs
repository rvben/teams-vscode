import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const sections = [
  "# Third-party notices\n\nRuntime dependencies bundled in Teams Companion.",
];
for (const [path, p] of Object.entries(lock.packages)) {
  if (!path || p.dev || p.devOptional) continue;
  const files = await readdir(path);
  const license = files.find((f) => /^licen[sc]e(?:\.md|\.txt)?$/i.test(f));
  if (!license) throw new Error("Runtime license missing for " + path);
  const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  sections.push(
    `## ${pkg.name} ${pkg.version}\n\n${await readFile(join(path, license), "utf8")}`,
  );
}
await writeFile("THIRD_PARTY_NOTICES.md", sections.join("\n\n"));
