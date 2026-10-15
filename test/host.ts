import * as vscode from "vscode";
import assert from "node:assert/strict";
export async function run() {
  const extension = vscode.extensions.getExtension("rvben.teams-companion");
  assert(extension, "Extension discovered");
  const api = await extension.activate();
  await api.settled();
  assert.deepEqual(api.snapshot(), {
    profile: "personal-demo",
    chats: 2,
    tabs: 0,
    ready: true,
  });
  assert.deepEqual(
    api.connection(),
    { state: "connected", busy: false },
    "Metadata status is shown without any desktop mutation",
  );
  assert.equal(
    api.accounts().active,
    "Personal account",
    "Account type comes from resolved configuration, not the profile name",
  );
  assert.equal(api.accounts().canSwitchProfile, true);
  process.env.TEAMS_COMPANION_TEST_SIGNED_OUT = "1";
  await vscode.commands.executeCommand("teams.refresh");
  assert.equal(
    api.accounts().canSwitchProfile,
    false,
    "A signed-out saved Graph profile does not create an account choice",
  );
  delete process.env.TEAMS_COMPANION_TEST_SIGNED_OUT;
  process.env.TEAMS_COMPANION_TEST_AUTH_UNVERIFIED = "1";
  await vscode.commands.executeCommand("teams.refresh");
  assert.equal(
    api.accounts().canSwitchProfile,
    false,
    "Stored credentials without verified account access do not create an account choice",
  );
  delete process.env.TEAMS_COMPANION_TEST_AUTH_UNVERIFIED;
  process.env.TEAMS_COMPANION_TEST_AUTH_UNKNOWN = "1";
  await vscode.commands.executeCommand("teams.refresh");
  assert.equal(
    api.accounts().canSwitchProfile,
    false,
    "Unverified inactive profiles stay in Connection without adding a main-view chooser",
  );
  delete process.env.TEAMS_COMPANION_TEST_AUTH_UNKNOWN;
  await vscode.commands.executeCommand("teams.refresh");
  assert.equal(
    api.accounts().canSwitchProfile,
    true,
    "Account chooser returns after another profile signs in",
  );
  const contribution = extension.packageJSON.contributes;
  assert(
    contribution.commands.some(
      (c: { command: string }) => c.command === "teams.newMessage",
    ),
    "New Message command contributed",
  );
  assert(
    (await vscode.commands.getCommands()).includes("teams.newMessage"),
    "New Message command registered",
  );
  assert.deepEqual(
    contribution.menus["view/title"]
      .filter(
        (item: { when: string; group: string }) =>
          item.when === "view == teams.chats" &&
          item.group.startsWith("navigation@"),
      )
      .map((item: { command: string }) => item.command),
    ["teams.newMessage", "teams.refresh"],
    "Chats has one native compose/refresh toolbar; search stays in its own row",
  );
  assert(
    (await vscode.commands.getCommands()).includes("teams.selectSidebarLayout"),
    "Layout remains available as a native command",
  );
  assert(
    contribution.views.teams.some(
      (v: { id: string }) => v.id === "teams.connection",
    ),
    "Visible native Connection section",
  );
  assert(
    contribution.viewsWelcome.some(
      (v: { view: string; contents: string; when: string }) =>
        v.view === "teams.connection" &&
        v.when.includes("graph") &&
        v.contents.includes("[Connect Teams Desktop](command:teams.connect)"),
    ),
    "Graph profiles have a direct desktop connection button",
  );
  assert(
    contribution.viewsWelcome.some(
      (v: { view: string; contents: string; when: string }) =>
        v.view === "teams.connection" &&
        v.when.includes("connected") &&
        v.contents.includes(
          "[Disconnect Teams Desktop](command:teams.disconnect)",
        ),
    ),
    "Open desktop connections have a direct disconnect button",
  );
  const commands = await vscode.commands.getCommands(true);
  for (const c of [
    "teams.refresh",
    "teams.openChat",
    "teams.setup",
    "teams.connect",
    "teams.downloadCli",
  ])
    assert(commands.includes(c));
  await vscode.commands.executeCommand("teams.chats.focus");
  const sidebarDeadline = Date.now() + 10_000;
  while (!api.sidebarReady() && Date.now() < sidebarDeadline)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    api.sidebarReady(),
    true,
    "Sidebar WebviewView bundle completes the native host handshake",
  );
  assert(
    contribution.views.teams.some(
      (v: { id: string; type?: string }) =>
        v.id === "teams.chats" && v.type === "webview",
    ),
    "Chat sidebar is a webview view",
  );
  await api.openFirst();
  assert.equal(api.snapshot().tabs, 1);
  assert.deepEqual(
    api.conversationPhotos(),
    [{ profile: "personal-demo", photos: 1 }],
    "Member photos survive the real CLI normalization and conversation path",
  );
  const deadline = Date.now() + 10_000;
  while (!api.webviewsReady() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    api.webviewsReady(),
    1,
    "Real webview bundle loads and completes message handshake",
  );
  assert(
    vscode.window.tabGroups.all.some((g) =>
      g.tabs.some((t) => t.label.includes("Synthetic conversation")),
    ),
    "Conversation opens in an editor tab",
  );
  await vscode.commands.executeCommand("teams.refresh");
  await api.settled();
  assert.equal(api.snapshot().chats, 2);
  process.env.TEAMS_COMPANION_TEST_PAGES = "1";
  await vscode.commands.executeCommand("teams.refresh");
  assert.equal(api.snapshot().chats, 50);
  await vscode.commands.executeCommand("teams.loadMoreChats");
  assert.equal(api.snapshot().chats, 100);
  await vscode.commands.executeCommand("teams.refresh");
  assert.equal(
    api.snapshot().chats,
    100,
    "Refresh preserves the loaded pagination range",
  );
  delete process.env.TEAMS_COMPANION_TEST_PAGES;
  await vscode.commands.executeCommand("teams.refresh");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await api.openFirst();
  assert.equal(api.snapshot().tabs, 1, "Reopening reuses session");
  await api.selectProfile("work-demo");
  assert.equal(api.snapshot().profile, "work-demo");
  assert.equal(
    api.connection().state,
    "graph",
    "Switching profile updates the visible connection actions",
  );
  await api.openFirst();
  assert.equal(
    api.snapshot().tabs,
    2,
    "Same chat ID in a different profile receives a separate tab",
  );
  assert(
    vscode.window.tabGroups.all.some((g) =>
      g.tabs.some((t) => t.label.includes("Work or school")),
    ),
  );
  assert.deepEqual(
    api.accounts().tabs,
    [
      { profile: "personal-demo", label: "Personal account" },
      { profile: "work-demo", label: "Work or school" },
    ],
    "Existing tabs retain their account context when the active connection changes",
  );
  const config = vscode.workspace.getConfiguration("teamsCompanion");
  assert.equal(config.get("repliesEnabled"), false, "Replies default off");
  const beforeLayout = api.snapshot();
  await config.update(
    "sidebarLayout",
    "compact",
    vscode.ConfigurationTarget.Global,
  );
  const layoutDeadline = Date.now() + 5_000;
  while (api.sidebarLayout() !== "compact" && Date.now() < layoutDeadline)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    api.sidebarLayout(),
    "compact",
    "Global layout choice reaches sidebar immediately",
  );
  assert.deepEqual(
    api.snapshot(),
    beforeLayout,
    "Changing sidebar layout keeps profile, conversations and editor sessions intact",
  );
  await config.update(
    "sidebarLayout",
    "teams",
    vscode.ConfigurationTarget.Global,
  );
  const extKind = extension.extensionKind;
  assert.equal(
    extKind,
    vscode.ExtensionKind.UI,
    "CLI executes in local UI extension host",
  );
  process.env.TEAMS_COMPANION_TEST_MIXED_ACCOUNTS = "1";
  await api.selectProfile("personal-demo");
  assert.equal(
    api.connection().state,
    "account",
    "Open endpoint plus ambiguous history produces an account choice, not a disconnected state",
  );
  await api.refreshTabs();
  assert(
    api.recoveries().includes("selectAccount"),
    "Real subprocess ambiguity reaches the conversation recovery state",
  );
  delete process.env.TEAMS_COMPANION_TEST_MIXED_ACCOUNTS;
  await vscode.commands.executeCommand("teams.refresh");
  await api.refreshTabs();
  assert.equal(api.connection().state, "connected");
  assert.deepEqual(
    api.recoveries(),
    [],
    "Successful history reads clear previous account errors",
  );
  console.log("Teams Companion extension-host checks passed.");
}
