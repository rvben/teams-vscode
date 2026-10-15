import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(".");
const temp = await mkdtemp(join(tmpdir(), "teams-vscode-host-"));
await build({
  entryPoints: ["test/host.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["vscode"],
  outfile: ".local-research/host-test.cjs",
});
await mkdir(join(temp, "user", "User"), { recursive: true });
await mkdir(join(temp, "extensions"), { recursive: true });
await writeFile(
  join(temp, "user", "User", "settings.json"),
  JSON.stringify({
    "teamsCompanion.cliPath": process.execPath,
    "workbench.startupEditor": "none",
    "chat.disableAIFeatures": true,
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "security.workspace.trust.enabled": false,
  }),
);
try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, ".local-research/host-test.cjs"),
    extensionTestsEnv: {
      TEAMS_COMPANION_TEST_FIXTURE: join(root, "test", "fake-cli.cjs"),
    },
    launchArgs: [
      "--user-data-dir",
      join(temp, "user"),
      "--extensions-dir",
      join(temp, "extensions"),
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-telemetry",
      "--disable-updates",
      "--disable-extensions",
      // Keep webview startup deterministic when the isolated window is occluded.
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-workspace-trust",
    ],
  });
} finally {
  await rm(temp, { recursive: true, force: true });
}
