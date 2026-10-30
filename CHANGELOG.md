# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Start, stop, groups and logs for **Django, Laravel, Rails, Go, Rust and .NET** projects, not just Node.js. The command is worked out from the folder (`manage.py`, `artisan`, `bin/rails`, `go.mod`, `Cargo.toml`, `*.csproj`), and Django uses the project's virtualenv. Laravel offers `composer install` when `vendor/` is missing. Running servers of these kinds are labelled with their framework.
- Servers Mina started itself are always listed, even when the binary isn't named after a known runtime (compiled Go, Rust and .NET servers).
- Automated test suite (`npm test`, built on `node:test`, no dependencies) and CI on Windows, macOS and Linux with Node 18–24.

### Security
- What runs for a project is now always derived from the folder at start time, never read from `config.json`, so a hand-edited config can't choose the command. Every command is also checked against a strict character allow-list before it reaches the shell.
- A malformed URL (e.g. `/%ff.css`) or a non-ASCII `X-Token` header crashed the server. Any web page could trigger the first one through an `<img>` tag. Neither can crash it now, and no single request can take the server down.
- A PID left behind by a server that has since exited (after a crash or a reboot) could be reused by the OS for an unrelated process, which Mina would then adopt and kill. Mina now records each launcher's start time and only trusts a PID while the start time still matches.

### Fixed
- A scan could hang forever when a local server streamed (SSE, long-poll) or stalled after sending headers.
- A group named `toString`, `constructor`, `__proto__`… crashed every page load until the config was edited by hand.
- Starting a project whose folder was deleted crashed Mina on macOS and Linux.
- On Windows, folders with `[` or `]` in their name could not be started.
- Two quick clicks on Start could launch two copies. Stop pressed right after Start could be lost. Cancelling one queued project in a group didn't keep it from starting.
- Projects without dependencies asked to run `install` on every start.
- Two different parent folders with the same name were merged into one group.
- In hoisted monorepos (`root/node_modules/.bin/next`), the server was attributed to the root instead of the app.
- On Windows, servers started from paths with spaces weren't linked to their project.
- Request bodies with non-ASCII paths could be corrupted, and bodies over 10 KB were silently dropped (now up to 1 MB, otherwise `413`).
- Logs could show broken characters when a read ended in the middle of a multi-byte character.
- A corrupt `config.json` was silently replaced by an empty one. It is now kept as `config.json.broken-<time>`, and saves are atomic.
- `mina --port abc`, `--port 70000` and `--port` with no value fell back to 4747 or printed a stack trace. `mina --port N install-startup` ignored the command, and `--port=N` is now supported.
- `mina` exited silently when the port was held by a server that never finished its response.
- On Windows, the startup entry broke for user names with non-ASCII characters. On Linux, it broke for paths containing `%`.
- The dashboard said "Mina was restarted" for any refused action, not just an expired token. Start errors are now shown to the user.
- Scanning a parent folder now also offers the parent app itself when it has helper subprojects (e.g. `e2e/`).
- The preview frame is sandboxed, so a previewed page can't navigate the dashboard.

## [0.1.0] - 2026-10-29

First public release.

### Added
- Automatic discovery of every listening dev server, matched to its project folder, with frontend/backend and framework detection.
- Embedded previews for frontends and documentation/health endpoint detection for backends.
- Adding projects (single folders or parent folders), with package manager and script detection.
- Start and stop with whole-process-tree termination, plus an install prompt when `node_modules` is missing.
- Live log streaming with error highlighting, saved under `~/.mina/logs/`.
- Groups: automatic by parent folder or named by you, with ordered *Start group* (backends first) and port-conflict warnings.
- Open in editor for VS Code, Cursor, Windsurf, Zed, Sublime Text, JetBrains IDEs and more.
- CLI: `--port`, `--no-open`, `install-startup`, `uninstall-startup`.
- Support for Windows, macOS and Linux.
- Security: per-session token, Origin and Host checks, JSON-only POST, PID and folder allow-lists, localhost-only binding, anti-framing.

[Unreleased]: https://github.com/youssef-hataba/Mina/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/youssef-hataba/Mina/releases/tag/v0.1.0
