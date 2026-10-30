// Saved projects: detect how to run a folder, start/stop it, and remember it in ~/.mina/config.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const platform = require('./platform');
const runners = require('./runners');

const HOME = path.join(os.homedir(), '.mina');
const CONFIG = path.join(HOME, 'config.json');
const LOGS = path.join(HOME, 'logs');
// Dependency, build and environment folders of every supported technology: never projects of their own.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'bin', 'obj', 'venv', 'env', '__pycache__']);

// id -> { pid, startedAt } for processes this dashboard spawned.
const spawned = new Map();

// Windows and macOS file systems ignore case; Linux does not.
const norm = (d) => (platform.WIN || platform.MAC ? path.resolve(d).toLowerCase() : path.resolve(d));
const idFor = (dir) => crypto.createHash('sha1').update(norm(dir)).digest('hex').slice(0, 10);

// A config that can't be read is moved aside (config.json.broken-<time>) rather than overwritten by the next save,
// so a bad hand edit never silently wipes the saved projects.
function loadConfig() {
  let text;
  try { text = fs.readFileSync(CONFIG, 'utf8'); } catch { return { projects: [] }; }
  let cfg;
  try { cfg = JSON.parse(text); } catch {
    try { fs.renameSync(CONFIG, `${CONFIG}.broken-${Date.now()}`); } catch {}
    return { projects: [] };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  cfg.projects = Array.isArray(cfg.projects)
    ? cfg.projects.filter((p) => p && typeof p.id === 'string' && typeof p.dir === 'string')
    : [];
  return cfg;
}

// Write-then-rename: a crash mid-save leaves the old file, never a half-written one.
function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${CONFIG}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG);
}

// A folder is runnable if some runner recognises it: a package.json with a dev script, manage.py, artisan,
// bin/rails, go.mod, Cargo.toml or a .csproj. See runners.js.
const detect = (dir) => runners.detect(dir);

// Subfolder projects win over the folder itself: a workspace root's "dev" usually just runs them all via
// concurrently, and its ports belong to the subfolders, so it could never show as running.
// isApp(deps) says whether the folder itself is a real app (has framework deps): then it is offered next to
// its subfolders, so an app with an e2e/ or docs/ subproject can still be added.
function scan(dir, isApp = () => false) {
  let entries;
  try {
    if (!dir || !fs.statSync(dir).isDirectory()) return [];
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return []; } // missing, or no permission to read it
  const children = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => detect(path.join(dir, e.name)))
    .filter(Boolean);
  const self = detect(dir);
  if (!children.length) return self ? [self] : [];
  // A Django/Laravel/Rails/Go/... app is always an app; a Node root only when it has framework dependencies.
  return self && (self.runner !== 'node' || isApp(self.deps)) ? [self, ...children] : children;
}

function addProjects(dirs) {
  const cfg = loadConfig();
  const known = new Set(cfg.projects.map((p) => norm(p.dir)));
  for (const dir of dirs) {
    const found = detect(dir);
    if (!found || known.has(norm(found.dir))) continue;
    cfg.projects.push({ id: idFor(found.dir), dir: found.dir, name: found.name, runner: found.runner,
      ...(found.runner === 'node' && { script: found.script, pm: found.pm }) });
    known.add(norm(found.dir));
  }
  saveConfig(cfg);
}

function removeProject(id) {
  const cfg = loadConfig();
  cfg.projects = cfg.projects.filter((p) => p.id !== id);
  saveConfig(cfg);
}

const getProject = (id) => loadConfig().projects.find((p) => p.id === id);
// Dependencies to install first (node_modules, vendor), per runner. See runners.js.
const needsInstall = (p) => !!detect(p.dir)?.install;
const { isAlive } = platform;

const logPaths = (id) => ({ out: path.join(LOGS, `${id}.log`), err: path.join(LOGS, `${id}.err.log`) });

// id -> { cancelled } from the moment a start is requested until the launch has a PID. A start request claims
// it before its first await, so a second click is refused, and a stop at any point cancels instead of being lost.
const launching = new Map();

function claim(id) {
  if (launching.has(id)) return null;
  const flight = { cancelled: false };
  launching.set(id, flight);
  return flight;
}

function release(id, flight) {
  if (launching.get(id) === flight) launching.delete(id);
}

