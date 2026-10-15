import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await Promise.all([
  build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    external: ["vscode"],
    outfile: "dist/extension.js",
    sourcemap: false,
  }),
  build({
    entryPoints: ["src/webview/index.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    outfile: "dist/conversation.js",
    sourcemap: false,
  }),
  build({
    entryPoints: ["src/webview/sidebar.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    outfile: "dist/sidebar.js",
    sourcemap: false,
  }),
  copyFile("media/conversation.css", "dist/conversation.css"),
  copyFile("media/sidebar.css", "dist/sidebar.css"),
]);
