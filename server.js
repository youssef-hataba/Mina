// Mina: a local dashboard for every dev server on this machine, grouped by project.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const projects = require('./projects');
const runners = require('./runners');
const ides = require('./ides');
const platform = require('./platform');

const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.MINA_PORT) || 4747;
// Sent with every probe, so a "GET /health" in a server's log can be traced back to the dashboard that asked.
const USER_AGENT = `Mina/${require('./package.json').version} (localhost:${PORT})`;
// New secret every start; only the dashboard page itself ever sees it.
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
const PUBLIC = path.join(__dirname, 'public');
const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
// PIDs seen in the latest scan; only these (plus ones we spawned) may be stopped.
let knownPids = new Set();
let lastApps = [];
const SYSTEM = new Set(['system', 'svchost', 'lsass', 'wininit', 'services', 'spoolsv', 'idle']);
// Runtimes that usually mean "a dev server I started"; everything else is hidden unless ?all=1.
const DEV = new Set(['node', 'bun', 'deno', 'python', 'pythonw', 'php', 'ruby', 'java', 'dotnet', 'go', 'httpd', 'nginx', 'caddy', 'uvicorn']);
const JS_RUNTIMES = new Set(['node', 'bun', 'deno']);
// Editors and apps run their own Node servers; those are tooling, not the user's dev servers.
const TOOLING_DIR = platform.WIN
  ? /\\(\.vscode|\.antigravity[^\\]*|\.cursor|AppData|Program Files[^\\]*)\\/i
  : /\/(\.vscode[^/]*|\.antigravity[^/]*|\.cursor[^/]*|Library\/Application Support|[^/]+\.app)\//;