// Pass the flight from claim() when the caller claimed earlier; otherwise start() claims for itself.
// The command comes from the folder as it is now (runners.js), never from the saved config: a hand-edited
// config.json can point at a folder, but it can't choose what runs there.
async function start(p, { install = false, flight: claimed } = {}) {
  const info = detect(p.dir);
  if (!info) throw new Error(`Folder not found or no longer runnable: ${p.dir}`);
  const steps = [...(install && info.install ? [info.install] : []), info.command];
  if (!steps.every(runners.safeCommand)) throw new Error('bad command');
  const flight = claimed || claim(p.id);
  if (!flight) throw new Error('already starting');
  try {
    if (flight.cancelled) return null;
    fs.mkdirSync(LOGS, { recursive: true });
    const { out, err } = logPaths(p.id);
    const pid = await platform.launch({
      command: steps.join(' && '),
      dir: p.dir, out, err, pidFile: pidPath(p.id),
      // BROWSER=none stops CRA-style servers from opening their own tab.
      // Same clean env as the editors get: an Electron-based dev server would misbehave with ELECTRON_RUN_AS_NODE set.
      env: { ...require('./ides').cleanEnv(), BROWSER: 'none', FORCE_COLOR: '0' },
    });
    const rec = readPidFile(p.id);
    if (rec && rec.pid === pid) owned.set(p.id, rec);
    // Stopped while it was launching: finish the job now that there is a PID to kill.
    if (flight.cancelled) {
      forget(p.id);
      await platform.killTree(pid);
      return null;
    }
    spawned.set(p.id, { pid, startedAt: Date.now() });
    return pid;
  } finally {
    release(p.id, flight);
  }
}

const pidPath = (id) => path.join(LOGS, `${id}.pid`);

// "pid startTime" (older versions wrote only the pid, which can't be verified and is ignored).
function readPidFile(id) {
  try {
    const [pid, start] = fs.readFileSync(pidPath(id), 'utf8').trim().split(/\s+/).map(Number);
    return pid > 0 && start > 0 ? { pid, start } : null;
  } catch { return null; }
}

// id -> { pid, start } for launchers whose PID and start time were confirmed to still match.
const owned = new Map();

// drop: the PID is no longer ours (dead or recycled), but a launch that died still reads as 'crashed'.
// forget: the user stopped it, so nothing about the run is kept.
function drop(id) {
  owned.delete(id);
  try { fs.unlinkSync(pidPath(id)); } catch {}
}
function forget(id) {
  drop(id);
  spawned.delete(id);
}

// The pid file outlives a dashboard restart, so a server we launched earlier is still recognised as ours. But a
// PID alone is not proof: after a crash or reboot the OS hands it to some other process, which Mina must then
// never adopt or kill. So a PID counts as ours only while its start time matches the one recorded at launch.
async function verifyOwned() {
  const recs = loadConfig().projects.map((p) => [p.id, readPidFile(p.id)]);
  for (const [id, rec] of recs) {
    if ((!rec || !isAlive(rec.pid)) && !launching.has(id)) drop(id);
  }
  const live = recs.filter(([id, rec]) => rec && isAlive(rec.pid) && !launching.has(id));
  if (!live.length) return;
  const times = await platform.startTimes(live.map(([, rec]) => rec.pid));
  for (const [id, rec] of live) {
    if (platform.sameStart(times.get(rec.pid), rec.start)) owned.set(id, rec);
    else if (isAlive(rec.pid)) drop(id); // recycled PID: not ours any more
  }
}

// Many requests arrive together (a refresh, a group action); one verification serves them all for a moment.
let verifying = null;
let verifiedAt = 0;
function refreshOwnership() {
  if (verifying) return verifying;
  if (Date.now() - verifiedAt < 1500) return Promise.resolve();
  verifying = verifyOwned().catch(() => {}).finally(() => { verifying = null; verifiedAt = Date.now(); });
  return verifying;
}

function ownPid(id) {
  const rec = owned.get(id);
  if (!rec) return null;
  if (isAlive(rec.pid)) return rec.pid;
  drop(id);
  return null;
}

const isStarting = (id) => launching.has(id);

