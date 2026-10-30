# Mina Architecture

This document explains how Mina is put together: what each module does, how a request moves through the system, and how processes are discovered, started and stopped. Read it before you change anything non-trivial.

## Design principles

- **No runtime dependencies.** Only Node.js built-ins (`http`, `fs`, `child_process`, `crypto`). Installing it is instant and there is no supply-chain surface.
- **Discovery over configuration.** Mina should be useful the first time it opens, before you have added anything.
- **The OS is the source of truth.** A project counts as "running" because something is actually listening in its folder, not because Mina remembers starting it.
- **Secure by default.** Anything that can start or kill processes has to be impossible for a web page to trigger.
- **Polling only while someone is watching.** Mina does no background work while the dashboard is idle.

## Repository layout

```text
mina/
├── bin/
│   └── cli.js          CLI entry: flags, "already running?" check, startup entries
├── server.js           HTTP server, security checks, API routes, discovery and classification
├── projects.js         Saved projects: detection, config, start/stop, logs, groups
├── platform.js         Per-OS code: listing listeners, launching, killing, folder picker
├── runners.js          Per-technology: how to recognise and run Node, Django, Laravel, Rails, Go, Rust, .NET
├── ides.js             Detecting installed editors and opening folders in them
├── index.html          Dashboard shell (the server injects the session token)
└── public/
    ├── style.css
    ├── img/            Logo, wordmark, favicon
    └── js/
        ├── core.js     Shared state, icons and the API client (adds X-Token)
        ├── views.js    Sidebar, project views and previews
        ├── actions.js  Start, stop, add and group actions
        ├── logs.js     Live log viewer (streams NDJSON)
        └── ui.js       Feedback helpers (busy buttons, spinners, messages)
```

## Module responsibilities

### `bin/cli.js`
- Parses `--port`, `--no-open`, `--help`, `--version`, `install-startup` and `uninstall-startup`.
- Before starting a second copy, it requests `/` on the target port and looks for a `<title>Mina` page. If Mina is already running, it just opens the browser.
- Writes the startup entry for the current OS (VBS, LaunchAgent or XDG `.desktop`). The entry runs the **exact** Node binary and script path, so it doesn't rely on `PATH` at login.

