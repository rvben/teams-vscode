# Security

Teams Companion is experimental. Security fixes target the latest published pre-release; update both the extension and its Teams CLI backend when a fix is available.

Report vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/rvben/teams-vscode/security/advisories/new). Include affected versions, the impact, and reproduction steps using synthetic data. Keep account credentials, session tokens, message contents, and account identifiers out of public issues.

The extension has no telemetry. It invokes a local CLI, renders received messages as inert text, and allows only local raster avatars. CLI downloads require HTTPS and checksum verification. Replies are opt-in, and uncertain submissions are never automatically retried.

Desktop mode opens a local debugging connection to the signed-in Teams app after confirmation. Other processes running as the same user may access that session while the connection is enabled. Disconnect from the extension when finished. The extension cannot independently verify the account identity exposed by Teams' desktop cache.

These controls do not replace a security audit. Report suspected issues privately rather than testing against someone else's account.