async function stop(p, apps) {
  queued.delete(p.id);
  const flight = launching.get(p.id);
  if (flight) flight.cancelled = true;
  const pids = new Set(apps.filter((a) => a.project && norm(a.project.dir) === norm(p.dir)).map((a) => a.pid));
  // Re-check right before killing: this is the one place where a wrong PID would hurt.
  const rec = owned.get(p.id);
  if (rec && platform.sameStart((await platform.startTimes([rec.pid])).get(rec.pid), rec.start)) pids.add(rec.pid);
  forget(p.id);
  await Promise.all([...pids].map(platform.killTree));
}

const LOG_TAIL = 64 * 1024;

// Bytes of a log from `from` onward; a negative `from` means "the last LOG_TAIL bytes".
function readFrom(file, from) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { text: '', size: 0 }; }
  // A restart truncates the file; start over instead of reading past the end.
  const start = from < 0 || from > size ? Math.max(0, size - LOG_TAIL) : from;
  if (start >= size) return { text: '', size };
  const buf = Buffer.alloc(size - start);
  try {
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  } catch { return { text: '', size: Math.max(0, from) }; } // removed or locked between stat and open: try next tick
  // Stop before a multi-byte character that is still being written; its bytes are read next time.
  const end = utf8Boundary(buf);
  return { text: buf.toString('utf8', 0, end), size: start + end };
}

// Length of buf without a trailing, incomplete UTF-8 sequence.
function utf8Boundary(buf) {
  for (let i = buf.length - 1, n = 0; i >= 0 && n < 4; i--, n++) {
    const b = buf[i];
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return n + 1 >= need ? buf.length : i;
  }
  return buf.length;
}

function readLogs(id, offsets = { out: -1, err: -1 }) {
  const files = logPaths(id);
  const out = readFrom(files.out, offsets.out);
  const err = readFrom(files.err, offsets.err);
  return { out: out.text, err: err.text, offsets: { out: out.size, err: err.size } };
}

// Waiting their turn inside a "start group" run.
const queued = new Set();

// An explicit group wins ("" means "no group"); otherwise projects sharing a parent folder group under its name.
// Group names are user text ("toString", "__proto__" included), so every lookup table has a null prototype.
// Two different parent folders with the same name ("C:\work\app" and "D:\old\app") get distinct group names,
// otherwise starting or removing one would act on both.
function groupsFor(list) {
  const byParent = Object.create(null);
  for (const p of list) (byParent[norm(path.dirname(p.dir))] ||= []).push(p);
  const parentDir = (k) => path.dirname(byParent[k][0].dir);
  const parents = Object.keys(byParent).filter((k) => byParent[k].length > 1);
  const label = Object.create(null);
  const byBase = Object.create(null);
  for (const k of parents) {
    const base = path.basename(parentDir(k)) || parentDir(k);
    (byBase[base] ||= []).push(k);
    label[k] = base;
  }
  for (const base of Object.keys(byBase)) {
    const clash = byBase[base];
    if (clash.length < 2) continue;
    for (const k of clash) label[k] = `${base} (${path.basename(path.dirname(parentDir(k))) || parentDir(k)})`;
    // Still the same (e.g. "x\app" on two drives): fall back to the full path.
    const count = Object.create(null);
    for (const k of clash) count[label[k]] = (count[label[k]] || 0) + 1;
    for (const k of clash) if (count[label[k]] > 1) label[k] = parentDir(k);
  }
  const out = Object.create(null);
  for (const p of list) {
    if (typeof p.group === 'string') out[p.id] = p.group.trim() || null;
    else out[p.id] = label[norm(path.dirname(p.dir))] || null;
  }
  return out;
}

// The folder that holds every project of a group (what "open the whole group" opens). A drive root or a
// home folder is too broad to be useful, so those give null.
function commonDir(dirs) {
  if (!dirs.length) return null;
  const fold = platform.WIN || platform.MAC ? (s) => s.toLowerCase() : (s) => s;
  // Compare below the root ("C:\\", "/", or a UNC "\\\\server\\share\\"), which must be the same for all.
  const root = path.parse(path.resolve(dirs[0])).root;
  const split = (d) => {
    const abs = path.resolve(d);
    return fold(path.parse(abs).root) === fold(root) ? abs.slice(root.length).split(/[\\/]+/).filter(Boolean) : null;
  };
  let common = split(dirs[0]);
  for (const d of dirs.slice(1)) {
    const parts = split(d);
    if (!parts) return null;
    let n = 0;
    while (n < common.length && n < parts.length && fold(common[n]) === fold(parts[n])) n++;
    common = common.slice(0, n);
  }
  if (!common.length) return null;
  const dir = path.join(root, ...common);
  if (norm(dir) === norm(os.homedir())) return null;
  return dir;
}

