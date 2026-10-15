Teams conversations inside VS Code, available as an **experimental pre-release**.

## Install

1. Download the attached VSIX. Its SHA-256 checksum is in `SHA256SUMS`.
2. In VS Code, choose **Extensions → … → Install from VSIX**.
3. Open **Teams** in the activity bar. Choose **Download verified CLI**, or select an existing compatible Teams CLI.
4. Connect Teams Desktop or configure Microsoft Graph, then open a conversation.

## Included

- Conversations in editor tabs, opt-in replies, and a New Message recipient picker.
- Three sidebar layouts, local avatars, previews, search, and account selection.
- Clickable connection setup, disconnect and recovery controls.
- Durable guards for uncertain sends and conversation creation; no automatic retries.
- Verified Teams CLI 0.2.2 downloads for supported hosts.

## Current limits

- This is an early testing release, distributed through GitHub. VSIX installation does not enable automatic Marketplace updates.
- Lightweight-browser onboarding is currently available only in the CLI.
- Desktop history is cached and may be incomplete. The extension runs on the local VS Code host, including in WSL and SSH windows.
- Attachments, reactions, mentions, edits, channels, calls, and invitations are not implemented.
- Automated tests use synthetic accounts and data; they do not replace validation with your organization's account and policies.

Replies start disabled. Enable them explicitly for a writable profile. Use the Connection section to disconnect desktop debugging when finished. Read the [README](https://github.com/rvben/teams-vscode#readme) for connection details and troubleshooting.
