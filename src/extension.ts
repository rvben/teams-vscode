import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { Cli, CliError } from "./cli";
import { joinBrowsers } from "./cli-handoff";
import {
  Chat,
  Profile,
  chat,
  page,
  profiles,
  obj,
  str,
  accountLabel,
} from "./models";
import {
  resolveCliSelection,
  managedVersion,
  verifyManaged,
  installCli,
  InstallBusy,
  CLI_VERSION,
  type CliSelection,
} from "./installer";
import {
  CliUpgrade,
  needsManagedUpgrade,
  type CliUpdateState,
} from "./cli-updates";
import { PendingStore } from "./pending";
import {
  searchRecipients,
  createConversation,
  type Recipient,
} from "./recipients";
import { Conversation } from "./session";
import { html, validInbound } from "./webview";
import type { ViewState } from "./protocol";
import { Sidebar } from "./sidebar";
import { sidebarLayout } from "./sidebar-model";
import { withMemberAvatars } from "./conversation-model";
import {
  GuidedSetup,
  completedProfile,
  supportsGuidedSetup,
} from "./guided-setup";
import { UpdateChecker, fetchReleases } from "./updates";
import {
  DesktopActions,
  desktopState,
  closedNativeSession,
  newDesktopProfileName,
  accountProfileArgs,
  accountProfileName,
} from "./desktop";

