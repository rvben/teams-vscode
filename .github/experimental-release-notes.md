Teams conversations inside VS Code, available as an **experimental pre-release**.

## Install

1. Download the attached VSIX. Its SHA-256 checksum is in `SHA256SUMS`.
2. In VS Code, choose **Extensions → … → Install from VSIX**.
3. Open **Teams** in the activity bar. Choose **Download verified CLI**, or select an existing compatible Teams CLI.
4. In **Chats → …**, choose **Guided Account Setup** to connect a personal or work/school account. You can also connect the signed-in desktop app through **Connection**, or use **Advanced Profile Setup** for Graph and manual profiles.

## Included

- Conversations in editor tabs, opt-in replies, and a New Message recipient picker.
- Three sidebar layouts, local avatars, previews, search, and account selection.
- Guided account setup in a dedicated VS Code terminal, using the CLI’s browser, account and port checks.
- Browser sign-in, saved-session reconnect, disconnect and recovery controls.
- Optional daily GitHub update notifications, manual update checks and per-version skipping. Updates remain manually installed.
- Recovery for a closed desktop session that left a stale active connection record.
- Durable guards for uncertain sends and conversation creation; no automatic retries.
- Verified Teams CLI 0.2.2 downloads for supported hosts.

## Current limits

- This is an early testing release, distributed through GitHub. VSIX installation does not enable automatic Marketplace updates.
- Lightweight-browser connections support personal accounts. The guided CLI wizard checks which other connections are supported on this computer.
- Guided setup and browser sign-in require a local VS Code window. Existing local connections remain available from WSL and SSH windows.
- Desktop history is cached and may be incomplete. The extension runs on the local VS Code host, including in WSL and SSH windows.
- Attachments, reactions, mentions, edits, channels, calls, and invitations are not implemented.
- Automated tests use synthetic accounts and data; they do not replace validation with your organization's account and policies.

Replies start disabled. Enable them explicitly for a writable profile. Use the Connection section to disconnect desktop debugging when finished. Read the [README](https://github.com/rvben/teams-vscode#readme) for connection details and troubleshooting.
