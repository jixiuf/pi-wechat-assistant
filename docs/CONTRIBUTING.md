# Contributing

English | [简体中文](CONTRIBUTING.zh.md)

Thank you for helping improve pi-wechat-assistant. For larger changes, open an issue describing the problem and proposed behavior before implementation.

## Development setup

Use Node.js 22 and npm for development, matching CI. The package's declared runtime minimum is Node.js 20.3.0; the development CI does not verify every supported Node.js version.

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
npm ci
npm run check
```

Pi loads the TypeScript entry directly. No separate build step or generated `dist/` directory is needed to develop this extension.

## Checks

| Command | Purpose |
| --- | --- |
| `npm run check` | Source type checks, tests, and npm package contents |
| `npm run typecheck` | Check runtime TypeScript sources |
| `npm test` | Run all tests once |
| `npm run test:watch` | Watch tests while developing |
| `npm run typecheck:pi` | Check published Pi API declarations across seven versions |
| `npm run check:package` | Inspect the publish file list without creating an archive |

The compatibility check downloads published declarations on its first run and caches them under `node_modules/.cache/pi-wechat-compat/`. It does not replace installed dependencies or test real WeChat delivery.

For example, run a focused test with `npm test -- tests/messaging/message.test.ts`. Integration tests in `tests/integration/` load the public root entry with mocked Pi and WeChat dependencies.

## Code organization

See [Architecture](architecture.md) for directory responsibilities and runtime flow. Place tests in the matching domain directory; use `tests/integration/` for behavior spanning multiple modules.

Follow the existing style: TypeScript, ESM, two-space indentation, single quotes, and no semicolons. Use `.js` suffixes for relative TypeScript imports to match Node16 module resolution. Keep Pi imports type-only where possible so both supported package namespaces remain usable.

Keep changes focused. Add regression coverage for behavior changes, update both READMEs when user-facing instructions change, and avoid committing generated output, received files, credentials, or logs. Use `.editorconfig` for editor settings; formatting is not currently enforced by a formatter or linter.

Keep the English project overview in `README.md` and its Simplified Chinese translation in `README.zh.md`. Place detailed guides in `docs/`, with English in `name.md` and Chinese in `name.zh.md`. Keep language-switch links and both versions up to date. See the [documentation index](README.md).

## Issues and pull requests

For issues, PR descriptions, comments, replies, and review feedback, write the complete English content first, followed by the complete corresponding Chinese content. Do not alternate languages by paragraph or subsection; issue and PR templates follow the same structure. Documentation is excluded from this communication rule and uses separate language files as described above. Be respectful and include reproduction steps, environment versions, and the checks you actually ran.

Before opening a PR, run `npm run check` and `npm run typecheck:pi`. CI runs the main checks on Linux and Windows, and the Pi compatibility check on Linux. Describe any manual verification separately from automated tests.

For sensitive reports, see [Security](SECURITY.md).

## Releases

Maintainers update the version in `package.json` and `package-lock.json`, add the matching `## [x.y.z]` section to `CHANGELOG.md`, and run both check commands before creating a release tag. The publish workflow validates the tag, runs the checks again, publishes to npm, and creates a GitHub Release from the changelog. Publishing and pushing tags require an explicit release decision.
