# Changelog

## [Unreleased]

### Changed

- Distribute Teams Companion as an explicitly experimental VS Code pre-release, with preview metadata and a verified pre-release VSIX.
- Download the verified Teams CLI 0.2.2 release, including its sign-in, onboarding and credential-store fixes.
- Document that lightweight-browser setup remains CLI-only in this experimental extension.

## [0.1.1] - 2026-10-15

### Added

- Start a conversation from New Message in the Chats toolbar. Search by name or full email, select an exact recipient, then write in an editor tab. Opening a conversation sends nothing and reuses an existing one-to-one chat when available.
- Guard interrupted conversation requests across windows and restarts. Uncertain creation is never automatically retried.

### Changed

- Download the matching Teams CLI 0.2.1 release. Older compatible CLIs keep reading and replies, with a direct update action for New Message.
- Keep compose and refresh in one native toolbar, put search in its own full-width row, and move sidebar layouts to Chats → More Actions → Change Sidebar Layout.

## 0.1.0

- Show available local photos in conversation headers and beside each sender's messages, matched by member identity. Align sender captions to the bubble edge and photos to the bubble, following Teams placement; keep initials when a photo is unavailable.

- Separate message text from compact sender/time captions with theme-aware bubbles and group-start avatars. Group nearby messages only when sender identity matches; keep every timestamp visible and fully dated on hover and to screen readers.

- Hide the sidebar account chooser and chat toolbar shortcut when only one usable account is available. Only Graph profiles with verified account access create another choice; all saved profiles remain accessible in Connection. Availability updates on refresh.

- Replace conversation-header text buttons with compact, accessible icon actions and stable refresh feedback.
- Show configured account types in the sidebar, conversation header, tabs and status bar; keep technical profile names in connection details.
- Add keyboard-accessible account and history details with dated freshness, and explain missing history at the oldest loaded messages.

- Switchable Teams, Compact and Comfortable sidebar layouts with avatars, previews, timestamps, local search, unread/group filters and keyboard navigation.
- Display locally supplied raster avatars with initials fallback; keep remote image requests blocked.
- Refresh the visible sidebar and keep profile, tab and draft state intact when changing layouts.
- Show readable system-event previews and start connection controls collapsed.

- Ask explicitly for Personal or Work/school during setup; Auto-detect is no longer offered.

- Identify mixed-account errors correctly and offer account selection directly in conversation tabs and the sidebar.
- Keep personal and work/school connections in separate profiles without restarting Teams or changing existing tabs’ accounts.

- Visible Connection section with native buttons for desktop connect/disconnect, Graph sign-in, and recovery.
- Guided desktop connection from any profile, with automatic separate-profile setup, explicit restart confirmation, and duplicate-click protection.

- Profile picker and conversation editor tabs with VS Code theme styling.
- Local Teams CLI transport with explicit profiles, JSON output, bounded subprocesses, and stdin-only message bodies.
- Desktop and Graph setup, connection commands, verified CLI download, and metadata-only diagnostics.
- Plain-text history, pagination, paused hidden-tab polling, accessible native-theme controls, and in-memory drafts.
- Opt-in replies with durable uncertain-send guards and exact-ID reconciliation.
