# Contributing to Mina

Thanks for wanting to help! Mina is small on purpose, and a few guidelines keep it that way.

## Getting started

```bash
git clone https://github.com/youssef-hataba/Mina.git
cd Mina
npm start              # same as: node bin/cli.js
node bin/cli.js --port 4800 --no-open   # a second copy for testing next to your installed one
```

There is nothing to install. Mina has no dependencies.

Frontend files (`index.html`, `public/`) are served with `no-cache`, so a browser refresh picks up your changes. Changes to server-side files (`server.js`, `projects.js`, `platform.js`, `ides.js`) need a restart.

To get a feel for the code, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.

## Ground rules

1. **No runtime dependencies.** If something needs a package, open an issue first to discuss it.
2. **Keep OS-specific code in `platform.js`** (or `ides.js` for editors). The rest of the code shouldn't branch on the OS.
3. **Don't weaken the security checks.** Any new API route must:
   - sit under `/api/` (so it gets the token, Origin and Host checks),
   - use `POST` with a JSON body if it changes anything,
   - accept only PIDs, folders or project IDs that Mina already knows about, never arbitrary input.
4. **Never build shell commands from user input by string concatenation.** Pass values as arguments or environment variables, the way `platform.launch` does.
5. **Don't poll in the background.** Polling only runs while the user is looking at the thing being polled.

## Code style

- Plain CommonJS and modern Node 18 syntax. No build step, no TypeScript, no bundler.
- Two-space indentation, single quotes, semicolons.
- Short comments that explain **why**, not what, like the ones already in the code.
- Keep functions small and named after what they return or do.

## Testing your change

```bash
npm test                    # everything (takes a few minutes: real servers are started and stopped)
npm run test:unit           # fast: detection, config, groups, logs, platform calls
npm run test:integration    # a real Mina per file: security, discovery, lifecycle, CLI
node --test test/integration/cli.test.js             # a single file
```

The suite uses only `node:test`, with no dependencies. Every test file runs its own Mina on a free port with its own
fake home folder, so your real `~/.mina` and a Mina you already have running are never touched. Fixture
projects are created in `test/.tmp/` and removed afterwards.

| File | What it covers |
|---|---|
| `unit/projects.test.js` | Script and package manager detection, scanning, config, groups, log reading, start-input validation |
| `unit/platform.test.js` | Listing listeners (IPv4/IPv6), launching in odd folders, start times, killing whole process trees |
| `unit/runners.test.js` | Recognising Django, Laravel, Rails, Go, Rust and .NET folders; virtualenvs; priorities; command safety |
| `integration/runtimes.test.js` | Really starting and stopping Django, Laravel, Rails, Go, Rust and .NET projects through Mina |
| `unit/regressions.test.js` | Recycled PIDs, prototype-named groups, same-named folders, corrupt configs, UTF-8 splits, UNC paths |
| `integration/security.test.js` | Host/DNS rebinding, token, Origin, CORS, content type, malformed bodies, path traversal, PID/folder allow-lists |
| `integration/discovery.test.js` | All 17 frameworks, IPv6, silent servers, editor tooling, Python/PHP/Ruby/Deno/Bun/Go servers |
| `integration/lifecycle.test.js` | Add → start → logs → stop, crashes, install prompt, port conflicts, groups in order, restarts, odd folder names, pnpm/yarn/bun |
| `integration/regressions.test.js` | Streaming servers during a scan, split UTF-8 bodies, paths with spaces, monorepos, double clicks, cancellation |
| `integration/cli.test.js` | Flags, port validation, single instance, startup entries |

To narrow a run, pick a file rather than `--test-name-pattern`. When a pattern filters out every test in an
integration file, Node skips that file's `after` hooks, so its Mina and fixture servers keep running and the
run never ends.

Tests for other runtimes and package managers are **skipped** when the tool isn't installed. CI
(`.github/workflows/test.yml`) installs all of them and runs the suite on Windows, macOS and Linux with Node 18, 20, 22 and 24.

Every bug fix should come with a test that fails without the fix. If your change touches the UI, also check it
by hand in the browser.

## Adding framework detection

Framework detection lives in `server.js`:

```js
const FRONTEND_DEPS = [...];
const BACKEND_DEPS  = [...];
const FRAMEWORK_NAMES = { ... };
```

Add the package name to the right list and give it a display name. Order matters: more specific frameworks go before generic ones (e.g. `next` before `react`).

## Adding a technology

Add an entry to `RUNNERS` in `runners.js` (`match`, `name`, `command`, `install`), in the right place in the
priority order. The command must be a constant, or built only from names that pass `SAFE`. Then add a detection
test to `test/unit/runners.test.js` and a real start/stop case to `test/integration/runtimes.test.js`, and
install the toolchain in `.github/workflows/test.yml`.

## Adding an editor

Add an entry to `KNOWN` in `ides.js` with the Windows `.exe` paths, the macOS app bundle names and the Linux launcher commands.

## Commits & pull requests

- One focused change per PR.
- Write commit messages in the imperative: *"Detect Remix projects"*, not *"Detected…"*.
- Describe what you changed, why, and how you tested it.
- Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).

## Reporting bugs

Please include `mina --version`, your OS, your Node.js version, and what you expected compared with what happened. For a server that isn't detected, also include its command line (from Task Manager → Details, or `ps -o command= -p <pid>`).
