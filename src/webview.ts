import * as vscode from "vscode";
import { randomBytes } from "node:crypto";

export function html(
  webview: vscode.Webview,
  root: vscode.Uri,
  scope: string,
  surface: "conversation" | "sidebar" = "conversation",
): string {
  const nonce = randomBytes(18).toString("base64");
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(root, "dist", `${surface}.js`),
  );
  const css = webview.asWebviewUri(
    vscode.Uri.joinPath(root, "dist", `${surface}.css`),
  );
  const title = surface === "sidebar" ? "Teams chats" : "Teams conversation";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src data:; connect-src 'none'; font-src 'none';"><link rel="stylesheet" href="${css}"><title>${title}</title></head><body data-scope="${scope}"><main id="app" aria-label="${title}"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
export const inbound = new Set([
  "ready",
  "draft",
  "send",
  "refresh",
  "older",
  "check",
  "acknowledge",
  "enableReplies",
  "openTeams",
  "connect",
  "selectAccount",
  "connection",
]);
export function validInbound(
  value: unknown,
  scope: string,
): value is { type: string; scope: string; text?: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.scope === scope &&
    typeof v.type === "string" &&
    inbound.has(v.type) &&
    (v.type !== "draft" ||
      (typeof v.text === "string" && v.text.length <= 32_000))
  );
}