### `server.js`
- Creates the HTTP server on `127.0.0.1` and applies every security check (see [Security model](#security-model)).
- **Discovery pipeline** (`getApps`):
  1. `platform.listListeners()` returns one entry per (port, process): `{ port, pid, addrs, name, cmd, cwd?, chain? }`. Two processes can hold one port number, one on IPv4 and one on IPv6 (an editor extension on `127.0.0.1:3000` next to NestJS on `[::]:3000`), so entries are never merged by port.
  2. Filter out Mina's own port, ports below 1024, system processes and (unless `?all=1`) anything that isn't a dev runtime or that lives in editor tooling folders.
  3. `probe()` sends an HTTP GET to the loopback addresses that reach that process (`hostsFor`). It never asks an address another process holds on the same port, and it skips the loopback-only ports of a process that also listens on all interfaces (Next.js keeps an internal one). A page that answered is cached for 30 s per (pid, port). Requests that arrive during a scan share it.
  4. `findProject()` walks up from paths in the command line (or the process's working directory) to the nearest project file (`package.json`, `manage.py`, `artisan`, `bin/rails`, `go.mod`, `Cargo.toml`, `*.csproj`; see `runners.identify`).
  5. `classify()` decides frontend or backend and the framework from the dependencies. Backend dependencies win, because an API may list `react` for emails. If nothing matches, the `text/html` content type decides.
  6. Backends are probed on `DOC_PATHS` once per (pid, port) to list working documentation and health endpoints, so the probes don't fill the server's log. If two shown processes share a port, the one Mina launched, or else the one linked to a project, is listed.
- **Group orchestration** (`runGroup`): starts the backends in one wave, waits up to 90 s until they are listening (or have exited), then starts the frontends.
- **Port conflicts** (`portConflict`): compares the project's last known port with the current listeners.

### `projects.js`
- Stores the config in `~/.mina/config.json`. A project's ID is the first 10 hex characters of the SHA-1 of its normalized path.
- `detect(dir)` asks `runners.js` how to run the folder. For Node, that means the first script in `dev → start:dev → develop → serve → start`, with the package manager taken from the lockfile.
- `start()` re-detects the folder at start time and runs that command. The `script` and `pm` saved in the config are only for display, so editing the config can't change what runs.
- `scan(dir)` looks one level down. Child projects win over the parent folder, because a workspace root's `dev` script usually just runs the children.
- `start()` validates the script name and package manager against an allow-list, then calls `platform.launch()` with a clean environment (`BROWSER=none`, `FORCE_COLOR=0`, no `ELECTRON_RUN_AS_NODE`).
- `stop()` kills every PID listening in the project's folder, plus the launcher PID recorded in the `.pid` file. If the launch is still in flight, it cancels it instead.
- **Launcher ownership.** The `.pid` file holds `<pid> <startTime>`. After a crash or a reboot the OS can hand the same PID to an unrelated process, so a PID only counts as Mina's while that process's start time still matches (`platform.startTimes`). `refreshOwnership()` checks this before API requests (at most once every 1.5 s), and `stop()` checks again right before killing. A PID that doesn't match is never adopted, killed or used to attribute listeners. A listener counts as Mina's when the launcher is the listener itself or one of its ancestors: `sh` and `cargo run` exec into the server and keep the launcher's PID.
- **One start at a time.** `claim(id)` reserves a project from the moment a start is requested. A second click gets `alreadyStarting`, and a stop at any point marks the claim cancelled, so the launch is skipped, or killed as soon as it has a PID.
- `withStatus()` works out each project's state:

  | State | Meaning |
  |---|---|
  | `running` | A listener belongs to the project's folder |
  | `queued` | Waiting for its turn in a *Start group* run |
  | `starting` | Mina launched it and the process is alive, but nothing is listening yet |
  | `crashed` | Mina launched it and it exited before it listened |
  | `stopped` | None of the above |

- Groups: an explicit `group` string wins (`""` means no group). Otherwise, projects that share a parent folder are grouped under that folder's name.

### `runners.js`
One entry per technology, in priority order: Laravel, Rails, Django, Node, Go, Rust, .NET. Each one has:
- `match(dir)`: the files that mark it,
- `name(dir)`: the project name,
- `command(dir)`: the command that runs it,
- `install(dir)`: what to install first, if anything.

Laravel and Rails come before Node because their `package.json` only builds assets. Go, Rust and .NET come after Node, because a `go.mod` next to a runnable `package.json` is usually tooling.

- `detect(dir)` returns plain data for a runnable folder: the command, the framework, and the install step.
- `identify(dir, { js })` is looser and is used to attribute a running server: a `package.json` without scripts still names a Node project, and a JS process inside a Laravel folder belongs to its `package.json`.
- **Commands are built only from constants** and from names checked against `SAFE` (`^[\w.-]+$`), never from file contents or the config. `safeCommand()` checks every command one last time against `^[\w .:\\/-]+$`, so no shell operator can reach `cmd.exe` or `sh`.
- Django's interpreter is the project's own virtualenv (`.venv`, `venv`, `env`) if one exists, as a relative path: the command runs inside the project folder, so the folder's name never enters it.

### `platform.js`
Everything that differs between operating systems lives here, behind one interface:

| Function | Windows | macOS / Linux |
|---|---|---|
| `listListeners` | PowerShell `Get-NetTCPConnection` + process info | `lsof -iTCP -sTCP:LISTEN` + `ps`, cwd via `lsof`/`/proc` |
| `launch` | `Start-Process cmd.exe` hidden; `cmd` redirects the output to env-var paths; the working folder is wildcard-escaped (so `[ ]` is safe); PID + start time written to a file | `/bin/sh -c` with `detached: true` (new process group); PID + start time written to a file |
| `startTimes` | `Get-Process` StartTime | `/proc/<pid>/stat` (Linux), `ps -o lstart` (macOS) |
| `killTree` | `taskkill /PID <pid> /T /F` | `SIGTERM` to `-pid`, then `SIGKILL` after about 3 s |
| `pickFolder` | Modern Explorer folder dialog (`IFileOpenDialog`) | Finder via `osascript` (macOS), `zenity` or `kdialog` (Linux) |
| `openUrl` | `rundll32 url.dll,FileProtocolHandler` | `open` / `xdg-open` |

On Windows, the paths and the command reach PowerShell **as environment variables**, never by string interpolation. Folder names with quotes or non-Latin characters (such as Arabic) can't break the command.

### `ides.js`
Finds installed editors by known install paths (Windows), app bundle names (macOS) or launcher commands on `PATH` (Linux). JetBrains IDEs on Windows sit in versioned folders and are found by scanning for them.

## Request lifecycle

```text
Browser ──GET /──────────────► server.js ── reads index.html, swaps __TOKEN__ for the session token
Browser ──GET /api/apps──────► Host ✓  Origin ✓  X-Token ✓ ─► getApps() ─► { apps, projects }
Browser ──POST /api/...──────► Host ✓  Origin ✓  X-Token ✓  Content-Type: application/json ✓ ─► route
```

## HTTP API

Every `/api/*` request must carry the `X-Token` header. Every `POST` must use `Content-Type: application/json`.

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/apps[?all=1]` | — | Scan listeners; returns running apps and saved projects with status |
| GET | `/api/ides` | — | Installed editors |
| POST | `/api/kill` | `{ pid }` | Kill a PID from the latest scan, or one Mina spawned |
| POST | `/api/pick-folder` | — | Open the native folder picker |
| POST | `/api/open` | `{ ide, dir }` | Open a **known** folder in an editor |
| POST | `/api/projects/scan` | `{ dir }` | Find runnable projects in a folder |
| POST | `/api/projects/add` | `{ dirs: [] }` | Save projects |
| POST | `/api/projects/remove` | `{ id }` | Remove from the list (files are untouched) |
| POST | `/api/projects/set-group` | `{ id, group }` | Assign a group |
| POST | `/api/projects/start` | `{ id, install?, force? }` | Start; may return `needsInstall`, `conflicts` or `alreadyRunning` |
| POST | `/api/projects/stop` | `{ id }` | Stop the whole process tree |
| POST | `/api/projects/logs/stream` | `{ id }` | Held-open NDJSON stream of `{ out, err }` chunks |
| POST | `/api/groups/start` | `{ group, install?, force? }` | Start the group: backends first, then frontends |
| POST | `/api/groups/stop` | `{ group }` | Stop every member |
| POST | `/api/groups/rename` | `{ group, name }` | Rename (turns an automatic group into an explicit one) |
| POST | `/api/groups/remove` | `{ group }` | Stop and remove every member from the list |

**Why NDJSON over `fetch` instead of `EventSource`?** `EventSource` can't send custom headers, so it couldn't carry `X-Token`. The stream reads the log files every 700 ms and stops as soon as the tab closes.

## Security model

The threat: **any website open in your browser can send requests to `http://localhost:*`**. Without protection, a malicious page could start commands or kill processes on your machine.

| Check | Where | Notes |
|---|---|---|
| Bind to `127.0.0.1` | `server.listen` | Never reachable from the network |
| `Host` allow-list | first check on every request | Defeats DNS rebinding |
| `Origin` allow-list | every `/api/*` request | Cross-site calls get `403` |
| Session token | every `/api/*` request, `crypto.timingSafeEqual` | 24 random bytes per start, injected only into the HTML page |
| JSON-only POST | every mutating route | A plain HTML form can't produce it, and it forces a CORS preflight |
| PID allow-list | `/api/kill` | Only PIDs from the latest scan, or Mina's launchers whose start time still matches |
| Crash containment | request handler | Any exception becomes a `500` for that request only; a malformed URL gets `400`; a body over 1 MB gets `413` |
| Folder allow-list | `/api/open` | Saved projects, group roots and running apps only |
| Script allow-list | `projects.start` | Script must match `^[\w:.-]+$`; the package manager must be npm, pnpm, yarn or bun |
| Static path containment | static file handler | The resolved path must stay inside `public/` |
| Anti-framing | dashboard response | `X-Frame-Options: DENY`, `frame-ancestors 'none'` |

## Data on disk

```text
~/.mina/
├── config.json          { projects: [{ id, dir, name, script, pm, group?, lastPort? }] }
├── mina.log             (macOS LaunchAgent only) stdout/stderr of Mina itself
└── logs/
    ├── <id>.log         stdout of the latest run
    ├── <id>.err.log     stderr of the latest run
    └── <id>.pid         "<pid> <startTime>" of the launcher, so Mina still recognizes its own servers after a restart
```