// Paths in a command line, a dependency path inside node_modules, and folders where no project lives.
const ABS_PATH = platform.WIN ? /[A-Za-z]:\\[^"\s]+/g : /\/[^"'\s]+/g;
const QUOTED_PATH = /"([A-Za-z]:\\[^"]+)"/g;
// ps shows POSIX command lines without quotes, so "/home/John Smith/api/server.js" arrives split at the space.
// From each word that starts a path, take the longest run of words that names something on disk.
function spacedPaths(args) {
  const words = args.split(' ');
  const found = [];
  for (let i = 0; i < Math.min(words.length, 64); i++) {
    if (!words[i].startsWith('/')) continue;
    for (let j = Math.min(words.length, i + 16); j > i + 1; j--) {
      const candidate = words.slice(i, j).join(' ');
      if (fs.existsSync(candidate)) { found.push(candidate); break; }
    }
  }
  return found;
}
const within = (child, parent) => {
  const rel = path.relative(projects.norm(parent), projects.norm(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const NM_PATH = platform.WIN ? /([A-Za-z]:\\[^"]*?)\\node_modules\\/i : /(\/[^"'\s]*?)\/node_modules\//;
const SYSTEM_DIR = platform.WIN ? /\\(Program Files|Windows|AppData)/i : /^\/(usr|bin|sbin|opt|System|Library|Applications|nix)(\/|$)/;

// "python3.12" and "python.exe" both count as python.
const exeName = (n) => String(n || '').replace(/\.exe$/i, '').replace(/[\d.]+$/, '').toLowerCase();
// Drop the executable itself (e.g. "C:\Program Files\nodejs\node.exe") so only the script path is judged.
const argsOf = (cmd) => String(cmd || '').replace(/^\s*("[^"]*"|\S+)\s*/, '');
const isDevServer = (l) => DEV.has(exeName(l.name)) && !TOOLING_DIR.test(argsOf(l.cmd));

const FRONTEND_DEPS = ['next', 'vite', 'react-scripts', 'nuxt', '@angular/core', 'astro', '@sveltejs/kit', 'gatsby', 'vue', 'react'];
const BACKEND_DEPS = ['@nestjs/core', 'express', 'fastify', 'koa', '@hapi/hapi', 'hono', '@adonisjs/core'];
const FRAMEWORK_NAMES = { next: 'Next.js', vite: 'Vite', 'react-scripts': 'CRA', nuxt: 'Nuxt', '@angular/core': 'Angular', astro: 'Astro',
  '@sveltejs/kit': 'SvelteKit', gatsby: 'Gatsby', vue: 'Vue', react: 'React', '@nestjs/core': 'NestJS', express: 'Express',
  fastify: 'Fastify', koa: 'Koa', '@hapi/hapi': 'Hapi', hono: 'Hono', '@adonisjs/core': 'AdonisJS' };
const DOC_PATHS = ['/api', '/docs', '/swagger', '/api-docs', '/api/docs', '/health', '/graphql'];

const listListeners = platform.listListeners;

// Dev servers bind to IPv4 or IPv6 only, so a probe tries the loopback addresses that reach this process, in order.
async function probe(port, urlPath = '/', timeout = 8000, hosts = ['127.0.0.1', '::1']) {
  let answer = { ok: false };
  for (const host of hosts) {
    answer = await probeHost(host, port, urlPath, timeout);
    if (answer.ok) break;
  }
  return answer;
}

// Which loopback addresses reach this listener. Two processes can share a port (an editor's preview server on
// 127.0.0.1:3001, the user's Next.js on [::]:3001): then 127.0.0.1 belongs to the other one, and asking there
// would report that process's page as this server's. A wildcard [::] also takes IPv4, unless another process
// holds IPv4 on the port.
function hostsFor(l, listeners) {
  const addrs = l.addrs || [];
  if (!addrs.length) return ['127.0.0.1', '::1'];
  const v6 = (a) => a.includes(':');
  const others = listeners.filter((x) => x.port === l.port && x.pid !== l.pid).flatMap((x) => x.addrs || []);
  const ownV4 = addrs.some((a) => !v6(a));
  const ownV6 = addrs.some(v6) || addrs.includes('*');
  const dualStackV4 = addrs.includes('::') && !others.some((a) => !v6(a));
  const hosts = [];
  if (ownV4) hosts.push('127.0.0.1');
  if (ownV6) hosts.push('::1');
  if (!ownV4 && dualStackV4) hosts.push('127.0.0.1');
  return hosts.length ? hosts : ['127.0.0.1', '::1'];
}

// Next.js compiles the page on first hit, so the timeout is generous. It is a hard deadline for the whole
// exchange: a server that sends headers and then streams (SSE, long-poll) or stalls must not hold up a scan.
function probeHost(host, port, urlPath, timeout) {
  return new Promise((resolve) => {
    let done = false;
    let answer = { ok: false };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(answer);
    };
    const timer = setTimeout(finish, timeout);
    const req = http.get({ host, port, path: urlPath, headers: { 'User-Agent': USER_AGENT } }, (res) => {
      let body = '';
      const settle = () => {
        const m = body.match(/<title[^>]*>([^<]*)<\/title>/i);
        answer = { ok: true, status: res.statusCode, type: res.headers['content-type'] || '', title: m ? m[1].trim() : '', body: body.slice(0, 1500) };
      };
      settle();
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
        settle();
        if (body.length >= 20000) finish();
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
    req.on('error', finish);
  });
}

// Guess the project folder (and its dependencies) from the process command line, then its working
// directory (macOS/Linux only; it catches servers whose title hides the path, like "next-server").
function findProject(cmd, cwd, exe) {
  const js = JS_RUNTIMES.has(exeName(exe));
  const args = argsOf(cmd);
  const nm = args.match(NM_PATH);
  // Quoted paths first, so a space in the path ("C:\Users\John Smith\api\server.js") doesn't cut it short.
  const quoted = platform.WIN ? [...args.matchAll(QUOTED_PATH)].map((m) => m[1]) : spacedPaths(args);
  const candidates = nm ? [nm[1]] : [...quoted, ...(args.match(ABS_PATH) || [])];
  // A hoisted monorepo runs "node /repo/node_modules/next/... dev" from /repo/apps/web: the working
  // directory inside that root is the real project, not the root that owns node_modules.
  if (cwd && nm && within(cwd, nm[1])) candidates.unshift(cwd);
  else if (cwd) candidates.push(cwd);
  for (let dir of candidates) {
    try { if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir); } catch { continue; }
    for (let d = dir; d && d !== path.dirname(d); d = path.dirname(d)) {
      // package.json, manage.py, artisan, bin/rails, go.mod, Cargo.toml, *.csproj (runners.js).
      const found = runners.identify(d, { js });
      if (found) return { ...found, dir: d };
      if (SYSTEM_DIR.test(d)) break;
    }
  }
  return null;
}

function classifyDeps(deps) {
  const fe = FRONTEND_DEPS.find((d) => deps.includes(d));
  const be = BACKEND_DEPS.find((d) => deps.includes(d));
  // Check backend first: an API project may list react for emails/admin bits, but NestJS/Express decides it.
  if (be) return { kind: 'backend', framework: FRAMEWORK_NAMES[be] };
  if (fe) return { kind: 'frontend', framework: FRAMEWORK_NAMES[fe] };
  return null;
}

// Node projects by their dependencies; Django, Laravel, Rails, Go, Rust and .NET by their technology, with
// frontend/backend read from what the server answers (a Rails or Laravel app often serves HTML pages).
function classify(app, project) {
  const html = /text\/html/i.test(app.http.type || '');
  if (project?.framework) return { kind: html ? 'frontend' : 'backend', framework: project.framework };
  const known = classifyDeps(project?.deps || []);
  if (known) return known;
  return { kind: html ? 'frontend' : 'backend', framework: exeName(app.name) };
}

// Overlapping scans (each one a PowerShell or lsof run plus HTTP probes) only slowed each other down, so they are
// shared, but never with a stale result: a scan that was already running when a request arrived began before
// whatever that request wants to see (the server that just came up). Such requests wait for it, then share
// one fresh follow-up scan.
const scans = new Map(); // 'all' | 'dev' -> { running, next }
function getApps(all) {
  const key = all ? 'all' : 'dev';
  const s = scans.get(key) || scans.set(key, { running: null, next: null }).get(key);
  if (!s.running) {
    s.running = scanApps(all).finally(() => { s.running = null; });
    return s.running;
  }
  s.next ||= s.running.catch(() => {}).then(() => { s.next = null; return getApps(all); });
  return s.next;
}

// Probes land in the user's server logs ("GET /docs 404"), so they are kept to a minimum: a page that answered
// is trusted for 30 s, and the documentation paths are looked up once per server process. Keyed by
// "pid port", so a restarted server (new PID) is probed afresh.
const PAGE_TTL = 30000;
const pageCache = new Map();
const endpointCache = new Map();

// The first probe of a server is patient (Next.js compiles the page on its first request). One that already
// stayed silent gets 2 s on later refreshes: a hung server would otherwise hold every refresh for the full wait.
const SILENT_RETRY = 2000;
const silent = new Set();

async function probeCached(l, timeout) {
  const key = `${l.pid} ${l.port}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.http;
  const http = await probe(l.port, '/', silent.has(key) ? Math.min(timeout, SILENT_RETRY) : timeout, l.hosts);
  // Only answers are remembered: a server that is still compiling must be asked again next time.
  if (http.ok) { pageCache.set(key, { http, at: Date.now() }); silent.delete(key); } else silent.add(key);
  return http;
}

function endpointsOf(a) {
  const key = `${a.pid} ${a.port}`;
  if (!endpointCache.has(key)) {
    endpointCache.set(key, Promise.all(DOC_PATHS.map(async (p) => ({ path: p, res: await probe(a.port, p, 3000, a.hosts) })))
      .then((hits) => hits.filter((h) => h.res.ok && h.res.status < 400).map((h) => ({ path: h.path, status: h.res.status, type: h.res.type }))));
  }
  return endpointCache.get(key);
}

// Forget servers that are gone, so the caches don't grow and a reused PID+port is probed again.
function pruneCaches(listeners) {
  const live = new Set(listeners.map((l) => `${l.pid} ${l.port}`));
  for (const cache of [pageCache, endpointCache, silent]) for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
}

async function scanApps(all) {
  // Anything Mina launched itself always counts, whatever the binary is called (a compiled Go, Rust or
  // .NET server runs under its own name, not "go" or "dotnet").
  // The listener itself counts too: "cargo run" (and sh before it) exec into the server, which then keeps the
  // launcher's own PID instead of running below it.
  const ours = (l) => !!projects.ownerOf(lineage(l));
  const listeners = await listListeners();
  pruneCaches(listeners);
  const list = listeners.filter(
    (l) => l.port !== PORT && l.port >= 1024 && !SYSTEM.has(exeName(l.name)) && (all || isDevServer(l) || ours(l))
  ).map((l) => ({ ...l, hosts: hostsFor(l, listeners) }));
  // A process that also listens on all interfaces keeps its loopback-only ports for itself (Next.js's internal
  // port on 127.0.0.1): those never answer a page, and waiting out the probe on them held every refresh 8 s.
  const wildcard = new Set(listeners.filter((l) => (l.addrs || []).some((a) => a === '::' || a === '0.0.0.0' || a === '*')).map((l) => l.pid));
  const internal = (l) => wildcard.has(l.pid) && (l.addrs || []).length > 0 && l.addrs.every((a) => a === '127.0.0.1' || a === '::1');
  const probed = await Promise.all(list.map(async (l) => ({
    ...l, http: internal(l) ? { ok: false } : await probeCached(l, all ? 1500 : 8000),
  })));
  // Dev servers stay even if they did not answer (still compiling); other noise must answer HTTP.
  // Another copy of Mina (on another port, installed from npm or run from a clone) is not a dev server of the user's;
  // it's recognised by its page title, which works wherever it was installed.
  // A server that answers on one port and also holds a silent one (Next.js keeps an internal port on 127.0.0.1)
  // is listed once, under the port that answers.
  const answering = new Set(probed.filter((a) => a.http.ok).map((a) => a.pid));
  const shown = probed.filter((a) => (a.http.ok || ((isDevServer(a) || ours(a)) && !answering.has(a.pid)))
    && !/^Mina\b/.test(a.http.title || ''));
  // The page lists one app per port. When two shown processes share a port (IPv4 and IPv6), keep the one that
  // matters most: launched by Mina, then linked to a project, then a dev runtime.
  const rank = (a) => (ours(a) ? 3 : 0) + (projectOf(a) ? 2 : 0) + (isDevServer(a) ? 1 : 0);
  const byPort = new Map();
  for (const a of shown) if (!byPort.has(a.port) || rank(a) > rank(byPort.get(a.port))) byPort.set(a.port, a);
  const apps = [...byPort.values()];
  knownPids = new Set(apps.map((a) => a.pid));
  return Promise.all(apps.map(async (a) => {
    const project = projectOf(a);
    const { kind, framework } = classify(a, project);
    const endpoints = kind === 'backend' ? await endpointsOf(a) : [];
    return {
      port: a.port,
      pid: a.pid,
      process: a.name,
      kind,
      framework,
      responding: a.http.ok,
      title: a.http.title || '',
      status: a.http.status,
      contentType: a.http.type || '',
      preview: kind === 'backend' ? a.http.body || '' : '',
      endpoints,
      project: project && { name: project.name, dir: project.dir },
      url: `http://localhost:${a.port}`,
    };
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// For "start group" ordering. Django, Laravel, Rails, Go, Rust and .NET apps count as backends: they start first.
const kindOf = (p) => {
  const info = projects.detect(p.dir);
  return info?.kind || classifyDeps(info?.deps || [])?.kind || 'frontend';
};

// A launched-by-us ancestor is the surest sign (it also covers relative "node server.js" commands and hoisted
// monorepo binaries); otherwise guess from the command line and working directory.
const lineage = (l) => [l.pid, ...(l.chain || [])];
const projectOf = (l) => projects.ownerOf(lineage(l)) || findProject(l.cmd, l.cwd, l.name);

// The user's dev servers from the listener list alone, without HTTP probing (which waits on slow servers), for
// start/stop decisions: same filter as the dashboard, so editor tooling that happens to point into a project
// folder is never matched and never stopped. [{ port, pid, project }]
function devListeners(listeners) {
  const ours = (l) => !!projects.ownerOf(lineage(l));
  return listeners
    .filter((l) => l.port !== PORT && l.port >= 1024 && !SYSTEM.has(exeName(l.name)) && (isDevServer(l) || ours(l)))
    .map((l) => ({ port: l.port, pid: l.pid, project: projectOf(l) }));
}

// Cheap "which project folders are listening" check (no HTTP probing) for start/wait decisions.
async function listeningDirs(listeners) {
  listeners ||= await listListeners();
  return new Set(listeners.map((l) => projectOf(l)?.dir).filter(Boolean).map(projects.norm));
}

// The project's last known port is now held by some other process.
// Several processes can hold one port (IPv4 and IPv6); it's a conflict only if none of them is this project.
function portConflict(p, listeners) {
  const on = p.lastPort ? listeners.filter((x) => x.port === p.lastPort) : [];
  if (!on.length) return null;
  const owners = on.map((l) => ({ l, owner: projectOf(l) }));
  if (owners.some(({ owner }) => owner && projects.norm(owner.dir) === projects.norm(p.dir))) return null;
  const { l, owner } = owners[0];
  return { project: p.name, port: p.lastPort, by: owner?.name || l.name || `PID ${l.pid}` };
}

// Backends first; the frontends start once every backend is listening (or has died / timed out).
async function runGroup(list, install) {
  const waves = [list.filter((p) => kindOf(p) === 'backend'), list.filter((p) => kindOf(p) !== 'backend')].filter((w) => w.length);
  list.forEach((p) => projects.queued.add(p.id));
  for (const wave of waves) {
    // A "stop group" while waiting clears the queue, which cancels what hasn't started yet.
    const go = wave.filter((p) => projects.queued.has(p.id));
    // Leave the queue only once the launch is recorded: in between the project would read as "stopped",
    // and the page stops polling as soon as nothing is queued or starting.
    await Promise.all(go.map(async (p) => {
      try { await projects.start(p, { install: install && projects.needsInstall(p) }); } catch {}
      projects.queued.delete(p.id);
    }));
    notify(); // queued -> starting
    const end = Date.now() + 90000;
    while (Date.now() < end) {
      await sleep(2000);
      const dirs = await listeningDirs();
      if (!go.some((p) => !dirs.has(projects.norm(p.dir)) && projects.ownPid(p.id))) break;
    }
    notify(); // this wave is up (or gave up): the next one starts
  }
}

// ---- Live updates: every open dashboard tab hears about changes as they happen ----

// Each tab holds GET /api/events open; a line is written whenever something any tab did changed the state
// (start, stop, add, remove, groups), so the other tabs refresh at once instead of on their next manual reload.
const subscribers = new Set();
let changeVersion = 0;
let notifyTimer = null;
// Several changes in a burst (a group stop touches every member) become one message.
function notify() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    changeVersion++;
    const line = JSON.stringify({ type: 'change', version: changeVersion }) + '\n';
    for (const res of subscribers) res.write(line);
  }, 100);
}

function subscribe(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  res.write(JSON.stringify({ type: 'hello', version: changeVersion }) + '\n');
  subscribers.add(res);
  // A ping now and then keeps idle connections open and lets a dead one be noticed and dropped.
  const ping = setInterval(() => res.write(JSON.stringify({ type: 'ping' }) + '\n'), 25000);
  res.on('close', () => { clearInterval(ping); subscribers.delete(res); });
}

// POST routes that change what the dashboard shows; a successful one tells every tab.
const MUTATIONS = new Set(['/api/kill', '/api/projects/add', '/api/projects/remove', '/api/projects/set-group', '/api/projects/start',
  '/api/projects/stop', '/api/groups/start', '/api/groups/stop', '/api/groups/rename', '/api/groups/remove']);

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const MAX_BODY = 1024 * 1024;
const TOO_BIG = Symbol('too big');

// Buffers are joined before decoding, so a multi-byte character (Arabic in a path) split across chunks survives.
// Anything that isn't a JSON object reads as {}; an oversized body is refused instead of silently cut.
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size <= MAX_BODY) chunks.push(d); });
    req.on('end', () => {
      if (size > MAX_BODY) return resolve(TOO_BIG);
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// Byte lengths, not string lengths: a non-ASCII header has more bytes than characters, and timingSafeEqual throws on a mismatch.
const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// One bad request must never take the dashboard down: an exception here answers 500 instead of crashing.
const server = http.createServer((req, res) => handle(req, res).catch((e) => {
  console.error(e);
  if (!res.headersSent) send(res, 500, { error: String(e?.message || e) });
  else res.end();
}));

async function handle(req, res) {
  // Host check blocks DNS rebinding (evil.com resolving to 127.0.0.1).
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, { error: 'bad host' });

  if (req.url.startsWith('/api/')) {
    // Other sites are refused outright; the custom token header also forces a CORS preflight we never approve.
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'bad origin' });
    if (!safeEqual(String(req.headers['x-token'] || ''), TOKEN)) return send(res, 403, { error: 'bad token' });
    // Which running launchers are really ours (PID + start time), before anything relies on it.
    await projects.refreshOwnership();

    if (req.method === 'GET' && req.url.startsWith('/api/apps')) {
      lastApps = await getApps(req.url.includes('all=1'));
      return send(res, 200, { apps: lastApps, projects: projects.withStatus(lastApps, classifyDeps) });
    }
    if (req.method === 'GET' && req.url === '/api/ides') {
      return send(res, 200, ides.detect().map(({ id, name }) => ({ id, name })));
    }
    if (req.method === 'GET' && req.url === '/api/events') return subscribe(res);
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    if (MUTATIONS.has(req.url)) res.on('finish', () => { if (res.statusCode === 200) notify(); });
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json only' });
    const body = await readJson(req);
    if (body === TOO_BIG) return send(res, 413, { error: 'body too large' });

    if (req.url === '/api/kill') {
      const pid = Number(body.pid);
      if (!knownPids.has(pid) && !projects.spawnedPids().includes(pid)) return send(res, 403, { error: 'unknown pid' });
      try { process.kill(pid); knownPids.delete(pid); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 500, { error: String(e) }); }
    }
    if (req.url === '/api/pick-folder') return send(res, 200, { dir: await projects.pickFolder() });
    if (req.url === '/api/open') {
      // Only folders Mina already knows about (saved projects or running apps), never an arbitrary path.
      const dir = String(body.dir || '');
      const known = [
        ...projects.withStatus([], classifyDeps).map((p) => p.dir),
        ...Object.values(projects.groupRoots()).filter(Boolean),
        ...lastApps.map((a) => a.project?.dir).filter(Boolean),
      ];
      if (!known.some((d) => projects.norm(d) === projects.norm(dir))) return send(res, 403, { error: 'unknown folder' });
      return ides.open(String(body.ide || ''), dir) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'unknown ide' });
    }
    if (req.url === '/api/projects/scan') {
      const found = projects.scan(String(body.dir || '').trim(), (deps) => !!classifyDeps(deps));
      const label = (f) => (f.framework && { kind: f.kind, framework: f.framework }) || classifyDeps(f.deps) || { kind: 'frontend', framework: f.pm };
      return send(res, 200, { candidates: found.map((f) => ({ ...f, ...label(f), deps: undefined })) });
    }
    if (req.url === '/api/projects/add') {
      projects.addProjects((Array.isArray(body.dirs) ? body.dirs : []).map(String));
      return send(res, 200, { ok: true });
    }

    if (req.url.startsWith('/api/groups/')) {
      const members = projects.groupMembers(String(body.group || ''));
      if (!members.length) return send(res, 404, { error: 'unknown group' });
      const stopAll = async () => {
        members.forEach((p) => projects.queued.delete(p.id));
        const live = devListeners(await listListeners());
        await Promise.all(members.map((p) => projects.stop(p, live)));
      };
      if (req.url === '/api/groups/stop') { await stopAll(); return send(res, 200, { ok: true }); }
      // Renaming writes the name onto every member, which also turns a folder-based group into an explicit one.
      if (req.url === '/api/groups/rename') {
        const name = String(body.name || '').trim();
        if (!name) return send(res, 400, { error: 'empty name' });
        members.forEach((p) => projects.setGroup(p.id, name));
        return send(res, 200, { ok: true });
      }
      // Off the list only: servers are stopped first so they don't linger as unsaved apps, folders stay on disk.
      if (req.url === '/api/groups/remove') {
        await stopAll();
        members.forEach((p) => projects.removeProject(p.id));
        return send(res, 200, { ok: true });
      }
      if (req.url !== '/api/groups/start') return send(res, 404, { error: 'not found' });
      const listeners = await listListeners();
      const dirs = await listeningDirs(listeners);
      // Skip what is already up or already booting.
      const todo = members.filter((p) => !dirs.has(projects.norm(p.dir)) && !projects.ownPid(p.id) && !projects.isStarting(p.id) && !projects.queued.has(p.id));
      if (!todo.length) return send(res, 200, { ok: true, starting: 0 });
      const missing = todo.filter(projects.needsInstall).map((p) => p.name);
      if (missing.length && !body.install) return send(res, 200, { needsInstall: missing });
      const conflicts = todo.map((p) => portConflict(p, listeners)).filter(Boolean);
      if (conflicts.length && !body.force) return send(res, 200, { conflicts });
      runGroup(todo, !!body.install);
      return send(res, 200, { ok: true, starting: todo.length });
    }

    // The rest act on a saved project, so the id must exist in the config.
    const p = projects.getProject(String(body.id || ''));
    if (!p) return send(res, 404, { error: 'unknown project' });
    if (req.url === '/api/projects/remove') { projects.removeProject(p.id); return send(res, 200, { ok: true }); }
    if (req.url === '/api/projects/set-group') { projects.setGroup(p.id, body.group); return send(res, 200, { ok: true }); }
    if (req.url === '/api/projects/start') {
      // Already booting (a second tab, a double click, or a group run in progress): never launch a duplicate.
      // Claimed before the first await, so two requests arriving together can't both get past this point,
      // and a stop that arrives during the checks below cancels the launch instead of being lost.
      if (projects.queued.has(p.id)) return send(res, 200, { alreadyStarting: true });
      const flight = projects.claim(p.id);
      if (!flight) return send(res, 200, { alreadyStarting: true });
      try {
        // Fresh listener list, so a copy started from a terminal since the last refresh still counts.
        const listeners = await listListeners();
        const running = devListeners(listeners).find((a) => a.project && projects.norm(a.project.dir) === projects.norm(p.dir));
        if (running) return send(res, 200, { alreadyRunning: true, port: running.port });
        // Launched by Mina and still booting (not listening yet).
        if (projects.ownPid(p.id)) return send(res, 200, { alreadyStarting: true });
        if (!projects.detect(p.dir)) return send(res, 400, { error: `Folder not found or no longer runnable: ${p.dir}` });
        if (projects.needsInstall(p) && !body.install) return send(res, 200, { needsInstall: true });
        const conflict = !body.force && portConflict(p, listeners);
        if (conflict) return send(res, 200, { conflicts: [conflict] });
        try { await projects.start(p, { install: !!body.install, flight }); }
        catch (e) { return send(res, 500, { error: String(e.message || e) }); }
        return send(res, 200, flight.cancelled ? { cancelled: true } : { ok: true });
      } finally {
        projects.release(p.id, flight);
      }
    }
    // Newline-delimited JSON over a held-open response (fetch can send the token header; EventSource can't).
    // Polls the file only while someone is watching, and stops when the tab closes.
    if (req.url === '/api/projects/logs/stream') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      let offsets = { out: -1, err: -1 };
      const push = () => {
        const r = projects.readLogs(p.id, offsets);
        offsets = r.offsets;
        if (r.out || r.err) res.write(JSON.stringify({ out: r.out, err: r.err }) + '\n');
      };
      push();
      const timer = setInterval(push, 700);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (req.url === '/api/projects/stop') { await projects.stop(p, devListeners(await listListeners())); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'not found' });
  }

  // Static files (css, js, images) from public/. no-cache so edits show up on a plain refresh.
  const type = STATIC_TYPES[path.extname(req.url.split('?')[0])];
  if (req.method === 'GET' && type) {
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0]); } catch { return send(res, 400, { error: 'bad path' }); }
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(file));
  }
  if (req.method !== 'GET' || (req.url !== '/' && !req.url.startsWith('/?'))) return send(res, 404, { error: 'not found' });
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // Stop other sites from framing the dashboard and clicking its buttons.
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
  res.end(html);
}

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Port ${PORT} is already in use. Try: mina --port <another port>`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Mina running on http://localhost:${PORT}`));

module.exports = { server, PORT };
