# Contributing

Use GitHub issues for bugs and proposals. For security issues, follow [SECURITY.md](SECURITY.md). Bug reports should describe the platform, extension and CLI versions, connection type, expected behavior, and reproduction steps. Use synthetic examples and omit account identities and conversation contents.

## Development

Use Node.js 22 or newer. The regular test suites use synthetic data and do not require a Microsoft account.

```sh
npm ci
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:ui
npm run test:host
npm run package
```

On Linux, run the extension-host suite with `xvfb-run -a npm run test:host` in a graphical-test environment. The host suite downloads and caches an official VS Code test build unless `VSCODE_EXECUTABLE` points to an existing installation. UI tests can use an existing Chrome for Testing or headless-shell binary through `CHROME_PATH`. Avoid system Chrome for automated macOS checks.

Press F5 to open an Extension Development Host. Keep tests synthetic: never commit real messages, contacts, tokens, browser profiles, Teams caches, personal filesystem paths, or screenshots from signed-in accounts. Test output, local research, and generated VSIX files belong outside Git.

Changes should include the relevant checks and a Conventional Commit message. Pull requests from contributors and dependency bots require review and passing platform checks. Keep the history linear; maintainers integrate with squash or fast-forward.

## Experimental releases

Use `vership status`, `vership config show`, and the installed command's `--help` before release work. Prepare with `vership bump patch --prepare`, then review and test the prepared commit. Do not bump a prepared version again.

After publication is approved, run `vership release` on `main`. The version-tag workflow runs platform checks, builds a pre-release VSIX, and publishes a GitHub pre-release with `SHA256SUMS`. It does not publish to the Marketplace. Wait for the workflow and run `vership verify <version> --targets git,github` before declaring the release complete.

The VSIX packager verifies a strict file allowlist, version and channel metadata, and bundle contents. The GitHub workflow pins its actions to immutable commits. Releases must preserve the tested commit and pass the repository's privacy review, including Git history and the extracted VSIX.
