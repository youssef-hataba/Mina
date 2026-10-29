<p align="center">
  <img src="public/img/mina_Icon.png" width="110" alt="Mina logo">
</p>

<h1 align="center">Mina</h1>

<p align="center">
  <b>One dashboard for every dev server on your machine.</b><br>
  See what's running, on which port, for which project, and start, stop or debug it from a single page.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0b7285.svg"></a>
  <img alt="Node.js 18+" src="https://img.shields.io/badge/node-%3E%3D18-339933.svg?logo=node.js&logoColor=white">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-success.svg">
  <img alt="Windows | macOS | Linux" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-informational.svg">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-blueviolet.svg">
  <a href="https://github.com/youssef-hataba/Mina/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/youssef-hataba/Mina/actions/workflows/test.yml/badge.svg"></a>
</p>

<p align="center">
  <img src="docs/harbor3d.gif" alt="A harbor at night: server-rack boats rest in their berths, one sails in leaving a glowing wake, a dark one boots up and a pulse of light runs across the bay" width="760">
</p>

<p align="center">
  <a href="#-quick-start">Quick start</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-how-it-works">How it works</a> ·
  <a href="#-security">Security</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

*Mina* (ميناء) is Arabic for **harbor**, the place where all your ships come in and dock. Your dev servers are the ships.

## 🧭 The problem

Modern projects rarely run as one process. A typical day looks like this:

```text
:3000  backend         ← which terminal tab was that?
:3001  frontend        ← is it still running, or did it crash?
:5173  admin panel     ← who took this port?
:8080  ???             ← no idea
```

You end up with a dozen terminal tabs, ports you can't account for, a `node` process you have to hunt down in Task Manager, and the same `cd … && npm run dev` routine every morning.

**Mina solves this.** It scans your machine, finds every dev server that is listening, matches each one to its project folder and framework, and gives you one place to **see, start, stop, preview and read logs** for all of them.

## ✨ Why Mina

| | |
|---|---|
| 🔍 **Zero configuration** | Run `mina`. Servers you already started from any terminal show up right away, with no setup files and no wrappers. |
| ⚡ **One click for the whole stack** | *Start group* starts your backends first and starts the frontends once the APIs are listening. |
| 🪶 **Very small** | No runtime dependencies at all, only Node.js built-ins. About 1,800 lines of readable code. |
| 🔒 **Secure by default** | It binds to localhost only, needs a per-session secret token, and checks Origin and Host. Websites you visit can't control it. |
| 🏠 **Your data stays on your machine** | No telemetry, no accounts, no cloud. Everything lives in `~/.mina/`. |
| 🖥️ **Cross-platform** | Windows, macOS and Linux, each using the native tools of the OS. |

## 🚀 Quick start

```bash
npm install -g mina-dev
mina
```

That's it. Mina starts on **<http://localhost:4747>** and opens it in your browser.

> **Requires** Node.js 18 or later.

Want it always available? Run this once and Mina will start in the background every time you log in:

```bash
mina install-startup
```

## 🎯 Features

<p align="center">
  <img src="docs/demo.gif" alt="Mina: starting a project group, reading its logs and previewing the frontend" width="860">
</p>

### Automatic discovery
Mina finds every process listening on a port and works out:
- **Which project** it belongs to, by reading the process command line, its working directory and the nearest `package.json`.
- **What it is:** frontend or backend.
- **Which framework:** Next.js, Vite, Nuxt, Angular, Astro, SvelteKit, Gatsby, Vue, React, CRA, NestJS, Express, Fastify, Koa, Hapi, Hono, AdonisJS and others.

Servers you started yourself from a normal terminal are detected too. Editor tooling (VS Code, Cursor and similar) and system services are hidden by default. Turn on *Show everything* to see them.

### Live previews
- **Frontends** open in an embedded preview inside the dashboard.
- **Backends** are checked on common paths (`/api`, `/docs`, `/swagger`, `/api-docs`, `/health`, `/graphql`), and Mina lists the ones that answer, so your Swagger page is one click away.

