import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { html } from "./webview";
import {
  SidebarAction,
  SidebarState,
  validSidebarAction,
} from "./sidebar-model";

export class Sidebar implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private state?: SidebarState;
  readonly scope = randomUUID();
  ready = false;
  constructor(
    private root: vscode.Uri,
    private action: (message: SidebarAction) => Promise<void>,
    private failure: () => void,
  ) {}
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.root, "dist")],
    };
    const receive = view.webview.onDidReceiveMessage((value) => {
      if (!validSidebarAction(value, this.scope)) return;
      if (value.type === "ready") {
        this.ready = true;
        this.post();
        return;
      }
      void this.action(value).catch(this.failure);
    });
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) this.post();
    });
    view.onDidDispose(() => {
      receive.dispose();
      visibility.dispose();
      this.ready = false;
      this.view = undefined;
    });
    view.webview.html = html(view.webview, this.root, this.scope, "sidebar");
  }
  get visible() {
    return this.view?.visible === true;
  }
  get layout() {
    return this.state?.layout;
  }
  update(state: Omit<SidebarState, "scope">) {
    this.state = { ...state, scope: this.scope };
    this.post();
  }
  private post() {
    if (this.ready && this.state)
      void this.view?.webview.postMessage({
        type: "sidebarState",
        state: this.state,
      });
  }
}
