// Shared test helpers: isolated homes, fixture projects, a Mina instance per test file, raw HTTP.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const WIN = process.platform === 'win32';
// Fixtures live inside the repo, not os.tmpdir(): on Windows the temp folder is under AppData, which Mina
// treats as tooling and hides on purpose.
const TMP = path.join(__dirname, '.tmp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let seq = 0;
function tmpDir(prefix = 'd') {
  const dir = path.join(TMP, `${prefix}-${process.pid}-${Date.now().toString(36)}-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Test files run in parallel, and a port that is free now can be taken by another file before it's bound.
// Each port handed out is reserved with a lock file created atomically ('wx'), so no two test processes can ever
// get the same one. (A per-process block by PID wasn't enough: Windows PIDs are multiples of 4, so blocks collided.)
const PORT_LOCKS = path.join(TMP, 'ports');
let portCursor = 20000 + Math.floor(Math.random() * 20000);
// Free on this address? Only "in use" says no: a machine without IPv6 can't bind ::1 at all, which is fine.
const tryPort = (port, host) => new Promise((resolve) => {
  const s = net.createServer();
  s.unref();
  s.on('error', (e) => resolve(e.code !== 'EADDRINUSE' && e.code !== 'EACCES'));
  s.listen(port, host, () => s.close(() => resolve(true)));
});
async function freePort() {
  fs.mkdirSync(PORT_LOCKS, { recursive: true });
  for (let i = 0; i < 500; i++) {
    const port = 20000 + ((portCursor++ - 20000) % 25000);
    try { fs.closeSync(fs.openSync(path.join(PORT_LOCKS, String(port)), 'wx')); } catch { continue; } // someone else's
    if (await tryPort(port, '127.0.0.1') && await tryPort(port, '::1')) return port;
  }
  throw new Error('no free port found');
}

// Is anything accepting connections on this port (IPv4 or IPv6 loopback)?
function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    sock.setTimeout(800);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error', () => resolve(false));
  });
}

async function waitFor(fn, { timeout = 30000, interval = 300, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// The code each fixture runs as its dev server. Options are baked in so the command line stays "npm run dev".
function serverSource({ port, type = 'html', delay = 0, exitCode = null, host = '127.0.0.1', title = 'Fixture', marker, spawnChild = false }) {
  return `
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
console.log('booting fixture on ${port}');
console.error('warning: this line goes to stderr');
${exitCode !== null ? `console.error('Error: fixture crashed on purpose'); process.exit(${exitCode});` : ''}
${spawnChild ? `fs.writeFileSync('child.pid', String(spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }).pid));` : ''}
setTimeout(() => {
  http.createServer((req, res) => {
    if (${JSON.stringify(type)} === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><html><head><title>${title}</title></head><body>hi</body></html>');
    }
    if (['/health', '/docs', '/api'].includes(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"nope"}');
  }).listen(${port}, ${JSON.stringify(host)}, () => {
    ${marker ? `fs.appendFileSync(${JSON.stringify(marker)}, Date.now() + '\\n');` : ''}
    console.log('listening on ${port}');
  });
}, ${delay});
`;
}

// A project folder whose "dev" script runs a fixture server. lock picks the package manager.
function makeProject(parent, name, { deps = [], scripts, lock, nodeModules = true, server, pkgName } = {}) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  const pkg = {
    name: pkgName ?? name,
    version: '1.0.0',
    private: true,
    scripts: scripts || { dev: 'node server.js' },
    dependencies: Object.fromEntries(deps.map((d) => [d, '*'])),
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  if (lock) fs.writeFileSync(path.join(dir, lock), '');
  if (nodeModules) fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  if (server) fs.writeFileSync(path.join(dir, 'server.js'), serverSource(server));
  return dir;
}

// Start a server "from a terminal": plain node with an absolute script path, outside Mina.
function runExternal(dir) {
  const child = spawn(process.execPath, [path.join(dir, 'server.js')], { cwd: dir, stdio: 'ignore', windowsHide: true });
  return child;
}

function killQuiet(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill('SIGKILL'); } catch {}
}

// Environment for a Mina child with its own home, so ~/.mina of the person running the tests is untouched.
function isolatedEnv(home, extra = {}) {
  // npm stays offline-friendly and quiet: no audit, fund or update-check requests during "install".
  const env = { ...process.env, HOME: home, USERPROFILE: home, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  delete env.MINA_PORT; // the caller's own setting must not leak in; a test passes it explicitly when it wants one
  // Toolchains that live under the real home keep working with the fake one (rustup finds no toolchain otherwise).
  env.RUSTUP_HOME ||= path.join(os.homedir(), '.rustup');
  env.CARGO_HOME ||= path.join(os.homedir(), '.cargo');
  return { ...env, ...extra };
}

// Raw HTTP so Host, Origin and every header can be set exactly (fetch would rewrite Host).
function request(port, { method = 'GET', path: p = '/', headers = {}, body, host = '127.0.0.1', timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host, port, method, path: p, headers: { ...(data !== undefined ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }, timeout }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

// One Mina per test file: its own port and home. Returns helpers bound to it.
async function startMina({ home = tmpDir('home'), port } = {}) {
  port ||= await freePort();
  const proc = spawn(process.execPath, [CLI, '--no-open', '--port', String(port)], {
    env: isolatedEnv(home), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  await waitFor(() => output.includes('Mina running on') || (proc.exitCode !== null && Promise.reject(new Error(output))), { timeout: 15000, what: 'Mina to start' });
  const host = `localhost:${port}`;
  const page = await request(port, { headers: { Host: host } });
  const token = (page.text.match(/<meta name="token" content="([^"]+)"/) || [])[1];
  if (!token) throw new Error('no token in page');
  const mina = {
    port, home, proc, token, host,
    get output() { return output; },
    alive: () => proc.exitCode === null,
    api: async (p, body) => {
      const res = await request(port, {
        method: body === undefined ? 'GET' : 'POST', path: p, body,
        headers: { Host: host, 'X-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      });
      return res.json ?? res;
    },
    raw: (opts) => request(port, { ...opts, headers: { Host: host, ...(opts.headers || {}) } }),
    apps: async (all) => (await mina.api(`/api/apps${all ? '?all=1' : ''}`)),
    stop: async () => {
      if (proc.exitCode !== null) return;
      proc.kill();
      await waitFor(() => proc.exitCode !== null || proc.signalCode, { timeout: 5000, what: 'Mina to exit' }).catch(() => proc.kill('SIGKILL'));
    },
  };
  return mina;
}

// Stop every saved project of a Mina instance (best effort) so no fixture outlives the tests.
async function stopAllProjects(mina) {
  try {
    const { projects = [] } = await mina.apps();
    await Promise.all(projects.map((p) => mina.api('/api/projects/stop', { id: p.id })));
  } catch {}
}

function rmQuiet(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}

const has = (cmd, args = ['--version']) => {
  try {
    const r = require('child_process').spawnSync(cmd, args, { stdio: 'pipe', timeout: 15000, shell: WIN });
    return r.status === 0;
  } catch { return false; }
};

module.exports = {
  ROOT, CLI, WIN, TMP, sleep, isAlive, tmpDir, freePort, portOpen, waitFor, makeProject, serverSource, runExternal, killQuiet,
  isolatedEnv, request, startMina, stopAllProjects, rmQuiet, has,
};