function groupRoots() {
  const list = loadConfig().projects;
  const groups = groupsFor(list);
  const byGroup = Object.create(null);
  for (const p of list) if (groups[p.id]) (byGroup[groups[p.id]] ||= []).push(p.dir);
  return Object.fromEntries(Object.entries(byGroup).map(([g, dirs]) => [g, commonDir(dirs)]));
}

function setGroup(id, group) {
  const cfg = loadConfig();
  const p = cfg.projects.find((x) => x.id === id);
  if (p) { p.group = String(group ?? '').trim(); saveConfig(cfg); }
}

// running = a listener belongs to its folder; starting = we spawned it and it is still alive; crashed = it died before listening.
function withStatus(apps, classifyDeps) {
  const cfg = loadConfig();
  const groups = groupsFor(cfg.projects);
  const roots = groupRoots();
  let dirty = false;
  const result = cfg.projects.map((p) => {
    const app = apps.find((a) => a.project && norm(a.project.dir) === norm(p.dir));
    const own = spawned.get(p.id);
    let state = 'stopped';
    if (app) { state = 'running'; spawned.delete(p.id); }
    else if (queued.has(p.id)) state = 'queued';
    else if (launching.has(p.id)) state = 'starting';
    else if (own) state = isAlive(own.pid) ? 'starting' : 'crashed';
    // Remember the port so a later start can warn when something else took it.
    if (app && p.lastPort !== app.port) { p.lastPort = app.port; dirty = true; }
    const info = detect(p.dir);
    const { kind, framework } = (info?.framework && { kind: info.kind, framework: info.framework })
      || classifyDeps(info?.deps || []) || { kind: 'frontend', framework: info?.pm || p.pm || 'node' };
    return {
      ...p,
      state,
      kind: app?.kind || kind,
      framework: app?.framework || framework,
      port: app?.port ?? null,
      runner: info?.runner || p.runner || 'node',
      missing: !info,
      needsInstall: !!info?.install,
      installCommand: info?.install || null,
      installWhat: info?.installWhat || null,
      command: info?.command || '',
      logFile: logPaths(p.id).out,
      hasLog: fs.existsSync(logPaths(p.id).out),
      // Live only when the running process is one we launched; otherwise the file is from an older run.
      logLive: !!ownPid(p.id),
      group: groups[p.id],
      groupRoot: groups[p.id] ? roots[groups[p.id]] : null,
    };
  });
  if (dirty) saveConfig(cfg);
  return result;
}

// The saved project whose launcher process appears among these ancestor PIDs.
function ownerOf(chain) {
  for (const p of loadConfig().projects) {
    const pid = ownPid(p.id);
    if (pid && chain.includes(pid)) {
      const info = detect(p.dir);
      return { name: info?.name || p.name, dir: p.dir, deps: info?.deps || [], framework: info?.framework || null };
    }
  }
  return null;
}

const groupMembers = (name) => {
  const list = loadConfig().projects;
  const groups = groupsFor(list);
  return list.filter((p) => groups[p.id] === name);
};

// Only verified launchers: a PID remembered from a run that has since died could belong to anything now.
const spawnedPids = () => loadConfig().projects.map((p) => ownPid(p.id)).filter(Boolean);

// Opens where the user last picked from (or next to their latest project).
async function pickFolder() {
  const cfg = loadConfig();
  const last = cfg.projects[cfg.projects.length - 1];
  const start = cfg.lastPickDir || (last ? path.dirname(path.dirname(last.dir)) : os.homedir());
  const dir = await platform.pickFolder(start);
  if (dir) {
    const fresh = loadConfig();
    fresh.lastPickDir = path.dirname(dir);
    saveConfig(fresh);
  }
  return dir;
}

module.exports = {
  scan, detect, addProjects, removeProject, getProject, needsInstall, start, stop, withStatus, spawnedPids, pickFolder, readLogs,
  setGroup, groupMembers, groupRoots, ownerOf, queued, ownPid, norm, refreshOwnership, isStarting, claim, release,
};
