# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-30

First public release.

### Discovery
- Finds every dev server listening on your machine, including ones started from a normal terminal, and matches it to its project folder.
- Labels each server as frontend or backend, with its framework: Next.js, Vite, Nuxt, Angular, Astro, SvelteKit, Gatsby, Vue, React, CRA, NestJS, Express, Fastify, Koa, Hapi, Hono, AdonisJS, Django, Laravel, Rails, Go, Rust and .NET.
- Frontends open in an embedded preview. For backends, Mina lists the documentation and health endpoints that answer (`/docs`, `/swagger`, `/health`, `/graphql`…).
- Editor tooling and system services are hidden unless *Show everything* is on. A dev server that shares its port number with an editor extension (one on IPv4, the other on IPv6) is still found, and probed on its own address.
- Probes stay out of your server logs as much as possible: documentation paths are checked once per server process, and a page that answered is trusted for 30 seconds.

### Running projects
- Add a project folder, or a parent folder with several projects inside.
- Start, stop, groups and logs work for Node.js (npm, pnpm, yarn, bun), Django (using the project's virtualenv), Laravel, Rails, Go (including the `cmd/server` layout), Rust and .NET.
- A project still booting when Mina restarts (a long first build) keeps showing as starting, and can't be started twice.
- Asks before installing missing dependencies (`npm install`, `composer install`).
- Stop ends the whole process tree, so no orphaned server keeps a port.
- Duplicate starts are refused, and a stop pressed during startup cancels the launch.
- Live logs with errors highlighted, kept under `~/.mina/logs/`.
- Groups, automatic by parent folder or named by you. *Start group* starts backends first and frontends once the backends are listening.
- Warns when a project's usual port is taken by something else.
- Servers Mina started are still recognised after Mina restarts.
- Every open tab stays current: a change made in one tab shows in the others at once, coming back to a tab refreshes it, and a visible tab checks every 20 s for servers started or stopped outside Mina. If Mina restarts, open tabs reload themselves.
- The live preview has a reload button.
- Opens a project or a group in VS Code, Cursor, Windsurf, Zed, Sublime Text, JetBrains IDEs and others.

### Command line
- `mina`, `--port` / `--port=` / `MINA_PORT`, `--no-open`, `--version`, `--help`.
- `install-startup` and `uninstall-startup` on Windows, macOS and Linux.

### Security
- Listens on `127.0.0.1` only, with a per-session token, Origin and Host checks against DNS rebinding, JSON-only POST, and anti-framing headers.
- Only stops processes from its latest scan, or launchers it verified as its own by PID and start time, so a recycled PID is never killed.
- The command for a project is derived from its folder at start time, never read from the config, and checked against a strict character allow-list before it reaches the shell.
- Malformed requests are answered with an error and can't take the server down.

### Quality
- Automated test suite (`npm test`, built on `node:test`, no dependencies) that starts and stops real servers.
- CI on Windows, macOS and Linux with Node 18, 20, 22 and 24, against Python, PHP, Ruby, Go, Rust, .NET, Deno and Bun, and with npm, pnpm, yarn and bun.

[Unreleased]: https://github.com/youssef-hataba/Mina/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/youssef-hataba/Mina/releases/tag/v0.1.0
