import http from "node:http";
import { readFile } from "node:fs/promises";
const files = {
  "/conversation.js": ["dist/conversation.js", "text/javascript"],
  "/conversation.css": ["dist/conversation.css", "text/css"],
  "/sidebar.js": ["dist/sidebar.js", "text/javascript"],
  "/sidebar.css": ["dist/sidebar.css", "text/css"],
};
const themes = {
  dark: {
    "editor-background": "#1f1f1f",
    "editor-foreground": "#cccccc",
    descriptionForeground: "#b0b0b0",
    "panel-border": "#454545",
    "button-background": "#0078d4",
    "button-foreground": "#ffffff",
    "button-hoverBackground": "#026ec1",
    "button-secondaryBackground": "#313131",
    "button-secondaryForeground": "#cccccc",
    "button-secondaryHoverBackground": "#3c3c3c",
    "input-background": "#313131",
    "input-foreground": "#cccccc",
    "input-placeholderForeground": "#b0b0b0",
    "input-border": "#555555",
    focusBorder: "#007fd4",
    errorForeground: "#f48771",
    "inputValidation-warningBackground": "#352a05",
    "inputValidation-warningBorder": "#b89500",
    "scrollbarSlider-background": "#6a6a6a",
    "editor-selectionBackground": "#264f78",
  },
  light: {
    "editor-background": "#ffffff",
    "editor-foreground": "#333333",
    descriptionForeground: "#595959",
    "panel-border": "#d1d1d1",
    "button-background": "#005fb8",
    "button-foreground": "#ffffff",
    "button-hoverBackground": "#0258a8",
    "button-secondaryBackground": "#e5e5e5",
    "button-secondaryForeground": "#333333",
    "button-secondaryHoverBackground": "#cccccc",
    "input-background": "#ffffff",
    "input-foreground": "#333333",
    "input-placeholderForeground": "#666666",
    "input-border": "#cecece",
    focusBorder: "#005fb8",
    errorForeground: "#a1260d",
    "inputValidation-warningBackground": "#fff9db",
    "inputValidation-warningBorder": "#a18600",
    "scrollbarSlider-background": "#aaaaaa",
    "editor-selectionBackground": "#add6ff",
  },
};
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (files[url.pathname]) {
      const [file, type] = files[url.pathname];
      res.setHeader("Content-Type", type);
      res.end(await readFile(file));
      return;
    }
    const surface = url.pathname === "/sidebar" ? "sidebar" : "conversation";
    const label = surface === "sidebar" ? "Teams chats" : "Teams conversation";
    const theme = themes[url.searchParams.get("theme")] ?? themes.dark;
    const sidebarTokens = {
      // Some installed themes give chat requests the editor's background.
      "chat-requestBackground": theme["editor-background"],
      "sideBar-background": theme["editor-background"],
      "sideBar-foreground": theme["editor-foreground"],
      "badge-background": theme["button-secondaryBackground"],
      "badge-foreground": theme["button-secondaryForeground"],
      "list-hoverBackground": theme["button-secondaryHoverBackground"],
      "list-inactiveSelectionBackground": theme["button-secondaryBackground"],
      "list-activeSelectionBackground": theme["button-background"],
      "list-activeSelectionForeground": theme["button-foreground"],
    };
    const vars = Object.entries({ ...theme, ...sidebarTokens })
      .map(([k, v]) => `--vscode-${k}:${v}`)
      .join(";");
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic Teams fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{${vars};--vscode-font-family:system-ui;--vscode-font-size:13px}</style><link rel="stylesheet" href="/${surface}.css"></head><body data-scope="fixture"><main id="app" aria-label="${label}"></main><script>window.sent=[];window.saved=undefined;window.acquireVsCodeApi=()=>({postMessage:m=>window.sent.push(m),getState:()=>window.saved,setState:s=>{window.saved=s}});</script><script src="/${surface}.js"></script></body></html>`,
    );
  })
  .listen(43829, "127.0.0.1");