interface Tab {
  session: Conversation;
  chat: Chat;
  token: string;
  panel?: vscode.WebviewPanel;
  timer?: NodeJS.Timeout;
  failures: number;
  retryAt?: number;
  ready?: boolean;
}
const settings = () => vscode.workspace.getConfiguration("teamsCompanion");
let shutdown: (() => Promise<void>) | undefined;
export async function deactivate(): Promise<void> {
  await shutdown?.();
}
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Teams Companion");
  context.subscriptions.push(output);
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    30,
  );
  status.command = "teams.selectProfile";
  status.text = "$(comment-discussion) Teams";
  status.tooltip = "Select a Teams profile";
  status.show();
  context.subscriptions.push(status);
  let cli: Cli | undefined,
    cliPromise: Promise<Cli> | undefined,
    version = "",
    cliSelection: CliSelection | undefined,
    cliUpdateState: CliUpdateState = "idle",
    cliChange = 0,
    setupTerminals = 0,
    active: Profile | undefined,
    allProfiles: Profile[] = [],
    availableProfiles: Profile[] = [],
    chats: Chat[] = [],
    cursor = "",
    generation = 0,
    loadAbort: AbortController | undefined,
    loading = false,
    ready = false,
    connectionState = "checking",
    connectionBusy = false,
    browserConnection = false,
    sidebarError = "",
    sidebarCached = false,
    selectedChat = "";
  const newChatStore = new PendingStore(
    vscode.Uri.joinPath(context.globalStorageUri, "pending-chats").fsPath,
  );
  let recipientPicker:
    | vscode.QuickPick<vscode.QuickPickItem & { recipient?: Recipient }>
    | undefined;
  const store = new PendingStore(
    vscode.Uri.joinPath(context.globalStorageUri, "pending").fsPath,
  );
  let sidebarTimer: NodeJS.Timeout | undefined;
  let disposed = false;
  const usedClis = new Set<Cli>();
  const tabs = new Map<string, Tab>();
  const drafts = new Map<string, string>();
  const cliDetailsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(cliDetailsChanged);
  function cliRows(): vscode.TreeItem[] {
    const item = new vscode.TreeItem("Teams CLI");
    item.description = version
      ? `${version} · ${cliSelection?.source === "managed" ? "Extension-managed" : "Managed by you"}`
      : "Not selected";
    item.iconPath = new vscode.ThemeIcon("terminal");
    item.command = { command: "teams.manageCli", title: "Manage Teams CLI" };
    const source =
      cliSelection?.source === "managed"
        ? "Managed by Teams Companion"
        : cliSelection?.source === "path"
          ? "From PATH · Managed by you"
          : "Selected executable · Managed by you";
    item.tooltip = cliSelection
      ? `${source}\n${cliSelection.executable}\nRecommended: ${CLI_VERSION}`
      : "Select an executable or download the recommended CLI.";
    const rows = [item];
    if (cliUpdateState !== "idle") {
      const update = new vscode.TreeItem(
        cliUpdateState === "downloading"
          ? "Preparing CLI update"
          : cliUpdateState === "pending"
            ? "CLI update ready"
            : "CLI update failed",
      );
      update.description =
        cliUpdateState === "pending"
          ? cliWaitReason
          : cliUpdateState === "failed"
            ? "Current CLI kept"
            : CLI_VERSION;
      update.tooltip =
        cliUpdateState === "pending" && cliJoinError
          ? `${cliJoinError} Open Connection to recover or disconnect the affected browser, then click here to retry.`
          : cliUpdateState === "failed"
            ? "Your current CLI is still selected. Open Manage Teams CLI to retry."
            : "Downloads are verified before switching. Sends, setup and drafts are preserved.";
      update.iconPath = new vscode.ThemeIcon(
        cliUpdateState === "failed" ? "warning" : "cloud-download",
      );
      update.command = {
        command: "teams.manageCli",
        title: "Manage Teams CLI",
      };
      rows.push(update);
    }
    if (
      process.platform !== "win32" &&
      browserConnection &&
      cli &&
      !cli.browserLifetimeSupported
    ) {
      const cleanup = new vscode.TreeItem(
        "Automatic browser cleanup unavailable",
      );
      cleanup.description = "Update CLI";
      cleanup.tooltip = `Use the recommended CLI ${CLI_VERSION} to close extension-managed browsers after the last window exits. Until then, disconnect before exiting.`;
      cleanup.iconPath = new vscode.ThemeIcon("warning");
      cleanup.command = {
        command: "teams.manageCli",
        title: "Update Teams CLI",
      };
      rows.push(cleanup);
    }
    return rows;
  }
  const cliView = vscode.window.createTreeView<vscode.TreeItem>("teams.cli", {
    treeDataProvider: {
      onDidChangeTreeData: cliDetailsChanged.event,
      getChildren: (element) => (element ? [] : cliRows()),
      getTreeItem: (item) => item,
    },
  });
  context.subscriptions.push(cliView);
  const connectionView = vscode.window.createTreeView<never>(
    "teams.connection",
    {
      treeDataProvider: {
        getChildren: () => [],
        getTreeItem: () => new vscode.TreeItem(""),
      },
    },
  );
  context.subscriptions.push(connectionView);
  void vscode.commands.executeCommand(
    "setContext",
    "teams.connectionState",
    "checking",
  );
  const sidebar = new Sidebar(
    context.extensionUri,
    async (message) => {
      switch (message.type) {
        case "open": {
          if (!active || message.profile !== active.name) return;
          const target = chats.find((c) => c.id === message.id);
          if (target) await openChat(target, active.name);
          break;
        }
        case "layout":
          await settings().update(
            "sidebarLayout",
            message.layout,
            vscode.ConfigurationTarget.Global,
          );
          break;
        case "newMessage":
          await vscode.commands.executeCommand("teams.newMessage");
          break;
        case "refresh":
          await refresh();
          break;
        case "more":
          await refresh(true);
          break;
        case "profile":
          await chooseProfile();
          break;
        case "connection":
          await vscode.commands.executeCommand("teams.connection.focus");
          break;
        case "selectAccount":
          await chooseDesktopAccount();
          break;
        case "setup":
          await guidedSetup.execute();
          break;
      }
    },
    () => {
      sidebarError =
        "The action could not finish. Check the connection and try again.";
      renderSidebar();
    },
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("teams.chats", sidebar),
  );
  function renderSidebar() {
    sidebar.update({
      profile: active?.name ?? "",
      accountLabel: active
        ? (active.accountLabel ?? accountLabel(active.backend))
        : "",
      canSwitchProfile: canSwitchProfile(),
      backend: active?.backend ?? "",
      chats,
      layout: sidebarLayout(settings().get("sidebarLayout")),
      loading,
      ready,
      error: sidebarError,
      cached: sidebarCached || active?.backend === "desktop",
      hasMore: !!cursor,
      connection: connectionState,
      selected: selectedChat,
    });
  }
  function scheduleSidebar() {
    clearTimeout(sidebarTimer);
    if (disposed) return;
    sidebarTimer = setTimeout(
      async () => {
        try {
          if (sidebar.visible && ready && !loading && !connectionBusy)
            await refresh();
        } finally {
          scheduleSidebar();
        }
      },
      Math.max(
        10,
        Math.min(300, settings().get<number>("pollIntervalSeconds", 30)),
      ) * 1000,
    );
  }
  const log = (event: string) =>
    output.appendLine(`${new Date().toISOString()} ${event}`);
  async function getCli(): Promise<Cli> {
    if (cli) return cli;
    if (cliPromise) return cliPromise;
    cliPromise = (async () => {
      const change = cliChange;
      const configured = settings().get<string>("cliPath", "");
      const saved = context.globalState.get<{
        configured: string;
        executable: string;
      }>("cliUpdates.selection");
      let selected = await resolveCliSelection(
        configured,
        context.globalStorageUri.fsPath,
        saved,
      );
      const savedVersion =
        saved &&
        managedVersion(saved.executable, context.globalStorageUri.fsPath);
      if (
        !configured &&
        selected.source === "managed" &&
        saved?.configured === configured &&
        savedVersion &&
        needsManagedUpgrade(selected.managedVersion!, savedVersion)
      ) {
        try {
          selected = await resolveCliSelection(
            saved.executable,
            context.globalStorageUri.fsPath,
          );
        } catch {}
      }
      const prefix =
        context.extensionMode === vscode.ExtensionMode.Test &&
        process.env.TEAMS_COMPANION_TEST_FIXTURE
          ? [process.env.TEAMS_COMPANION_TEST_FIXTURE]
          : [];
      const candidate = new Cli(selected.executable, log, prefix);
      usedClis.add(candidate);
      try {
        const verifiedVersion = await candidate.verify();
        if (
          disposed ||
          change !== cliChange ||
          settings().get<string>("cliPath", "") !== configured
        )
          throw new CliError("cancelled");
        version = verifiedVersion;
      } catch (error) {
        await candidate.close();
        usedClis.delete(candidate);
        throw error;
      }
      cli = candidate;
      cliSelection = selected;
      cliDetailsChanged.fire();
      setTimeout(() => {
        void automaticCliUpgrade();
      }, 0);
      return candidate;
    })();
    try {
      return await cliPromise;
    } finally {
      cliPromise = undefined;
    }
  }
  interface PreparedCli {
    api: Cli;
    version: string;
    previous: Cli | undefined;
    selection: CliSelection | undefined;
    change: number;
    automatic: boolean;
    configured: string;
    retryAt?: number;
  }
  let automaticRequest = false;
  let updateAutomatic = false;
  let automaticRetryAt = 0;
  let temporaryInstallFailure = false;
  let pendingPreparedCli: PreparedCli | undefined;
  let cliJoinError = "";
  let manualUpgradeRequested = false;
  let cliWaitReason = "Waiting for current work";
  async function activatePreparedCli(
    prepared: PreparedCli,
    isCurrent = () => true,
  ): Promise<boolean> {
    const current = () =>
      isCurrent() &&
      !disposed &&
      prepared.change === cliChange &&
      cli === prepared.previous &&
      settings().get<string>("cliPath", "") === prepared.configured &&
      (!prepared.automatic ||
        manualUpgradeRequested ||
        settings().get("autoUpdateCli", true));
    const idle = () =>
      !loading &&
      !connectionBusy &&
      setupTerminals === 0 &&
      !recipientPicker &&
      !guidedSetup.busy &&
      !cliPromise &&
      (!cli || cli.idle) &&
      ![...tabs.values()].some(
        (tab) =>
          tab.session.busy || tab.session.sending || tab.session.sendStarting,
      );
    if (!current())
      throw new Error("CLI selection changed while the update was prepared.");
    pendingPreparedCli = prepared;
    if (!idle()) {
      cliWaitReason = "Waiting for current work";
      cliDetailsChanged.fire();
      return false;
    }
    if ((prepared.retryAt ?? 0) > Date.now()) return false;
    // Join each browser still in use before releasing the previous supervisor.
    const profilesInUse = () => [
      ...(active ? [active] : []),
      ...[...tabs.values()].map((tab) => tab.session.profile),
    ];
    const selected = new Map(
      profilesInUse().map((profile) => [profile.name, profile]),
    );
    if (
      !(await joinBrowsers(
        prepared.api,
        [...selected.values()],
        settings().get("keepBrowserRunning", false),
        (error) => {
          cliJoinError =
            error instanceof CliError
              ? error.message
              : "The browser connection could not be checked. Recover or disconnect it in Connection, then retry.";
        },
      ))
    ) {
      prepared.retryAt = Date.now() + 30_000;
      cliWaitReason = "Waiting for browser connection";
      cliDetailsChanged.fire();
      return false;
    }
    if (!current())
      throw new Error("CLI selection changed while the update was prepared.");
    if (!idle()) {
      cliWaitReason = "Waiting for current work";
      cliDetailsChanged.fire();
      return false;
    }
    // A profile opened during the join needs ownership before we can switch.
    if (profilesInUse().some((profile) => !selected.has(profile.name)))
      return false;
    cliJoinError = "";
    const previous = cli;
    if (previous && prepared.selection?.source === "managed") {
      if (!previous.handoff(prepared.api)) return false;
    } else if (previous) {
      // A user-selected executable may use different configuration. Retain its
      // scoped drafts and durable send journals without reusing its open tabs.
      for (const tab of tabs.values()) {
        drafts.set(tab.session.scope, tab.session.draft);
        clearTimeout(tab.timer);
        tab.session.dispose();
        tab.panel?.dispose();
      }
      tabs.clear();
    }
    cli = prepared.api;
    version = prepared.version;
    cliSelection = {
      executable: cli.executable,
      source: "managed",
      managedVersion: prepared.version,
    };
    ++cliChange;
    pendingPreparedCli = undefined;
    cliUpdateState = "idle";
    updateAutomatic = false;
    manualUpgradeRequested = false;
    cliDetailsChanged.fire();
    // A settings-write failure must never discard the now-active verified CLI.
    try {
      if (prepared.automatic) {
        // Older extension windows may react destructively to cliPath changes.
        // Remember our managed selection without triggering their listeners.
        await context.globalState.update("cliUpdates.selection", {
          configured: prepared.configured,
          executable: cli.executable,
        });
      } else {
        await settings().update(
          "cliPath",
          cli.executable,
          vscode.ConfigurationTarget.Global,
        );
      }
    } catch {
      log(
        "cli_update: selection could not be saved; verified CLI remains active for this window",
      );
    }
    await previous?.close();
    void refresh();
    return true;
  }
  const cliUpgrade = new CliUpgrade<PreparedCli>({
    prepare: async () => {
      const previous = cli,
        selection = cliSelection,
        change = cliChange,
        automatic = automaticRequest,
        configured = settings().get<string>("cliPath", "");
      updateAutomatic = automatic;
      temporaryInstallFailure = false;
      const verify = async (api: Cli) => {
        const actual = await api.verify();
        if (
          actual !== CLI_VERSION ||
          (process.platform !== "win32" && !api.browserLifetimeSupported)
        )
          throw new Error(
            "The downloaded CLI does not provide the expected version and browser cleanup support.",
          );
        return actual;
      };
      const executable = await installCli(context.globalStorageUri.fsPath, {
        verify: async (path) => {
          const staged = new Cli(path);
          try {
            await verify(staged);
          } finally {
            await staged.close();
          }
        },
      }).catch((error: unknown) => {
        temporaryInstallFailure = error instanceof InstallBusy;
        throw error;
      });
      const api = new Cli(executable, log);
      try {
        const nextVersion = await verify(api);
        usedClis.add(api);
        return {
          api,
          version: nextVersion,
          previous,
          selection,
          change,
          automatic,
          configured,
        };
      } catch (error) {
        await api.close();
        throw error;
      }
    },
    activate: activatePreparedCli,
    discard: async (prepared) => {
      if (cli === prepared.api && !disposed) return;
      await prepared.api.close();
      usedClis.delete(prepared.api);
    },
    changed: (state) => {
      cliUpdateState = state;
      if (state === "idle" || state === "failed") {
        updateAutomatic = false;
        manualUpgradeRequested = false;
        pendingPreparedCli = undefined;
      }
      cliDetailsChanged.fire();
    },
  });
  const upgradeTimer = setInterval(() => {
    if (cliUpdateState === "pending") void cliUpgrade.apply();
    else if (cliUpdateState === "failed") void automaticCliUpgrade();
  }, 2000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(upgradeTimer);
      cliUpgrade.cancel();
    },
  });
  async function automaticCliUpgrade() {
    if (
      disposed ||
      cliSelection?.source !== "managed" ||
      !settings().get("autoUpdateCli", true) ||
      !needsManagedUpgrade(version, CLI_VERSION) ||
      Date.now() < automaticRetryAt
    )
      return;
    if (cliUpdateState === "downloading" || cliUpdateState === "pending")
      return;
    const attempt = context.globalState.get<{ version: string; time: number }>(
      "cliUpdates.lastFailure",
    );
    if (
      attempt?.version === CLI_VERSION &&
      Date.now() - attempt.time < 24 * 60 * 60 * 1000
    )
      return;
    if (
      disposed ||
      cliSelection?.source !== "managed" ||
      !settings().get("autoUpdateCli", true) ||
      !needsManagedUpgrade(version, CLI_VERSION)
    )
      return;
    automaticRequest = true;
    try {
      await cliUpgrade.request();
      if (cliUpdateState === "failed" && temporaryInstallFailure) {
        automaticRetryAt = Date.now() + 30_000;
      } else if (cliUpdateState === "failed") {
        automaticRetryAt = Date.now() + 24 * 60 * 60 * 1000;
        await context.globalState.update("cliUpdates.lastFailure", {
          version: CLI_VERSION,
          time: Date.now(),
        });
      }
    } catch {
      log("cli_update: automatic retry state could not be saved");
    } finally {
      automaticRequest = false;
    }
  }
  function setReady(value: boolean) {
    ready = value;
    void vscode.commands.executeCommand("setContext", "teams.ready", value);
    renderSidebar();
  }
  function canSwitchProfile() {
    return (
      new Set([
        ...availableProfiles.map((p) => p.name),
        ...(active ? [active.name] : []),
      ]).size > 1
    );
  }
  function summary() {
    const multiple = canSwitchProfile();
    status.command = multiple ? "teams.selectProfile" : undefined;
    void vscode.commands.executeCommand(
      "setContext",
      "teams.multipleAccounts",
      multiple,
    );
    status.text = active
      ? `$(comment-discussion) Teams: ${active.accountLabel ?? accountLabel(active.backend)}`
      : "$(comment-discussion) Teams";
    status.tooltip = active
      ? `Profile: ${active.name}\n${active.backend === "desktop" ? "Teams on this computer" : "Microsoft Graph"}${active.readOnly ? " · Read-only" : ""}${multiple ? "\nChoose a Teams connection" : ""}`
      : "Select a Teams profile";
    if (cliSelection)
      status.tooltip += `\nTeams CLI ${version} · ${cliSelection.source === "managed" ? "Extension-managed" : "Managed by you"}\n${cliSelection.executable}`;
    renderSidebar();
  }
  function showConnection(state: string) {
    connectionState = state;
    cliDetailsChanged.fire();
    renderSidebar();
    if (!browserConnection || state !== "connected")
      connectionView.message = undefined;
    connectionView.description = active
      ? `${active.accountLabel ?? active.name} · ${active.backend === "desktop" ? (browserConnection ? "Browser" : "Desktop") : "Graph"}`
      : undefined;
    void vscode.commands.executeCommand(
      "setContext",
      "teams.connectionState",
      state,
    );
  }
  async function superviseBrowser(api: Cli) {
    if (disposed) throw new CliError("cancelled");
    await api.startBrowserLifetime(
      settings().get<boolean>("keepBrowserRunning", false),
    );
  }
  async function connectionConfig(profile = active, supervise = true) {
    if (profile?.backend !== "desktop") return {};
    const api = await getCli();
    const config = obj(
      await api.call(["config", "show"], { profile: profile.name }),
    );
    if (supervise && isBrowser(config)) await superviseBrowser(api);
    return config;
  }
  async function readConnection(selected: Profile | undefined, run: number) {
    if (!selected || selected.backend !== "desktop") {
      if (run === generation) {
        browserConnection = false;
        await vscode.commands.executeCommand(
          "setContext",
          "teams.browserConnection",
          false,
        );
        showConnection(selected ? "graph" : "setup");
      }
      return;
    }
    try {
      const api = await getCli();
      const config = await connectionConfig(selected);
      if (run !== generation) return;
      selected.accountLabel = accountLabel(selected.backend, config);
      browserConnection = isBrowser(config);
      await vscode.commands.executeCommand(
        "setContext",
        "teams.browserConnection",
        browserConnection,
      );
      summary();
      const status = await api.call(["desktop", "status"], {
        profile: selected.name,
        timeout: 30_000,
      });
      if (run === generation) {
        showConnection(desktopState(status));
        if (browserConnection && connectionState === "connected") {
          connectionView.message =
            obj(obj(status).management).auto_close === true
              ? "Closes after its last Teams Companion window exits. Your sign-in is saved."
              : api.browserLifetimeSupported
                ? "Runs until you disconnect it. Your sign-in is saved."
                : "This CLI keeps the browser running after VS Code exits. Use Disconnect browser before exiting; automatic cleanup requires a CLI with browser supervision support.";
        }
      }
    } catch {
      if (run === generation) showConnection("unavailable");
    }
  }
  async function selectProfile(profile: Profile) {
    ++generation;
    loadAbort?.abort();
    active = profile;
    chats = [];
    cursor = "";
    sidebarError = "";
    sidebarCached = false;
    selectedChat = "";
    await context.globalState.update("profile", profile.name);
    setReady(true);
    summary();
  }
  async function discoverProfiles(signal?: AbortSignal) {
    const api = await getCli();
    const list = profiles(await api.call(["profile", "list"], { signal }));
    const available = await Promise.all(
      list.map(async (profile) => {
        if (profile.backend === "desktop") return profile;
        try {
          const auth = obj(
            await api.call(["auth", "status"], {
              profile: profile.name,
              signal,
              timeout: 3_000,
            }),
          );
          return auth.verified === true ? profile : undefined;
        } catch {
          // Keep unverified profiles in Connection, without offering an empty main-view choice.
          return undefined;
        }
      }),
    );
    return { list, available: available.filter((p): p is Profile => !!p) };
  }
  async function loadProfiles(preferred?: string) {
    const found = await discoverProfiles();
    allProfiles = found.list;
    availableProfiles = found.available;
    const saved = preferred ?? context.globalState.get<string>("profile");
    active =
      allProfiles.find((p) => p.name === saved) ??
      allProfiles.find((p) => p.active) ??
      allProfiles[0];
    setReady(!!active);
    summary();
    return allProfiles;
  }
  async function refresh(more = false) {
    if (loading && more) return;
    const run = ++generation;
    loadAbort?.abort();
    const abort = new AbortController();
    loadAbort = abort;
    loading = true;
    try {
      if (!active) await loadProfiles();
      else {
        const found = await discoverProfiles(abort.signal);
        if (run !== generation) return;
        allProfiles = found.list;
        availableProfiles = found.available;
        summary();
      }
      if (run !== generation) return;
      await readConnection(active, run);
      if (run !== generation || !active) return;
      const selected = active;
      const targetCount = more ? 50 : Math.max(50, chats.length);
      sidebarError = "";
      renderSidebar();
      const api = await getCli();
      const readPage = async (next: string) =>
        page(
          await api.call(
            [
              "chats",
              "list",
              "--limit",
              "50",
              ...(next ? ["--cursor", next] : []),
            ],
            { profile: selected.name, signal: abort.signal },
          ),
          chat,
        );
      let p = await readPage(more ? cursor : "");
      let incoming = p.items;
      const seen = new Set<string>();
      // Keep the loaded range on refresh so polling cannot collapse pagination.
      while (
        !more &&
        incoming.length < targetCount &&
        p.cursor &&
        !seen.has(p.cursor) &&
        p.items.length
      ) {
        if (run !== generation) return;
        seen.add(p.cursor);
        p = await readPage(p.cursor);
        incoming = [...incoming, ...p.items];
      }
      if (run !== generation) return;
      chats = more
        ? [
            ...new Map(
              [...chats, ...incoming].filter((c) => c.id).map((c) => [c.id, c]),
            ).values(),
          ]
        : [
            ...new Map(
              incoming.filter((c) => c.id).map((c) => [c.id, c]),
            ).values(),
          ];
      cursor = p.cursor;
      sidebarCached = p.cached;
      for (const tab of tabs.values()) {
        if (tab.session.profile.name !== selected.name) continue;
        const fresh = chats.find((c) => c.id === tab.chat.id);
        if (fresh) {
          tab.chat = fresh;
          publish(tab);
        }
      }
      setReady(true);
    } catch (e) {
      if (run === generation && (e as CliError).kind !== "cancelled") {
        sidebarError = (e as Error).message;
        if (!cli) showConnection("cli");
        else if ((e as CliError).kind === "desktop_account_ambiguous")
          showConnection("account");
        log(`chats refresh: ${(e as CliError).kind ?? "setup_error"}`);
      }
    } finally {
      if (run === generation) {
        loading = false;
        renderSidebar();
      }
    }
  }
  async function chooseProfile() {
    const list = await loadProfiles();
    if (!list.length) {
      await setup();
      return;
    }
    const api = await getCli();
    await Promise.all(
      list
        .filter((p) => p.backend === "desktop")
        .map(async (p) => {
          try {
            p.accountLabel = accountLabel(
              p.backend,
              await api.call(["config", "show"], {
                profile: p.name,
                timeout: 15_000,
              }),
            );
          } catch {
            // The profile name still distinguishes unavailable connections in the picker.
          }
        }),
    );
    summary();
    const choice = await vscode.window.showQuickPick(
      list.map((p) => ({
        label: p.accountLabel ?? accountLabel(p.backend),
        description: `Profile: ${p.name}${p.readOnly ? " · Read-only" : ""}`,
        profile: p,
      })),
      {
        title: "Choose a Teams connection",
        placeHolder: "Open conversations keep their original account.",
      },
    );
    if (!choice) return;
    await selectProfile(choice.profile);
    await refresh();
  }
  function update(tab: Tab) {
    const s = tab.session;
    if (s.recovery === "selectAccount" && active?.name === s.profile.name)
      showConnection("account");
    publish(tab);
  }
  function publish(tab: Tab) {
    const s = tab.session;
    const state: ViewState = {
      scope: tab.token,
      title: tab.chat.title,
      avatar: tab.chat.avatar,
      memberAvatars: tab.chat.memberAvatars,
      profile: s.profile.name,
      accountLabel: s.profile.accountLabel ?? accountLabel(s.profile.backend),
      backend: s.profile.backend,
      cached: s.cached || s.profile.backend === "desktop",
      readOnly: s.profile.readOnly,
      repliesEnabled: settings().get("repliesEnabled", false),
      messages: s.messages,
      cursor: s.cursor,
      draft: s.draft,
      busy: s.busy,
      sending: s.sending || s.externalSending,
      error: s.error || s.operationError,
      recovery: s.recovery,
      note: s.note,
      updated: s.updated,
      pending: !!s.pending || s.corrupt,
      canCheck: !!s.pending?.clientId,
      sendOnEnter: settings().get("sendOnEnter", false),
    };
    void tab.panel?.webview.postMessage({ type: "state", state });
  }
  function schedule(tab: Tab) {
    clearTimeout(tab.timer);
    if (!tab.panel?.visible) return;
    const delay = Math.min(
      300,
      Math.max(10, settings().get<number>("pollIntervalSeconds", 30)) *
        2 ** Math.min(4, tab.failures),
    );
    tab.timer = setTimeout(
      async () => {
        if (tab.panel?.visible && !tab.session.busy && !tab.session.sending) {
          try {
            await tab.session.refresh();
            tab.failures = 0;
            tab.retryAt = undefined;
          } catch (e) {
            tab.failures++;
            if (e instanceof CliError && e.retryAfter)
              tab.retryAt = Date.now() + e.retryAfter * 1000;
          }
        }
        schedule(tab);
      },
      Math.max(delay * 1000, (tab.retryAt ?? 0) - Date.now()),
    );
  }
  async function openChat(value?: Chat, requestedProfile?: string) {
    if (!value?.id) {
      await findChat();
      return;
    }
    if (!active) await loadProfiles();
    if (!active) throw new Error("Set up a Teams profile first.");
    const selected = {
      ...(requestedProfile
        ? allProfiles.find((p) => p.name === requestedProfile)
        : active),
    } as Profile;
    if (!selected.name)
      throw new Error(
        "This profile is no longer available. Refresh conversations.",
      );
    if (selected.name === active?.name) {
      selectedChat = value.id;
      renderSidebar();
    }
    const api = await getCli();
    const config = obj(
      await api.call(["config", "show"], { profile: selected.name }),
    );
    selected.readOnly = config.read_only === true;
    selected.accountLabel = accountLabel(selected.backend, config);
    const scope = JSON.stringify([
      str(config.config_path),
      selected.name,
      value.id,
    ]);
    let tab = tabs.get(scope);
    if (tab) {
      tab.session.profile.accountLabel = selected.accountLabel;
      tab.chat = value;
      update(tab);
    }
    if (tab?.panel) {
      tab.panel.reveal();
      return;
    }
    if (!tab) {
      const token = randomUUID();
      let created: Tab;
      const session = new Conversation(
        api,
        selected,
        value.id,
        scope,
        store,
        () => update(created),
      );
      created = { session, chat: value, token, failures: 0 };
      tab = created;
      tabs.set(scope, created);
      session.draft = drafts.get(scope) ?? "";
      await session.initialize();
    }
    const current = tab;
    const panel = vscode.window.createWebviewPanel(
      "teams.conversation",
      `${value.title} · ${selected.accountLabel}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
        retainContextWhenHidden: true,
      },
    );
    current.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(
      context.extensionUri,
      "media",
      "teams.svg",
    );
    panel.webview.onDidReceiveMessage(
      (message) => {
        if (!validInbound(message, current.token)) return;
        void (async () => {
          const s = current.session;
          switch (message.type) {
            case "ready":
              current.ready = true;
              update(current);
              break;
            case "draft":
              if (!s.sending && !s.pending && !s.corrupt) {
                s.draft = message.text ?? "";
                drafts.set(scope, s.draft);
              }
              break;
            case "refresh":
              await s.refresh();
              current.failures = 0;
              break;
            case "older":
              if (s.cursor) await s.refresh(true);
              break;
            case "send":
              await s.send(settings().get("repliesEnabled", false));
              drafts.set(scope, s.draft);
              break;
            case "check":
              await s.check();
              break;
            case "acknowledge": {
              if (s.sending) return;
              const confirm = await vscode.window.showWarningMessage(
                "Confirm you checked the previous send in Teams. Clearing this guard allows a new message and could create a duplicate if you send the same draft.",
                { modal: true },
                "I checked; unlock replies",
              );
              if (confirm) await s.acknowledge();
              break;
            }
            case "enableReplies":
              await enableReplies();
              break;
            case "openTeams":
              await openTeams(s.profile);
              break;
            case "connect":
              await connection("connect", s.profile);
              break;
            case "selectAccount":
              await chooseDesktopAccount(s.profile, current.chat);
              break;
            case "connection":
              await vscode.commands.executeCommand("teams.connection.focus");
              break;
          }
        })().catch((e) => {
          current.session.error = (e as Error).message;
          update(current);
        });
      },
      undefined,
      context.subscriptions,
    );
    panel.onDidDispose(() => {
      clearTimeout(current.timer);
      current.panel = undefined;
      drafts.set(scope, current.session.draft);
    });
    panel.onDidChangeViewState(() => {
      if (panel.active && current.session.profile.name === active?.name) {
        selectedChat = current.chat.id;
        renderSidebar();
      }
      schedule(current);
    });
    panel.webview.html = html(
      panel.webview,
      context.extensionUri,
      current.token,
    );
    await current.session.refresh().catch(() => {});
    schedule(current);
  }
  let startingNewMessage = false;
  async function newMessage() {
    if (startingNewMessage) return;
    startingNewMessage = true;
    try {
      if (recipientPicker) {
        recipientPicker.show();
        return;
      }
      if (!active) await loadProfiles();
      if (!active) {
        await setup();
        return;
      }
      const selected = { ...active };
      const api = await getCli();
      const schema = obj(await api.call(["schema"]));
      const commands = Array.isArray(schema.commands)
        ? schema.commands.map((c) => str(obj(c).name))
        : [];
      if (
        !commands.includes("people search") ||
        !commands.includes("chats create")
      ) {
        const action = await vscode.window.showWarningMessage(
          "Update Teams CLI to find people and start conversations.",
          "Download CLI Update",
          "Select CLI Executable",
        );
        if (action)
          await vscode.commands.executeCommand(
            action === "Download CLI Update"
              ? "teams.downloadCli"
              : "teams.configureCli",
          );
        return;
      }
      const config = obj(
        await api.call(["config", "show"], { profile: selected.name }),
      );
      selected.accountLabel = accountLabel(selected.backend, config);
      if (config.read_only === true)
        throw new Error(
          "This account is read-only. Use a writable profile to start a conversation.",
        );
      const identity = (v: Record<string, unknown>) =>
        JSON.stringify([
          v.config_path,
          v.backend,
          v.desktop_account,
          v.desktop_port,
          v.desktop_client,
          v.read_only,
        ]);
      const connectionIdentity = identity(config);
      type Pick = vscode.QuickPickItem & { recipient?: Recipient };
      const picker = vscode.window.createQuickPick<Pick>();
      recipientPicker = picker;
      picker.title = `New message · ${selected.accountLabel} · ${selected.name}`;
      picker.placeholder = "Find a person by name or full email address";
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.ignoreFocusOut = true;
      let timer: NodeJS.Timeout | undefined,
        abort: AbortController | undefined,
        sequence = 0,
        accepted = false,
        resultQuery = "";
      const hint = (label: string, detail = "") => {
        picker.items = [{ label, detail, alwaysShow: true }];
      };
      hint(
        "Type at least 2 characters",
        "Select a person to open a conversation. Nothing is sent until you press Send.",
      );
      picker.onDidChangeValue((value) => {
        clearTimeout(timer);
        abort?.abort();
        const seq = ++sequence;
        resultQuery = "";
        picker.busy = false;
        if (value.trim().length < 2) {
          hint("Type at least 2 characters");
          return;
        }
        if (value.length > 256) {
          hint("Use a shorter name or email address");
          return;
        }
        picker.items = [];
        picker.busy = true;
        timer = setTimeout(() => {
          abort = new AbortController();
          void searchRecipients(api, selected.name, value, abort.signal)
            .then((result) => {
              if (seq !== sequence || accepted) return;
              resultQuery = value;
              picker.items = result.items.map((r) => ({
                label: r.name,
                description: r.email || r.id,
                detail: "Open conversation · No message is sent yet",
                recipient: r,
                alwaysShow: true,
              }));
              if (!result.items.length)
                hint(
                  "No matching people",
                  "Try their full email address. Personal Teams can only find people who are discoverable in Teams.",
                );
              else if (result.truncated)
                picker.items = [
                  ...picker.items,
                  {
                    label: "More matches available",
                    detail: "Keep typing to narrow your search.",
                    alwaysShow: true,
                  },
                ];
            })
            .catch((e) => {
              if (
                seq !== sequence ||
                accepted ||
                (e as CliError).kind === "cancelled"
              )
                return;
              hint(
                "Couldn’t search this account",
                (e as CliError).kind === "permission_denied"
                  ? "Sign in to this Graph profile again to grant basic directory search, then retry."
                  : (e as Error).message,
              );
            })
            .finally(() => {
              if (seq === sequence && !accepted) picker.busy = false;
            });
        }, 350);
      });
      picker.onDidAccept(() => {
        const to = picker.selectedItems[0]?.recipient;
        if (!to || accepted || picker.busy || resultQuery !== picker.value)
          return;
        accepted = true;
        picker.hide();
        void (async () => {
          const latest = obj(
            await api.call(["config", "show"], { profile: selected.name }),
          );
          if (identity(latest) !== connectionIdentity)
            throw new Error(
              "This account’s connection changed. Start New message again to search with the current account.",
            );
          if (!settings().get("repliesEnabled", false)) {
            await enableReplies();
            if (!settings().get("repliesEnabled", false)) return;
          }
          const scope = JSON.stringify([
            str(config.config_path),
            selected.name,
            "new-chat",
            to.id,
          ]);
          const pending = await newChatStore.read(scope);
          if (pending) {
            if (newChatStore.isActive(pending))
              throw new Error(
                "This conversation is already being opened in another window.",
              );
            const action = await vscode.window.showWarningMessage(
              "Teams may already have created this conversation. Check Teams before trying again. No message was sent.",
              "Open Teams",
              "I checked Teams; try again",
            );
            if (action === "Open Teams") {
              await openTeams(selected);
              return;
            }
            if (action !== "I checked Teams; try again") return;
            await newChatStore.clear(scope, pending.operation);
          }
          const value = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Opening conversation with ${to.name}`,
              cancellable: false,
            },
            () =>
              createConversation(api, newChatStore, selected.name, scope, to),
          );
          await openChat(value, selected.name);
          if (active?.name === selected.name) void refresh();
        })().catch(async (e) => {
          const uncertain = e instanceof CliError && e.uncertain;
          const action = await vscode.window.showErrorMessage(
            uncertain
              ? "Teams may have created the conversation. Check Teams before trying again. No message was sent."
              : (e as Error).message,
            "Open Teams",
          );
          if (action) await openTeams(selected);
        });
      });
      picker.onDidHide(() => {
        clearTimeout(timer);
        abort?.abort();
        sequence++;
        if (recipientPicker === picker) recipientPicker = undefined;
        picker.dispose();
      });
      picker.show();
    } finally {
      startingNewMessage = false;
    }
  }
  async function findChat() {
    if (!chats.length) await refresh();
    const profileName = active?.name;
    const selected = await vscode.window.showQuickPick(
      chats.map((c) => ({ label: c.title, description: c.preview, chat: c })),
      {
        title: "Find Teams conversation",
        placeHolder: "Search loaded conversations",
        matchOnDescription: true,
      },
    );
    if (selected) await openChat(selected.chat, profileName);
  }
  async function chooseSidebarLayout() {
    const current = sidebarLayout(settings().get("sidebarLayout"));
    const choices = [
      {
        label: "Teams",
        value: "teams",
        detail: "Avatars, previews and timestamps",
      },
      {
        label: "Compact",
        value: "compact",
        detail: "Smaller avatars and single-line conversations",
      },
      {
        label: "Comfortable",
        value: "comfortable",
        detail: "Larger avatars and two-line previews",
      },
    ] as const;
    const selected = await vscode.window.showQuickPick(
      choices.map((choice) => ({
        ...choice,
        description: choice.value === current ? "Current layout" : "",
        picked: choice.value === current,
      })),
      {
        title: "Sidebar layout",
        placeHolder: "Choose how conversations appear",
      },
    );
    if (selected)
      await settings().update(
        "sidebarLayout",
        selected.value,
        vscode.ConfigurationTarget.Global,
      );
  }
  async function enableReplies() {
    const ok = await vscode.window.showWarningMessage(
      "Enable replies in Teams Companion? Each message is sent as the account signed in to the chosen profile. The CLI profile must also allow sending.",
      { modal: true },
      "Enable replies",
    );
    if (ok) {
      await settings().update(
        "repliesEnabled",
        true,
        vscode.ConfigurationTarget.Global,
      );
      for (const tab of tabs.values()) update(tab);
    }
  }
  async function openTeams(profile = active) {
    let personal = false;
    if (profile?.backend === "desktop") {
      const config = obj(
        await (
          await getCli()
        ).call(["config", "show"], { profile: profile.name }),
      );
      personal = config.desktop_account === "personal";
    }
    await vscode.env.openExternal(
      vscode.Uri.parse(
        personal
          ? "https://teams.live.com/v2/"
          : "https://teams.microsoft.com/v2/",
      ),
    );
  }
  const desktop = new DesktopActions({
    profiles: async () => loadProfiles(),
    current: () => active,
    choose: async (list, canCreate) => {
      const selected = await vscode.window.showQuickPick(
        [
          ...list.map((p) => ({
            label: p.name,
            description: p.readOnly ? "Read-only" : "Replies allowed",
            value: p as Profile | "new",
          })),
          ...(canCreate
            ? [
                {
                  label: "Set up another desktop profile",
                  description: "Personal or work/school",
                  value: "new" as const,
                },
              ]
            : []),
        ],
        {
          title: "Connect Teams",
          placeHolder: "Choose the connection to use",
        },
      );
      return selected?.value;
    },
    create: () => setup("desktop", false),
    noProfile: async () => {
      await vscode.window.showInformationMessage(
        "There is no desktop profile to disconnect or recover. Choose Connect Teams Desktop to set one up.",
      );
    },
    confirm: async (action, profile) => {
      if (action === "recover") return true;
      const config = await connectionConfig(profile, action === "connect");
      const browser = isBrowser(config);
      const label =
        action === "connect"
          ? browser
            ? "Connect Teams Browser"
            : "Connect Teams Desktop"
          : browser
            ? "Disconnect Teams Browser"
            : "Disconnect Teams Desktop";
      const text = browser
        ? action === "connect"
          ? "Open your separate Teams browser session? Its local debugging port lets programs running as you read chats and send messages. Your regular browser and Teams app stay open."
          : "Close the separate Teams browser? Your saved sign-in is kept for next time. Your regular browser and Teams app stay open."
        : action === "connect"
          ? "Connecting may restart Teams and end a call. While its local debugging port is open, programs running as you can read chats and send messages. Disconnect closes the managed debugging session."
          : "Disconnecting restarts Teams normally and may end a call. Unmanaged sessions are left for manual recovery.";
      return !!(await vscode.window.showWarningMessage(
        label + "?",
        { modal: true, detail: `${text}\n\nProfile: ${profile.name}` },
        label,
      ));
    },
    select: selectProfile,
    run: async (action, profile) => {
      showConnection("busy");
      const config = await connectionConfig(profile, action === "connect");
      const label = isBrowser(config) ? "browser" : "desktop";
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Teams: ${action} ${label}`,
          cancellable: false,
        },
        async () => {
          const api = await getCli();
          if (action === "connect" && !isBrowser(config)) {
            const status = await api.call(["desktop", "status"], {
              profile: profile.name,
            });
            if (closedNativeSession(config, status))
              await api.call(["--yes", "desktop", "disconnect"], {
                profile: profile.name,
                mutation: true,
                timeout: 120_000,
              });
          }
          await api.call(["--yes", "desktop", action], {
            profile: profile.name,
            mutation: true,
            timeout: 120_000,
          });
        },
      );
      for (const tab of tabs.values())
        if (tab.session.profile.name === profile.name && tab.panel?.visible)
          void tab.session.refresh().catch(() => {});
    },
    busy: (value) => {
      connectionBusy = value;
      void vscode.commands.executeCommand(
        "setContext",
        "teams.connectionBusy",
        value,
      );
    },
    refresh: () => refresh(),
  });
  function isBrowser(config: Record<string, unknown>) {
    return ["browser", "browser_core", "browser-core"].includes(
      str(config.desktop_client),
    );
  }
  const guidedSetup = new GuidedSetup({
    profiles: async () =>
      profiles(await (await getCli()).call(["profile", "list"])),
    launch: async (action, profile) => {
      if (connectionBusy) {
        await vscode.window.showInformationMessage(
          "Wait for the current connection action to finish, then start setup again.",
        );
        return;
      }
      let api = await getCli();
      if (!supportsGuidedSetup(version, await api.call(["schema"]))) {
        const choice = await vscode.window.showInformationMessage(
          "Guided browser setup needs Teams CLI 0.2.2 or newer. Update the CLI to check supported connections on this computer.",
          "Update CLI",
        );
        if (!choice) return;
        await vscode.commands.executeCommand("teams.downloadCli");
        api = await getCli();
        if (!supportsGuidedSetup(version, await api.call(["schema"]))) {
          if (cliUpdateState === "pending" || cliUpdateState === "downloading")
            await vscode.window.showInformationMessage(
              "The CLI update will switch when current work finishes. Run Guided Account Setup again after the CLI section shows the new version.",
            );
          return;
        }
      }
      if (
        action === "browserSignIn" &&
        (!profile || !isBrowser(await connectionConfig(profile)))
      )
        throw new Error(
          "Select a browser connection first, or run Teams: Guided Account Setup.",
        );
      const args =
        action === "setup"
          ? ["init"]
          : ["--profile", profile!.name, "desktop", "login"];
      // Native terminals use the remote workspace host in SSH/WSL windows.
      // Never pass a trusted local executable path to a different computer.
      if (vscode.env.remoteName) {
        await vscode.window.showInformationMessage(
          "Open a local VS Code window to run guided account setup. Once connected, your chats remain available in this remote window.",
        );
        return;
      }
      api = await getCli();
      await superviseBrowser(api);
      let terminal: vscode.Terminal | undefined;
      let finish!: (code: number | undefined) => void;
      const finished = new Promise<number | undefined>((resolve) => {
        finish = resolve;
      });
      const closed = vscode.window.onDidCloseTerminal((value) => {
        if (value !== terminal) return;
        closed.dispose();
        setupTerminals--;
        finish(value.exitStatus?.code);
        void cliUpgrade.apply();
      });
      context.subscriptions.push(closed);
      try {
        terminal = vscode.window.createTerminal({
          name:
            action === "setup"
              ? "Teams account setup"
              : "Teams browser sign-in",
          shellPath: api.executable,
          env: api.environment,
          shellArgs: [
            ...(context.extensionMode === vscode.ExtensionMode.Test &&
            process.env.TEAMS_COMPANION_TEST_FIXTURE
              ? [process.env.TEAMS_COMPANION_TEST_FIXTURE]
              : []),
            ...args,
          ],
          isTransient: true,
        });
        setupTerminals++;
        terminal.show();
      } catch (error) {
        closed.dispose();
        throw error;
      }
      return { finished, reveal: () => terminal?.show() };
    },
    complete: async (before) => {
      const after = profiles(await (await getCli()).call(["profile", "list"]));
      await loadProfiles(completedProfile(before, after, active?.name));
      await refresh();
      await vscode.commands.executeCommand("teams.chats.focus");
    },
    failed: async () => {
      await refresh();
      await vscode.window.showWarningMessage(
        "Teams setup did not finish. Run Guided Account Setup again to retry or recover a saved setup. Your existing connections are preserved.",
      );
    },
  });
  context.subscriptions.push(guidedSetup);

  const updates = new UpdateChecker(
    context.extension.packageJSON.version,
    context.extension.packageJSON.preview === true,
    {
      get: <T>(key: string) => context.globalState.get<T>(key),
      set: async (key, value) => {
        await context.globalState.update(key, value);
      },
      enabled: () => settings().get<boolean>("checkForUpdates", true),
      fetch: fetchReleases,
      available: async (release) => {
        const choice = await vscode.window.showInformationMessage(
          `Teams Companion ${release.version}${release.experimental ? " (experimental)" : ""} is available. Installed: ${context.extension.packageJSON.version}.`,
          "View release",
          "Skip this version",
        );
        return choice === "View release"
          ? "open"
          : choice === "Skip this version"
            ? "skip"
            : undefined;
      },
      open: async (url) => {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
      current: async () => {
        await vscode.window.showInformationMessage(
          "Teams Companion is up to date. No newer downloadable release is available.",
        );
      },
      failed: async () => {
        await vscode.window
          .showWarningMessage(
            "Could not check for Teams Companion updates. Try again later or visit the GitHub releases page.",
            "View releases",
          )
          .then(async (choice) => {
            if (choice)
              await vscode.env.openExternal(
                vscode.Uri.parse(
                  "https://github.com/rvben/teams-vscode/releases",
                ),
              );
          });
      },
      now: Date.now,
    },
  );
  context.subscriptions.push(updates);
  function connection(
    action: "connect" | "disconnect" | "recover",
    profile?: Profile,
  ) {
    return desktop.execute(action, profile);
  }
  let selectingAccount = false;
  async function chooseDesktopAccount(profile = active, requestedChat?: Chat) {
    if (selectingAccount || connectionBusy) return;
    if (!profile || profile.backend !== "desktop")
      throw new Error("Select a desktop profile to choose its Teams account.");
    selectingAccount = true;
    try {
      const api = await getCli();
      const config = obj(
        await api.call(["config", "show"], { profile: profile.name }),
      );
      if (isBrowser(config)) {
        const choice = await vscode.window.showInformationMessage(
          "Each browser connection keeps its own account and saved sign-in. Set up a separate connection to use another account.",
          "Set up another account",
        );
        if (choice) await guidedSetup.execute();
        return;
      }
      const account = await vscode.window.showQuickPick(
        [
          {
            label: "Personal Teams",
            description: "Use the personal account signed in to Teams",
            value: "personal" as const,
          },
          {
            label: "Work or school Teams",
            description: "Use the work or school account signed in to Teams",
            value: "work-school" as const,
          },
        ],
        {
          title: "Choose Teams account",
          placeHolder:
            "Accounts use separate profiles so open conversations keep their account.",
        },
      );
      if (!account) return;
      const list = profiles(await api.call(["profile", "list"]));
      const accountValue =
        account.value === "personal" ? "personal" : "work_school";
      let selected: Profile | undefined;
      for (const candidate of list.filter(
        (p) =>
          p.backend === "desktop" && p.readOnly === (config.read_only === true),
      )) {
        const c = obj(
          await api.call(["config", "show"], { profile: candidate.name }),
        );
        if (
          c.desktop_account === accountValue &&
          c.desktop_port === config.desktop_port
        ) {
          selected = candidate;
          break;
        }
      }
      if (!selected) {
        const name = accountProfileName(list, profile.name, account.value);
        if (
          profiles(await api.call(["profile", "list"])).some(
            (p) => p.name === name,
          )
        )
          throw new Error(
            "A profile was created in another window. Choose the account again.",
          );
        await api.call(accountProfileArgs(config, account.value), {
          profile: name,
          mutation: true,
        });
        selected = (await loadProfiles(name)).find((p) => p.name === name);
      }
      if (!selected)
        throw new Error(
          "Refresh the profile list and choose the account again.",
        );
      await selectProfile(selected);
      await refresh();
      if (requestedChat && chats.some((c) => c.id === requestedChat.id))
        await openChat(requestedChat, selected.name);
    } finally {
      selectingAccount = false;
    }
  }
  async function signIn(profile = active) {
    if (!profile) throw new Error("Set up a profile first.");
    if (profile.backend !== "graph") {
      if (isBrowser(await connectionConfig(profile)))
        return guidedSetup.execute("browserSignIn", profile);
      throw new Error("Sign in directly in Teams for desktop profiles.");
    }
    const api = await getCli();
    const terminal = vscode.window.createTerminal({
      name: `Teams sign-in · ${profile.name}`,
      shellPath: api.executable,
      shellArgs: ["--profile", profile.name, "auth", "login", "--device-code"],
      isTransient: true,
    });
    setupTerminals++;
    const closed = vscode.window.onDidCloseTerminal((value) => {
      if (value !== terminal) return;
      closed.dispose();
      setupTerminals--;
      void cliUpgrade.apply();
    });
    context.subscriptions.push(closed);
    terminal.show();
  }
  async function setup(
    forcedBackend?: "desktop" | "graph",
    connectAfter = true,
  ): Promise<Profile | undefined> {
    const api = await getCli();
    const existing = profiles(await api.call(["profile", "list"]));
    const name =
      forcedBackend === "desktop"
        ? newDesktopProfileName(existing)
        : await vscode.window.showInputBox({
            title: "New Teams profile",
            prompt: "Use a new name. Existing CLI profiles will be preserved.",
            value: "vscode",
            validateInput: (value) =>
              !value || !/^[-\w]{1,64}$/.test(value)
                ? "Use 1–64 letters, numbers, underscores, or hyphens."
                : existing.some((p) => p.name === value)
                  ? "A profile with this name already exists. Choose another name."
                  : undefined,
          });
    if (!name) return;
    const backend = forcedBackend
      ? { value: forcedBackend }
      : await vscode.window.showQuickPick(
          [
            {
              label: "Desktop Teams",
              description: "Personal or work/school · cached chats",
              value: "desktop",
            },
            {
              label: "Microsoft Graph",
              description: "Work/school · delegated sign-in",
              value: "graph",
            },
          ],
          { title: "Connection for " + name },
        );
    if (!backend) return;
    const args = ["init", "--backend", backend.value, "--no-login"];
    if (backend.value === "desktop") {
      const account = await vscode.window.showQuickPick(
        [
          { label: "Personal", value: "personal" },
          { label: "Work or school", value: "work-school" },
        ],
        {
          title: "Connect Teams Desktop · 1 of 2",
          placeHolder: "Which account are you signed in to in Teams?",
        },
      );
      if (!account) return;
      const access = await vscode.window.showQuickPick(
        [
          { label: "Read-only", value: false },
          { label: "Allow replies", value: true },
        ],
        {
          title: "Connect Teams Desktop · 2 of 2",
          placeHolder: "Replies also require enabling them in the extension.",
        },
      );
      if (!access) return;
      args.push("--desktop-port", "19222", "--desktop-account", account.value);
      if (access.value) args.push("--allow-send");
    } else {
      const access = await vscode.window.showQuickPick(
        [
          { label: "Read-only", value: true },
          { label: "Allow replies", value: false },
        ],
        { title: "Profile access" },
      );
      if (!access) return;
      if (access.value) args.push("--read-only");
    }
    // Recheck after the wizard so a profile created in another window is never overwritten.
    if (
      profiles(await api.call(["profile", "list"])).some((p) => p.name === name)
    )
      throw new Error(
        "This profile now exists. Select it or create a different name.",
      );
    await api.call(args, { profile: name, mutation: true });
    await context.globalState.update("profile", name);
    await loadProfiles(name);
    const created = active;
    if (connectAfter) {
      if (backend.value === "desktop") await connection("connect", created);
      else await signIn();
      await refresh();
    }
    return created;
  }
  function register(name: string, fn: (...args: any[]) => unknown) {
    context.subscriptions.push(
      vscode.commands.registerCommand(name, (...args: unknown[]) =>
        Promise.resolve(fn(...args)).catch(async (e) => {
          log(`command: ${(e as CliError).kind ?? "failed"}`);
          const action = await vscode.window.showErrorMessage(
            (e as Error).message,
            "Show diagnostics",
          );
          if (action) void diagnostics().catch(() => output.show(true));
        }),
      ),
    );
  }
  async function diagnostics() {
    const api = await getCli();
    const config = active
      ? obj(await api.call(["config", "show"], { profile: active.name }))
      : {};
    output.appendLine(
      `CLI location: ${api.executable}; source: ${cliSelection?.source ?? "unknown"}; recommended: ${CLI_VERSION}; browser cleanup supported: ${api.browserLifetimeSupported}; automatic managed updates: ${settings().get("autoUpdateCli", true)}`,
    );
    output.appendLine(
      `Host: ${process.platform}/${process.arch}; CLI: ${version}; backend: ${str(config.backend) || "unselected"}; read-only: ${config.read_only === true}; replies enabled: ${settings().get("repliesEnabled", false)}`,
    );
    if (active?.backend === "desktop") {
      const result = obj(
        await api.call(["desktop", "status"], { profile: active.name }),
      );
      const conn = obj(result.connection),
        management = obj(result.management);
      // Only allowlisted non-identifying metadata reaches the output channel.
      const code = str(conn.status);
      output.appendLine(
        `Desktop endpoint available: ${result.endpoint_available === true}; status: ${/^[a-z_]{1,64}$/.test(code) ? code : "unknown"}; managed: ${management.managed === true}`,
      );
    } else if (active) {
      const result = obj(
        await api.call(["auth", "status"], {
          profile: active.name,
        }),
      );
      output.appendLine(
        `Graph credentials present: ${result.signed_in === true}; offline status is not session verification.`,
      );
    }
    output.show(true);
  }
  register("teams.openChat", openChat);
  register("teams.findChat", findChat);
  register("teams.newMessage", newMessage);
  register("teams.selectSidebarLayout", chooseSidebarLayout);
  register("teams.refresh", () => refresh());
  register("teams.loadMoreChats", () => refresh(true));
  register("teams.selectProfile", chooseProfile);
  register("teams.setup", () => setup());
  register("teams.guidedSetup", () => guidedSetup.execute());
  register("teams.signInBrowser", () =>
    guidedSetup.execute("browserSignIn", active),
  );
  register("teams.checkForUpdates", () => updates.check(true));
  register("teams.enableReplies", enableReplies);
  register("teams.openTeams", () => openTeams());
  register("teams.signIn", () => signIn());
  register("teams.connect", () => connection("connect"));
  register("teams.disconnect", () => connection("disconnect"));
  register("teams.recover", () => connection("recover"));
  register("teams.selectDesktopAccount", () => chooseDesktopAccount());
  register("teams.diagnostics", diagnostics);
  register("teams.configureCli", async () => {
    const files = await vscode.window.showOpenDialog({
      title: "Select a trusted Teams CLI executable",
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
    });
    if (files?.[0]) {
      await context.globalState.update("cliUpdates.selection", undefined);
      const chosen = files[0].fsPath;
      if (
        chosen === settings().get<string>("cliPath", "") &&
        chosen !== cli?.executable
      ) {
        ++cliChange;
        cliUpgrade.cancel();
        await changeConfiguredCli();
      } else {
        await settings().update(
          "cliPath",
          chosen,
          vscode.ConfigurationTarget.Global,
        );
      }
    }
  });
  register("teams.manageCli", async () => {
    const source =
      cliSelection?.source === "managed"
        ? "Managed by Teams Companion"
        : "Managed by you";
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: `Use recommended CLI ${CLI_VERSION}`,
          description:
            cliUpdateState === "pending"
              ? "Ready · switches when idle"
              : "Verified download · current work is preserved",
          action: "download",
        },
        {
          label: "Select CLI executable",
          description: "Keep managing your own installation",
          action: "select",
        },
        {
          label: settings().get("autoUpdateCli", true)
            ? "Turn off automatic CLI updates"
            : "Turn on automatic CLI updates",
          description: "Applies only to extension-managed installations",
          action: "automatic",
        },
      ],
      {
        title: `Teams CLI ${version || "not selected"} · ${source}`,
        placeHolder:
          cliSelection?.executable || "Choose how to install Teams CLI",
        ignoreFocusOut: true,
      },
    );
    if (choice?.action === "download")
      await vscode.commands.executeCommand("teams.downloadCli");
    else if (choice?.action === "select")
      await vscode.commands.executeCommand("teams.configureCli");
    else if (choice?.action === "automatic")
      await settings().update(
        "autoUpdateCli",
        !settings().get("autoUpdateCli", true),
        vscode.ConfigurationTarget.Global,
      );
  });
  register("teams.downloadCli", async () => {
    if (cliUpdateState === "pending") {
      manualUpgradeRequested = true;
      updateAutomatic = false;
      if (pendingPreparedCli) pendingPreparedCli.retryAt = undefined;
      await cliUpgrade.apply();
      if (cliUpdateState === "pending") {
        const choice = await vscode.window.showInformationMessage(
          cliJoinError
            ? `${cliJoinError} The verified update is kept ready. Recover or disconnect the browser in Connection, then retry.`
            : "The verified CLI update is ready and will switch when current work finishes.",
          "Open Connection",
        );
        if (choice)
          await vscode.commands.executeCommand("teams.connection.focus");
      }
      return;
    }
    const ok = await vscode.window.showInformationMessage(
      `Use verified Teams CLI ${CLI_VERSION} from GitHub? It will be installed in extension storage and selected when current work is idle. Your other CLI installations are left in place.`,
      { modal: true },
      "Use recommended CLI",
    );
    if (!ok) return;
    automaticRequest = false;
    manualUpgradeRequested = true;
    updateAutomatic = false;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Downloading and verifying Teams CLI",
      },
      () => cliUpgrade.request(),
    );
    if (cliUpdateState === "failed")
      await vscode.window.showWarningMessage(
        "The CLI update could not be verified or activated. Your current CLI is unchanged. Retry from Teams: Manage CLI.",
      );
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("teamsCompanion.cliPath")) {
        if (settings().get<string>("cliPath", "") === cli?.executable) return;
        ++cliChange;
        cliUpgrade.cancel();
        void changeConfiguredCli();
      } else if (e.affectsConfiguration("teamsCompanion")) {
        if (e.affectsConfiguration("teamsCompanion.autoUpdateCli")) {
          if (!settings().get("autoUpdateCli", true)) {
            if (updateAutomatic && !manualUpgradeRequested) cliUpgrade.cancel();
          } else void automaticCliUpgrade();
          cliDetailsChanged.fire();
        }
        if (e.affectsConfiguration("teamsCompanion.checkForUpdates"))
          void updates.check();
        renderSidebar();
        scheduleSidebar();
        for (const tab of tabs.values()) {
          update(tab);
          schedule(tab);
        }
      }
    }),
  );
  async function changeConfiguredCli() {
    const change = cliChange;
    const configured = settings().get<string>("cliPath", "");
    if (
      cliSelection?.source === "managed" &&
      managedVersion(configured, context.globalStorageUri.fsPath)
    ) {
      const candidate = new Cli(configured, log);
      try {
        await verifyManaged(configured, context.globalStorageUri.fsPath);
        const nextVersion = await candidate.verify();
        if (
          nextVersion !==
          managedVersion(configured, context.globalStorageUri.fsPath)
        )
          throw new Error(
            "Managed CLI version does not match its installation.",
          );
        usedClis.add(candidate);
        const prepared: PreparedCli = {
          api: candidate,
          version: nextVersion,
          previous: cli,
          selection: cliSelection,
          change,
          automatic: false,
          configured,
        };
        cliUpdateState = "pending";
        cliDetailsChanged.fire();
        while (!disposed && change === cliChange) {
          if (await activatePreparedCli(prepared)) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch {
        if (!disposed && change === cliChange) {
          cliUpdateState = "failed";
          cliDetailsChanged.fire();
        }
      } finally {
        if (cli !== candidate) {
          await candidate.close();
          usedClis.delete(candidate);
        }
      }
      return;
    }
    while (
      !disposed &&
      change === cliChange &&
      (loading ||
        connectionBusy ||
        setupTerminals ||
        guidedSetup.busy ||
        (cli && !cli.idle) ||
        [...tabs.values()].some(
          (tab) =>
            tab.session.sending || tab.session.sendStarting || tab.session.busy,
        ))
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (disposed || change !== cliChange) return;
    const previous = cli;
    cli = undefined;
    cliSelection = undefined;
    version = "";
    ++generation;
    loadAbort?.abort();
    active = undefined;
    allProfiles = [];
    availableProfiles = [];
    chats = [];
    cursor = "";
    for (const tab of tabs.values()) {
      drafts.set(tab.session.scope, tab.session.draft);
      tab.panel?.dispose();
      tab.session.dispose();
    }
    tabs.clear();
    cliDetailsChanged.fire();
    // Clear stale API/session references synchronously before awaiting shutdown.
    const closing = previous?.close();
    void refresh();
    await closing;
  }
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return stopping;
    disposed = true;
    ++cliChange;
    clearInterval(upgradeTimer);
    cliUpgrade.cancel();
    recipientPicker?.dispose();
    clearTimeout(sidebarTimer);
    loadAbort?.abort();
    for (const tab of tabs.values()) {
      clearTimeout(tab.timer);
      tab.session.dispose();
      tab.panel?.dispose();
    }
    stopping = Promise.all([...usedClis].map((api) => api.close())).then(
      () => {},
    );
    return stopping;
  };
  shutdown = stop;
  context.subscriptions.push({
    dispose() {
      void stop();
    },
  });
  void refresh();
  if (context.extensionMode === vscode.ExtensionMode.Production)
    void updates.check();
  scheduleSidebar();
  // Only the isolated extension-host suite receives this inspection surface.
  if (context.extensionMode === vscode.ExtensionMode.Test)
    return {
      snapshot: () => ({
        profile: active?.name,
        chats: chats.length,
        tabs: tabs.size,
        ready,
      }),
      settled: async () => {
        while (loading) await new Promise((r) => setTimeout(r, 20));
      },
      openFirst: () => openChat(chats[0]),
      connection: () => ({ state: connectionState, busy: connectionBusy }),
      cliDetails: () => ({
        version,
        source: cliSelection?.source,
        rows: cliRows().map((item) => ({
          label: item.label,
          description: item.description,
          command: item.command?.command,
        })),
      }),
      sidebarReady: () => sidebar.ready,
      sidebarLayout: () => sidebar.layout,
      accounts: () => ({
        canSwitchProfile: canSwitchProfile(),
        active:
          active?.accountLabel ?? accountLabel(active?.backend ?? "desktop"),
        tabs: [...tabs.values()].map((t) => ({
          profile: t.session.profile.name,
          label: t.session.profile.accountLabel,
        })),
      }),
      refreshTabs: () =>
        Promise.allSettled([...tabs.values()].map((t) => t.session.refresh())),
      conversationPhotos: () =>
        [...tabs.values()].map((t) => ({
          profile: t.session.profile.name,
          photos: withMemberAvatars(t.session.messages, t.chat).filter(
            (m) => m.avatar,
          ).length,
        })),
      recoveries: () =>
        [...tabs.values()].map((t) => t.session.recovery).filter(Boolean),
      webviewsReady: () =>
        [...tabs.values()].filter((t) => t.panel && t.ready).length,
      selectProfile: async (name: string) => {
        const p = allProfiles.find((p) => p.name === name);
        if (!p) throw new Error("Unknown test profile");
        active = p;
        chats = [];
        cursor = "";
        summary();
        await refresh();
      },
    };
}