### Start and stop projects
- Add a single project folder, or a **parent folder** and Mina finds every project inside it.
- It detects the **package manager** from the lockfile (npm, pnpm, yarn, bun) and the **script** (`dev`, `start:dev`, `develop`, `serve`, `start`).
- It offers to run `install` first when `node_modules` is missing.
- **Stop** kills the whole process tree (`cmd`/`sh` → `npm` → `node`), so no orphaned servers are left holding your ports.

### Logs
Live `stdout` and `stderr` for every project Mina started, with errors highlighted. Logs are saved to disk, so they're still there after a refresh.

### Groups
- Projects that share a parent folder are **grouped automatically**, or you can name groups yourself.
- **Start group** runs your backends first and starts the frontends once the backends are listening.
- **Port conflict warnings:** if a project's usual port is now taken by something else, Mina tells you before it starts.

### Open in your editor
Mina detects installed editors and opens any project or group in one click: VS Code, VS Code Insiders, Cursor, Windsurf, Zed, Sublime Text, Notepad++, Antigravity, and the JetBrains family (WebStorm, IntelliJ IDEA, PyCharm, PhpStorm, Rider, GoLand).

## ⌨️ Commands

| Command | Description |
|---|---|
| `mina` | Start and open the dashboard. If Mina is already running, it just opens it. |
| `mina --port 4321` | Use another port. `MINA_PORT=4321` works too. |
| `mina --no-open` | Start without opening the browser. |
| `mina install-startup` | Start Mina in the background every time you log in. |
| `mina uninstall-startup` | Remove the startup entry again. |
| `mina --version` | Print the installed version. |
| `mina --help` | Show usage. |

`install-startup` writes:

| OS | Startup entry |
|---|---|
| Windows | A hidden `mina.vbs` in the Startup folder (no console window) |
| macOS | A LaunchAgent at `~/Library/LaunchAgents/dev.mina.plist` |
| Linux | An XDG autostart entry at `~/.config/autostart/mina.desktop` |

## ⚙️ How it works

```text
            ┌──────────────────────────────────────────────┐
            │                Browser (UI)                  │
            │      http://localhost:4747 + secret token    │
            └───────────────────────┬──────────────────────┘
                                    │  JSON API (X-Token)
            ┌───────────────────────▼──────────────────────┐
            │              Mina server (Node)              │
            │   discovery · probing · projects · logs      │
            └───────┬──────────────┬──────────────┬────────┘
                    │              │              │
         list listeners      HTTP probe     spawn / kill tree
     (PowerShell / lsof)   (title, docs)   (Start-Process / sh)
                    │              │              │
            ┌───────▼──────────────▼──────────────▼────────┐
            │      Your dev servers  :3000 :5173 :8080     │
            └──────────────────────────────────────────────┘
```

1. **Discover.** List every TCP listener using the OS's own tools.
2. **Filter.** Keep developer runtimes (node, bun, deno, python, php, ruby, java, dotnet, go…) and drop editor tooling and system processes.
3. **Identify.** Walk up from the process's command line or working directory to the nearest `package.json`, then classify it by its dependencies.
4. **Probe.** Send HTTP requests to read the page title and content type, and check backends for well-known documentation and health endpoints.
5. **Act.** Start, stop, group and stream logs through a locked-down local API.

For the details (modules, API endpoints, process lifecycle), see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

### Platform support

| | Windows | macOS | Linux |
|---|---|---|---|
| Finding servers | PowerShell (`Get-NetTCPConnection`) | `lsof` + `ps` | `lsof` + `ps` + `/proc` |
| Starting | `Start-Process` (hidden window) | detached process group | detached process group |
| Stopping | `taskkill /T` | process group signal | process group signal |
| Folder picker | Explorer dialog | Finder dialog | `zenity` or `kdialog`, otherwise type the path |

On macOS and Linux, Mina only sees processes owned by your user. That covers your own dev servers, which are the ones you care about.

## 🔒 Security

A dashboard that can start and kill processes must **never** be controllable by the websites you visit. Any page open in your browser can send requests to `localhost`, so Mina locks its API down in several layers:

