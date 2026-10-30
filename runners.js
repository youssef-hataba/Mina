// How to run a project folder, per technology: the files that mark it, its name, and the command that runs it.
// Commands are built only from constants and from names checked against SAFE, never copied from file contents
// or from ~/.mina/config.json, so editing a project's files or the config can't make Mina run anything else.
const fs = require('fs');
const path = require('path');
const { WIN } = require('./platform');

const SAFE = /^[\w.-]+$/;
const SCRIPT_ORDER = ['dev', 'start:dev', 'develop', 'serve', 'start'];

const has = (dir, f) => fs.existsSync(path.join(dir, f));
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
const json = (dir, f) => { try { return JSON.parse(read(dir, f)); } catch { return null; } };
const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

function packageManager(dir) {
  if (has(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(dir, 'yarn.lock')) return 'yarn';
  if (has(dir, 'bun.lockb') || has(dir, 'bun.lock')) return 'bun';
  return 'npm';
}

// A virtualenv in the project wins over the system Python: that's where Django and its packages live. The path is
// relative because the command runs inside the project folder, so the folder's own name never enters the command.
function python(dir) {
  for (const venv of ['.venv', 'venv', 'env']) {
    const rel = WIN ? `${venv}\\Scripts\\python.exe` : `${venv}/bin/python`;
    if (has(dir, rel)) return rel;
  }
  return WIN ? 'python' : 'python3';
}

// The .csproj to run: the only one, or else the first whose name is safe to put in a command.
function csproj(dir) {
  const found = list(dir).filter((f) => /\.csproj$/i.test(f));
  if (found.length === 1) return { name: found[0].replace(/\.csproj$/i, ''), arg: '' };
  const safe = found.find((f) => SAFE.test(f));
  return safe ? { name: safe.replace(/\.csproj$/i, ''), arg: ` --project ${safe}` } : null;
}

// The Go package to run: the module root if it is a main package, otherwise the server among cmd/* (the
// standard layout keeps cmd/server next to helpers like cmd/seed or cmd/migrate). Never a guess between helpers.
const GO_SERVERS = ['server', 'api', 'app', 'web', 'main', 'http', 'backend'];
const isMain = (dir) => list(dir).some((f) => f.endsWith('.go') && !f.endsWith('_test.go') && /^package main\b/m.test(read(dir, f)));
function goEntry(dir) {
  if (isMain(dir)) return '.';
  const cmd = path.join(dir, 'cmd');
  const mains = list(cmd).filter((d) => SAFE.test(d) && isMain(path.join(cmd, d)));
  const mod = (read(dir, 'go.mod').match(/^module\s+(\S+)/m)?.[1] || '').split('/').pop();
  const pick = GO_SERVERS.find((n) => mains.includes(n)) || (mains.includes(mod) ? mod : null) || (mains.length === 1 ? mains[0] : null);
  return pick ? `./cmd/${pick}` : null;
}

// In priority order. Laravel and Rails apps usually carry a package.json too (for Vite or esbuild), but its
// dev script only builds assets; the app itself is the PHP/Ruby server. A generic marker (go.mod, Cargo.toml,
// .csproj) next to a runnable package.json is more often tooling, so Node wins over those.
const RUNNERS = [
  {
    id: 'laravel', framework: 'Laravel', tool: 'php',
    match: (dir) => has(dir, 'artisan') && has(dir, 'composer.json'),
    name: (dir) => json(dir, 'composer.json')?.name?.split('/').pop(),
    command: () => 'php artisan serve',
    install: (dir) => (has(dir, 'vendor') ? null : { command: 'composer install', what: 'vendor' }),
  },
  {
    id: 'rails', framework: 'Rails', tool: 'ruby',
    match: (dir) => has(dir, 'Gemfile') && has(dir, path.join('bin', 'rails')),
    // Through ruby, because bin/rails isn't executable on Windows.
    command: () => 'ruby bin/rails server',
    install: () => null, // gems install per machine, not per folder; a missing gem shows up clearly in the log
  },
  {
    id: 'django', framework: 'Django', tool: 'python',
    match: (dir) => has(dir, 'manage.py') && /django/i.test(read(dir, 'manage.py')),
    command: (dir) => `${python(dir)} manage.py runserver`,
    install: () => null, // packages belong in the project's virtualenv, which only the user should create
  },
  {
    id: 'node',
    match: (dir) => !!SCRIPT_ORDER.find((s) => json(dir, 'package.json')?.scripts?.[s]),
    name: (dir) => json(dir, 'package.json')?.name,
    command: (dir) => `${packageManager(dir)} run ${SCRIPT_ORDER.find((s) => json(dir, 'package.json').scripts[s])}`,
    // Only when there is something to install: npm creates no node_modules for a project without dependencies,
    // so checking the folder alone would ask "install?" on every start, forever.
    install: (dir) => {
      const pkg = json(dir, 'package.json') || {};
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      return deps.length && !has(dir, 'node_modules') ? { command: `${packageManager(dir)} install`, what: 'node_modules' } : null;
    },
  },
  {
    id: 'go', framework: 'Go', tool: 'go',
    match: (dir) => has(dir, 'go.mod') && !!goEntry(dir),
    name: (dir) => (read(dir, 'go.mod').match(/^module\s+(\S+)/m)?.[1] || '').split('/').pop(),
    command: (dir) => `go run ${goEntry(dir)}`,
    install: () => null, // go run downloads missing modules itself
  },
  {
    id: 'rust', framework: 'Rust', tool: 'cargo',
    // A workspace root has no [package] of its own; its members are found as subfolders.
    match: (dir) => /^\[package\]/m.test(read(dir, 'Cargo.toml')),
    name: (dir) => read(dir, 'Cargo.toml').match(/^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms)?.[1],
    command: () => 'cargo run',
    install: () => null, // cargo fetches dependencies on build
  },
  {
    id: 'dotnet', framework: '.NET', tool: 'dotnet',
    match: (dir) => !!csproj(dir),
    name: (dir) => csproj(dir)?.name,
    command: (dir) => `dotnet run${csproj(dir).arg}`,
    install: () => null, // dotnet run restores packages itself
  },
];

const BY_ID = Object.fromEntries(RUNNERS.map((r) => [r.id, r]));

// How to run this folder, or null. Plain data, safe to send to the page.
function detect(dir) {
  const runner = RUNNERS.find((r) => { try { return r.match(dir); } catch { return false; } });
  if (!runner) return null;
  const pkg = runner.id === 'node' ? json(dir, 'package.json') : null;
  const install = runner.install(dir);
  return {
    dir: path.resolve(dir),
    name: runner.name?.(dir) || path.basename(path.resolve(dir)),
    runner: runner.id,
    // Node projects are classified by their dependencies (Next.js, NestJS...); the others by their technology.
    framework: runner.framework || null,
    kind: runner.framework ? 'backend' : null,
    command: runner.command(dir),
    install: install && install.command,
    installWhat: install && install.what,
    ...(pkg && { script: SCRIPT_ORDER.find((s) => pkg.scripts[s]), pm: packageManager(dir) }),
    deps: pkg ? Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }) : [],
  };
}

// Which project a running server belongs to, seen from one folder while walking up from its command line.
// Looser than detect(): a package.json without dev scripts still names a Node project. A JS process (the Vite
// server of a Laravel app, say) belongs to the folder's package.json rather than to the PHP app around it.
function identify(dir, { js = false } = {}) {
  const node = () => {
    if (!has(dir, 'package.json')) return null;
    const pkg = json(dir, 'package.json') || {};
    return { name: pkg.name || path.basename(dir), deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }), framework: null };
  };
  const other = (r) => ({ name: r.name?.(dir) || path.basename(dir), deps: [], framework: r.framework });
  if (js) { const n = node(); if (n) return n; }
  for (const r of RUNNERS) {
    if (r.id === 'node') { const n = node(); if (n) return n; continue; }
    try { if (r.match(dir)) return other(r); } catch {}
  }
  return null;
}

// Commands are assembled from constants, but check the result anyway: letters, digits, spaces and path
// characters only, so no shell operator can ever reach cmd.exe or sh.
const SAFE_COMMAND = /^[\w .:\\/-]+$/;
const safeCommand = (c) => typeof c === 'string' && SAFE_COMMAND.test(c);

module.exports = { detect, identify, safeCommand, RUNNERS, BY_ID, SAFE };
