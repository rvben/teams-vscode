# Teams Companion for VS Code

Read Teams conversations in editor tabs and write a reply beside your code. A theme-aware sidebar lists chats; each conversation stays bound to the profile shown in its title.

This is a desktop VS Code extension backed by [Teams CLI](https://github.com/rvben/teams-cli). It supports Microsoft Graph profiles and the CLI's experimental desktop backend for personal and work/school Teams. Desktop history comes from Teams' local cache and can be incomplete.

## Install locally

1. Install the provided VSIX using **Extensions → … → Install from VSIX**.
2. Open the Teams activity-bar view. Select an existing CLI executable, or choose **Download verified CLI** to download version 0.2.1 from the CLI's official GitHub release. The extension checks the archive against the release's SHA-256 checksum before extracting it into extension storage.
3. In the sidebar’s **Connection** section, click **Connect Teams Desktop**. Choose personal or work/school and the profile’s access. The extension creates a separate desktop profile if needed, or uses an existing one. To use Microsoft Graph instead, click **Sign in to Microsoft Graph** or **Choose profile**.
4. Open a conversation from the sidebar or use **Teams: Find Conversation**.

Requires VS Code 1.96 or newer. Teams CLI 0.2.1 or newer stable supports all features, including New Message. Older stable versions from 0.1.11 can still read conversations and reply; New Message offers a CLI update when needed. The built-in download supports macOS Intel/Apple Silicon, Windows x64 (including x64 emulation on ARM64), and Linux x64. On other hosts, supply a compatible CLI yourself. The extension does not run in vscode.dev or other browser-only extension hosts.

## Choose a connection

**Desktop Teams** uses the signed-in desktop app. The sidebar’s **Connection** section always shows the connection state and clickable actions for connecting, disconnecting, or recovering. **Connect Teams Desktop** works even when your current profile uses Graph; you do not need to configure a desktop profile in a terminal first. The setup wizard creates a separate profile with an explicit personal or work/school account selector. Profiles default to read-only. Click **Connect Teams Desktop** to open the local debugging connection; this asks before a possible Teams restart. A restart can end a call. While the port is open, programs running as you can access the signed-in session. Use **Disconnect Teams Desktop** afterward, or **Teams: Recover Desktop Connection** after an interrupted setup. Connecting never happens automatically at extension activation. Setup always asks you to choose Personal or Work/school. Existing CLI profiles may still use Auto-detect; if personal and work/school Teams windows are both open, those profiles refuse to choose between them. Click **Choose Teams account** in the Connection section or conversation error banner. The extension creates or reuses a separate profile for the selected account, keeping existing tabs and drafts tied to their original profile; this does not restart Teams.

**Microsoft Graph** uses a work/school account. Setup opens a dedicated terminal for the CLI's device-code sign-in. Complete sign-in yourself, then refresh the conversation list. The extension does not handle passwords or store access tokens. Run **Teams: Sign In to Graph Profile** if sign-in expires.

The extension runs in the **local UI extension host**. In a WSL, SSH, or container window, it uses the CLI and profiles on the machine running VS Code. On Windows with a WSL workspace, select a Windows `teams.exe` or use the built-in Windows download. Profiles configured only inside WSL are separate; choose or create the corresponding Windows profile. Linux desktop Teams attachment is not supported by the CLI; Graph remains available there.

## Make the sidebar yours

In the **Chats …** menu, choose **Change Sidebar Layout** to switch instantly between three layouts. The same choice is available in Settings as `teamsCompanion.sidebarLayout`:

| Layout      | Conversation rows                                              |
| ----------- | -------------------------------------------------------------- |
| Teams       | Avatars, one-line previews, timestamps and unread indicators.  |
| Compact     | Smaller avatars and single-line rows for a longer list.        |
| Comfortable | Larger avatars and two-line previews with more breathing room. |

Your choice persists across windows. Switching layouts keeps the selected profile, open conversation tabs and drafts intact. Use **Search loaded chats**, **Unread**, or **Groups** to narrow the current list. **Load more conversations** expands that list; search does not query all Teams history. Arrow keys move between rows; Enter opens a conversation. Refreshing keeps your scroll position.

Avatars use raster photos supplied by the CLI, with initials when a photo is unavailable. The optional desktop photo support reads only avatars already loaded in the selected Teams page; it never downloads remote images or opens another account. Older CLI versions and Graph profiles show initials. Unread indicators appear only when the CLI provides unread state or comparable read/message timestamps. Missing status is not treated as unread. Opening a conversation does not mark it read in Teams.

The Chats view refreshes at the configured interval while visible. The native Connection section starts collapsed, with a plug button beside the profile for quick access.

## Start a conversation

Click the **New Message** compose icon in the Chats title bar, or run **Teams: New Message**. Search by name or full email address, then select the exact person. The picker shows the account/profile and each result’s address or Teams identity. Selecting a person opens or creates a one-to-one conversation in an editor tab; no message is sent until you press **Send**. Existing conversation tabs are reused.

New conversations require a writable profile and replies enabled. Personal Teams uses Teams’ own live people search and contacts; discoverability settings can limit results. Work/school Graph search requires `User.ReadBasic.All`; sign in again to grant it. Organization policies can restrict who you can contact. Groups, phone/SMS invitations and off-network email invitations are not supported.

This feature needs a CLI build advertising `people search` and `chats create` in its schema. Older CLIs keep reading and replying normally and explain the missing capability when you choose New Message. Chat creation is never retried automatically. An uncertain creation is guarded across windows/restarts; check Teams before explicitly trying again. This guard stores no recipient names, addresses, or message text.

## Read and reply

- **Refresh** loads the latest available history; **Load older messages** pages backward. Incoming messages leave your reading position in place and offer a jump to the latest message.
- **Teams: Find Conversation** searches the conversations loaded in the sidebar. Load more conversations to expand that set.
- Replies require both a writable CLI profile and **Teams: Enable Replies**. The extension starts with replies disabled.
- By default **Ctrl+Enter** or **Cmd+Enter** sends; Enter inserts a line. `teamsCompanion.sendOnEnter` changes this to Enter, with Shift+Enter for a new line. IME composition and paste never trigger a send.
- Messages are plain text. Attachments, reactions, mentions, edits, channel threads, and calls are not implemented. Received HTML is converted to text; remote images and message HTML never execute.
- A submitted message is not proof of delivery. If a send times out, the CLI exits unexpectedly, or Teams reports an uncertain result, replies in that conversation are blocked. **Check send status** uses the exact client message ID when available. Absence from cached history never proves failure. If no ID is available, check the conversation in Teams. **I checked in Teams…** requires a confirmation before unlocking replies; review the retained draft carefully to avoid duplicates.

Drafts stay in memory across refreshes and closing/reopening a tab. They are lost when the extension host exits. Message bodies are not written to draft files or logs. A small journal containing operation IDs, timestamps, and optional client message IDs preserves uncertain-send protection across restarts and multiple VS Code windows. Journal filenames hash the profile/config/chat scope. No send is retried automatically.

## Settings and troubleshooting

| Setting                              | Default | Purpose                                                                                                                        |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `teamsCompanion.cliPath`             | empty   | Absolute executable path; otherwise PATH or the verified download. Machine-scoped, never a workspace command.                  |
| `teamsCompanion.repliesEnabled`      | `false` | Permit replies when the CLI profile allows them.                                                                               |
| `teamsCompanion.pollIntervalSeconds` | `30`    | Visible sidebar and conversation refresh interval, 10–300 seconds. Hidden views pause polling; conversation failures back off. |
| `teamsCompanion.sidebarLayout`       | `teams` | Choose Teams, Compact, or Comfortable sidebar rows.                                                                            |
| `teamsCompanion.sendOnEnter`         | `false` | Send with Enter; Shift+Enter inserts a line.                                                                                   |

Run **Teams: Show Connection Diagnostics** for an output channel containing allowlisted host/backend/error metadata. It excludes message bodies, raw CLI output, account identities, tokens, profile names, and chat IDs. For account or cache issues, open Teams itself and refresh there. The extension shows history under the account selected by the CLI; it cannot independently verify a desktop account's identity. Avoid switching Teams accounts during an active send.

No telemetry is collected. Normal reads and sends go through the chosen CLI backend. Explicit download requests contact GitHub using a generic User-Agent. **Open Teams** opens the appropriate Teams website in your browser. No conversation body or identifier is placed in that URL.

## Development

Node.js 22 or newer:

```sh
npm ci
npm run check
npm test
npm run build
npm run test:ui
npm run test:host
npm run package
```

The UI suite uses Playwright Chromium; install it with `npx playwright install chromium`, or set `CHROME_PATH` to an existing Chrome for Testing / headless-shell binary. On macOS, avoid launching system Chrome for automated checks. The extension-host suite uses installed VS Code on macOS; set `VSCODE_EXECUTABLE` elsewhere or let the official test runner download it. It uses isolated user data and synthetic fixtures, with real writes disabled in the fake CLI. Desktop setup and connection regression tests use an in-memory host and cannot restart Teams. F5 opens a separate Extension Development Host.

The VSIX includes only bundled runtime code, the theme stylesheet, the activity-bar SVG, this README, changelog, license, and manifest. Tests, synthetic data, local research, design documents, and screenshots are excluded. Packaging is local; it does not publish to the Marketplace.