| Layer | Protects against |
|---|---|
| **Secret token**, regenerated on every start and embedded only in the dashboard page | Other websites calling the API, since they can't read the page to learn the token |
| **Origin check**: any foreign origin gets `403` | Cross-site requests |
| **Host check**: only `localhost:<port>` / `127.0.0.1:<port>` | DNS rebinding attacks |
| **Custom `X-Token` header + JSON-only POST** | Plain HTML form submissions; it also forces a CORS preflight that Mina never approves |
| **Limited kill**: only PIDs seen in the latest scan or spawned by Mina | Killing arbitrary system processes |
| **Known folders only** for "open in editor" | Opening arbitrary paths |
| **Binds to `127.0.0.1` only** | Access from your network |
| **`X-Frame-Options: DENY`** + `frame-ancestors 'none'` | Clickjacking |

Found a vulnerability? Please read **[SECURITY.md](SECURITY.md)**.

## 📁 Your data

Everything stays on your machine, in `~/.mina/`:

| Path | Contents |
|---|---|
| `config.json` | Your saved projects and groups |
| `logs/<id>.log`, `logs/<id>.err.log` | Output of projects Mina started |
| `logs/<id>.pid` | PIDs of servers Mina launched, so they're still recognized after a restart |

Mina has **no telemetry** and makes **no network requests** except to your own local servers. To reset everything, delete `~/.mina/`.

## ⚖️ Compared to other tools

| | Terminal tabs | pm2 & process managers | Port viewers | **Mina** |
|---|:---:|:---:|:---:|:---:|
| Finds servers started anywhere | ❌ | ❌ | ✅ | ✅ |
| Knows the project & framework | ❌ | ⚠️ | ❌ | ✅ |
| Start / stop from a UI | ❌ | ⚠️ | ⚠️ | ✅ |
| Live logs | ✅ | ✅ | ❌ | ✅ |
| Embedded preview & API docs | ❌ | ❌ | ❌ | ✅ |
| Start a whole stack in order | ❌ | ⚠️ | ❌ | ✅ |
| Built for development | ✅ | ❌ (production) | ⚠️ | ✅ |

Mina does **not** replace your terminal. It runs `npm run dev` for you, just as you would.

## ❓ FAQ

<details>
<summary><b>A server I started doesn't show up.</b></summary>

Mina shows developer runtimes by default. If yours runs on something else, or lives in a folder Mina treats as tooling, turn on **Show everything** in the sidebar. Ports below 1024 are always ignored.
</details>

<details>
<summary><b>Port 4747 is already in use.</b></summary>

Run `mina --port <another port>`, or set `MINA_PORT`.
</details>

<details>
<summary><b>Why are there no logs for a project?</b></summary>

Mina can only capture the output of processes it started itself. Servers you started from your own terminal show up and can be stopped, but their output stays in that terminal.
</details>

<details>
<summary><b>Does it work with non-Node projects?</b></summary>

Discovery and previews work for any HTTP server (Python, PHP, Ruby, Java, .NET, Go…). Start, stop and logs currently work with projects that have a `package.json`.
</details>

<details>
<summary><b>How do I uninstall it?</b></summary>

```bash
mina uninstall-startup
npm uninstall -g mina-dev
```
Then delete `~/.mina/` if you want to remove your saved projects and logs too.
</details>

## 🤝 Contributing

Contributions are welcome: bug reports, platform fixes, framework detection, ideas. Start with **[CONTRIBUTING.md](CONTRIBUTING.md)**.

```bash
git clone https://github.com/youssef-hataba/Mina.git
cd Mina
npm start        # runs the dashboard from source; there is nothing to install
npm test         # the full test suite (node:test, no dependencies)
```

CI runs the suite on **Windows, macOS and Linux** with **Node 18, 20, 22 and 24**, against real dev servers in Node, Python, PHP, Ruby, Go, Deno and Bun, and with npm, pnpm, yarn and bun.

## 👤 Author

**Youssef Hataba**

[![Portfolio](https://img.shields.io/badge/Portfolio-youssef--hataba.vercel.app-0b7285?style=for-the-badge&logo=vercel&logoColor=white)](https://youssef-hataba.vercel.app/)
[![GitHub](https://img.shields.io/badge/GitHub-youssef--hataba-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/youssef-hataba)

If Mina saves you time, consider giving the repo a ⭐. It helps other developers find it.

## 📜 License

[MIT](LICENSE) © [Youssef Hataba](https://youssef-hataba.vercel.app/)

<p align="center"><sub>Built for developers who have more servers than terminal tabs.</sub></p>
