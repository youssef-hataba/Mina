// End to end, the way a user drives Mina: add, start, logs, stop, crash, install, conflicts, groups, restarts.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('../helpers');

let mina;
let root;
const extra = [];

before(async () => {
  root = h.tmpDir('life');
  mina = await h.startMina();
});

after(async () => {
  await h.stopAllProjects(mina);
  extra.forEach(h.killQuiet);
  await mina?.stop();
  h.rmQuiet(root);
  h.rmQuiet(mina?.home);
});

const project = async (name) => (await mina.apps()).projects.find((p) => p.name === name);
const waitState = (name, states, timeout = 60000) => h.waitFor(async () => {
  const p = await project(name);
  return p && [].concat(states).includes(p.state) && p;
}, { timeout, interval: 1000, what: `${name} to be ${states}` });

async function addAndGet(dir) {
  assert.deepEqual(await mina.api('/api/projects/add', { dirs: [dir] }), { ok: true });
  const p = await project(path.basename(dir));
  assert.ok(p, 'added');
  return p;
}

describe('adding projects', () => {
  test('scanning a workspace offers each runnable project with its kind and framework', async () => {
    const ws = path.join(root, 'shop');
    h.makeProject(ws, 'api', { deps: ['express'] });
    h.makeProject(ws, 'web', { deps: ['vite', 'react'], lock: 'pnpm-lock.yaml' });
    h.makeProject(ws, 'node_modules');
    const { candidates } = await mina.api('/api/projects/scan', { dir: ws });
    const byName = Object.fromEntries(candidates.map((c) => [c.name, c]));
    assert.deepEqual(Object.keys(byName).sort(), ['api', 'web']);
    assert.equal(byName.api.kind, 'backend');
    assert.equal(byName.api.framework, 'Express');
    assert.equal(byName.web.kind, 'frontend');
    assert.equal(byName.web.framework, 'Vite');
    assert.equal(byName.web.pm, 'pnpm');
    assert.equal(byName.api.script, 'dev');
    assert.equal(byName.api.deps, undefined, 'dependency lists are not sent to the page');
  });

  test('scanning junk returns no candidates', async () => {
    for (const dir of ['', '   ', path.join(root, 'missing'), 'not a path', '\0']) {
      assert.deepEqual((await mina.api('/api/projects/scan', { dir })).candidates, [], JSON.stringify(dir));
    }
  });

  test('added projects show up as stopped, grouped by their folder, with a non-ASCII path intact', async () => {
    const ws = path.join(root, 'متجر');
    const a = h.makeProject(ws, 'واجهة');
    const b = h.makeProject(ws, 'خادم');
    await mina.api('/api/projects/add', { dirs: [a, b] });
    const list = (await mina.apps()).projects.filter((p) => p.group === 'متجر');
    assert.equal(list.length, 2);
    assert.ok(list.every((p) => p.state === 'stopped'));
    assert.ok(list.some((p) => p.dir === path.resolve(a)), 'path survives the JSON round trip');
  });
});

describe('a single project: start, logs, stop', () => {
  let port;
  let p;
  before(async () => {
    port = await h.freePort();
    p = await addAndGet(h.makeProject(root, 'single-api', { deps: ['express'], server: { port, type: 'json', spawnChild: true } }));
  });

  test('start → starting → running on its port', async () => {
    assert.deepEqual(await mina.api('/api/projects/start', { id: p.id }), { ok: true });
    const running = await waitState('single-api', 'running');
    assert.equal(running.port, port);
    assert.equal(running.kind, 'backend');
    assert.equal(running.framework, 'Express');
    assert.equal(running.logLive, true);
    assert.equal(running.command, 'npm run dev');
  });

  test('the running server appears as an app linked to the project', async () => {
    const app = (await mina.apps()).apps.find((a) => a.port === port);
    assert.ok(app);
    assert.equal(app.project.name, 'single-api');
  });

  test('starting it again does not launch a second copy', async () => {
    const res = await mina.api('/api/projects/start', { id: p.id });
    assert.equal(res.alreadyRunning, true);
    assert.equal(res.port, port);
  });

  test('logs stream live: stdout and stderr, in NDJSON', async () => {
    const http = require('http');
    const chunks = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: mina.port, method: 'POST', path: '/api/projects/logs/stream',
        headers: { Host: mina.host, 'X-Token': mina.token, 'Content-Type': 'application/json' } }, (res) => {
        assert.match(res.headers['content-type'], /ndjson/);
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          buf += d;
          if (/listening on/.test(buf) && /stderr/.test(buf)) { req.destroy(); resolve(buf); }
        });
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
      req.end(JSON.stringify({ id: p.id }));
      setTimeout(() => reject(new Error('no log lines within 15 s')), 15000);
    });
    const lines = chunks.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => /booting fixture/.test(l.out)));
    assert.ok(lines.some((l) => /warning: this line goes to stderr/.test(l.err)));
  });

  test('closing the log stream does not affect the server', async () => {
    assert.ok(await h.portOpen(port));
    assert.ok(mina.alive());
  });

  test('stop kills the whole tree: the port closes and the child process dies', async () => {
    const childPid = Number(fs.readFileSync(path.join(root, 'single-api', 'child.pid'), 'utf8'));
    assert.ok(h.isAlive(childPid));
    assert.deepEqual(await mina.api('/api/projects/stop', { id: p.id }), { ok: true });
    await h.waitFor(async () => !(await h.portOpen(port)), { timeout: 15000, what: 'port to close' });
    await h.waitFor(() => !h.isAlive(childPid), { timeout: 10000, what: 'grandchild to die' });
    const stopped = await waitState('single-api', 'stopped', 15000);
    assert.equal(stopped.logLive, false);
    assert.equal(stopped.hasLog, true, 'the last log stays readable');
  });

  test('stopping an already stopped project is harmless', async () => {
    assert.deepEqual(await mina.api('/api/projects/stop', { id: p.id }), { ok: true });
  });

  test('it can be started again after a stop', async () => {
    await mina.api('/api/projects/start', { id: p.id });
    await waitState('single-api', 'running');
    await mina.api('/api/projects/stop', { id: p.id });
    await h.waitFor(async () => !(await h.portOpen(port)), { timeout: 15000, what: 'port to close' });
  });
});

describe('failures are reported, never hidden', () => {
  test('a server that exits on boot shows as crashed, with its error in the log', async () => {
    const p = await addAndGet(h.makeProject(root, 'crasher', { server: { port: await h.freePort(), exitCode: 1 } }));
    await mina.api('/api/projects/start', { id: p.id });
    const crashed = await waitState('crasher', 'crashed', 30000);
    assert.equal(crashed.hasLog, true);
    const logs = fs.readFileSync(crashed.logFile.replace(/\.log$/, '.err.log'), 'utf8');
    assert.match(logs, /crashed on purpose/);
  });

  test('a missing package manager (pnpm project without pnpm) ends as crashed, not stuck', async (t) => {
    if (h.has('pnpm')) return t.skip('pnpm is installed here');
    const p = await addAndGet(h.makeProject(root, 'needs-pnpm', { lock: 'pnpm-lock.yaml', server: { port: await h.freePort() } }));
    assert.equal(p.command, 'pnpm run dev');
    await mina.api('/api/projects/start', { id: p.id });
    await waitState('needs-pnpm', 'crashed', 30000);
  });

  test('a project whose folder was deleted is marked missing and refuses to start', async () => {
    const dir = h.makeProject(root, 'vanishing', { server: { port: await h.freePort() } });
    const p = await addAndGet(dir);
    h.rmQuiet(dir);
    assert.equal((await project('vanishing')).missing, true);
    const res = await mina.api('/api/projects/start', { id: p.id });
    assert.match(res.error, /not found/i);
    assert.ok(mina.alive());
  });
});

describe('dependencies', () => {
  test('without node_modules Mina asks first, then installs and starts', { timeout: 180000 }, async () => {
    const port = await h.freePort();
    // A real (local, offline) dependency, so "npm install" has something to put in node_modules.
    const dir = h.makeProject(root, 'fresh-clone', { nodeModules: false, server: { port } });
    const dep = path.join(dir, 'local-dep');
    fs.mkdirSync(dep);
    fs.writeFileSync(path.join(dep, 'package.json'), '{"name":"local-dep","version":"1.0.0"}');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.dependencies = { 'local-dep': 'file:./local-dep' };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    const p = await addAndGet(dir);
    assert.equal(p.needsInstall, true);
    assert.deepEqual(await mina.api('/api/projects/start', { id: p.id }), { needsInstall: true });
    assert.equal((await project('fresh-clone')).state, 'stopped', 'nothing ran without consent');
    assert.deepEqual(await mina.api('/api/projects/start', { id: p.id, install: true }), { ok: true });
    await waitState('fresh-clone', 'running', 150000);
    assert.equal((await project('fresh-clone')).needsInstall, false);
    assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'local-dep')));
    await mina.api('/api/projects/stop', { id: p.id });
  });

  test('a project without any dependencies is never nagged to install', async () => {
    const p = await addAndGet(h.makeProject(root, 'no-deps', { nodeModules: false, server: { port: await h.freePort() } }));
    assert.equal(p.needsInstall, false);
  });
});

describe('package managers', () => {
  // Each one actually runs the dev script; skipped where the tool isn't installed (CI installs all of them).
  const managers = [['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lock']];
  for (const [pm, lock] of managers) {
    test(`${pm}: detected from ${lock}, started with "${pm} run dev", stopped cleanly`, { timeout: 120000 }, async (t) => {
      if (!h.has(pm)) return t.skip(`${pm} is not installed`);
      const port = await h.freePort();
      const p = await addAndGet(h.makeProject(root, `with-${pm}`, { lock, server: { port } }));
      assert.equal(p.command, `${pm} run dev`);
      assert.deepEqual(await mina.api('/api/projects/start', { id: p.id }), { ok: true });
      await waitState(`with-${pm}`, 'running', 90000);
      await mina.api('/api/projects/stop', { id: p.id });
      await h.waitFor(async () => !(await h.portOpen(port)), { timeout: 15000, what: 'port to close' });
    });
  }
});

describe('port conflicts', () => {
  test('if another process holds the project\'s usual port, Mina warns; "force" starts anyway', async () => {
    const port = await h.freePort();
    const p = await addAndGet(h.makeProject(root, 'conflicted', { server: { port } }));
    await mina.api('/api/projects/start', { id: p.id });
    await waitState('conflicted', 'running');
    await mina.api('/api/projects/stop', { id: p.id });
    await h.waitFor(async () => !(await h.portOpen(port)), { timeout: 15000, what: 'port to close' });

    // Something else takes the port.
    const squatter = require('child_process').spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end('x')).listen(${port},'127.0.0.1')`], { stdio: 'ignore' });
    extra.push(squatter);
    await h.waitFor(() => h.portOpen(port), { what: 'squatter' });
    const res = await mina.api('/api/projects/start', { id: p.id });
    assert.ok(res.conflicts, JSON.stringify(res));
    assert.equal(res.conflicts[0].port, port);
    assert.equal(res.conflicts[0].project, 'conflicted');
    assert.equal((await project('conflicted')).state, 'stopped');

    // Forced: it launches, cannot bind, and crashes visibly.
    assert.deepEqual(await mina.api('/api/projects/start', { id: p.id, force: true }), { ok: true });
    await waitState('conflicted', 'crashed', 30000);
    h.killQuiet(squatter);
  });
});

describe('groups', () => {
  let ws;
  let apiPort;
  let webPort;
  before(async () => {
    ws = path.join(root, 'stack');
    apiPort = await h.freePort();
    webPort = await h.freePort();
    // The backend takes 12 s to listen; the frontend must still come up after it. Long enough that the frontend is
    // reliably still queued when checked, even when a refresh is slow because the machine is busy.
    h.makeProject(ws, 'backend', { deps: ['@nestjs/core'], server: { port: apiPort, type: 'json', delay: 12000, marker: path.join(ws, 'backend.up') } });
    h.makeProject(ws, 'frontend', { deps: ['next'], server: { port: webPort, marker: path.join(ws, 'frontend.up') } });
    await mina.api('/api/projects/add', { dirs: [path.join(ws, 'backend'), path.join(ws, 'frontend')] });
  });

  test('start group: backends first, frontends only once the backend is listening', { timeout: 120000 }, async () => {
    const res = await mina.api('/api/groups/start', { group: 'stack' });
    assert.deepEqual(res, { ok: true, starting: 2 });
    const queuedOrStarting = await project('frontend');
    assert.ok(['queued', 'starting'].includes(queuedOrStarting.state), queuedOrStarting.state);
    await waitState('backend', 'running', 60000);
    await waitState('frontend', 'running', 60000);
    const backendUp = Number(fs.readFileSync(path.join(ws, 'backend.up'), 'utf8'));
    const frontendUp = Number(fs.readFileSync(path.join(ws, 'frontend.up'), 'utf8'));
    assert.ok(frontendUp >= backendUp, `frontend listened ${backendUp - frontendUp} ms before the backend`);
  });

  test('start group again while everything runs starts nothing', async () => {
    assert.deepEqual(await mina.api('/api/groups/start', { group: 'stack' }), { ok: true, starting: 0 });
  });

  test('stop group closes every port', async () => {
    assert.deepEqual(await mina.api('/api/groups/stop', { group: 'stack' }), { ok: true });
    await h.waitFor(async () => !(await h.portOpen(apiPort)) && !(await h.portOpen(webPort)), { timeout: 20000, what: 'group ports to close' });
  });

  test('stop group during the wait cancels the frontends that have not started yet', { timeout: 60000 }, async () => {
    fs.rmSync(path.join(ws, 'frontend.up'), { force: true });
    await mina.api('/api/groups/start', { group: 'stack' });
    await h.sleep(1000);
    assert.equal((await project('frontend')).state, 'queued');
    await mina.api('/api/groups/stop', { group: 'stack' });
    await h.sleep(6000);
    assert.equal(fs.existsSync(path.join(ws, 'frontend.up')), false, 'the frontend never started');
    assert.equal(await h.portOpen(webPort), false);
    await h.waitFor(async () => !(await h.portOpen(apiPort)), { timeout: 15000, what: 'backend port to close' });
  });

  test('a group with missing node_modules asks before installing anything', async () => {
    const g = path.join(root, 'fresh-group');
    h.makeProject(g, 'one', { nodeModules: false, deps: ['express'], server: { port: await h.freePort() } });
    h.makeProject(g, 'two', { server: { port: await h.freePort() } });
    await mina.api('/api/projects/add', { dirs: [path.join(g, 'one'), path.join(g, 'two')] });
    assert.deepEqual(await mina.api('/api/groups/start', { group: 'fresh-group' }), { needsInstall: ['one'] });
  });

  test('rename turns the folder group into a named group', async () => {
    assert.deepEqual(await mina.api('/api/groups/rename', { group: 'stack', name: '  Full Stack  ' }), { ok: true });
    const names = (await mina.apps()).projects.filter((p) => p.group === 'Full Stack').map((p) => p.name).sort();
    assert.deepEqual(names, ['backend', 'frontend']);
    assert.equal((await mina.api('/api/groups/rename', { group: 'Full Stack', name: '   ' })).error, 'empty name');
  });

  test('moving one project out of a group and back', async () => {
    const fe = await project('frontend');
    await mina.api('/api/projects/set-group', { id: fe.id, group: '' });
    assert.equal((await project('frontend')).group, null);
    await mina.api('/api/projects/set-group', { id: fe.id, group: 'Full Stack' });
    assert.equal((await project('frontend')).group, 'Full Stack');
  });

  test('remove group takes the projects off the list but leaves the folders', async () => {
    assert.deepEqual(await mina.api('/api/groups/remove', { group: 'Full Stack' }), { ok: true });
    assert.equal(await project('backend'), undefined);
    assert.ok(fs.existsSync(path.join(ws, 'backend', 'package.json')));
  });
});

describe('servers started outside Mina', () => {
  test('a saved project started from a terminal shows as running and Stop stops it', async () => {
    const port = await h.freePort();
    const dir = h.makeProject(root, 'terminal-started', { server: { port } });
    const p = await addAndGet(dir);
    const child = h.runExternal(dir);
    extra.push(child);
    await h.waitFor(() => h.portOpen(port), { what: 'port' });
    const running = await waitState('terminal-started', 'running', 20000);
    assert.equal(running.logLive, false, 'Mina does not have its output');
    assert.equal((await mina.api('/api/projects/start', { id: p.id })).alreadyRunning, true);
    await mina.api('/api/projects/stop', { id: p.id });
    await h.waitFor(() => child.exitCode !== null || child.signalCode, { timeout: 15000, what: 'external process to exit' });
  });
});

describe('Mina restarts', () => {
  test('a server Mina started keeps being recognised after Mina restarts, and can be stopped', { timeout: 120000 }, async () => {
    const port = await h.freePort();
    const p = await addAndGet(h.makeProject(root, 'survivor', { server: { port } }));
    await mina.api('/api/projects/start', { id: p.id });
    await waitState('survivor', 'running');

    // Restart Mina on the same home folder.
    const { home, port: minaPort } = mina;
    await mina.stop();
    assert.ok(await h.portOpen(port), 'the dev server outlives the dashboard');
    mina = await h.startMina({ home, port: minaPort });

    const again = await waitState('survivor', 'running', 30000);
    assert.equal(again.logLive, true, 'still known as launched by Mina');
    await mina.api('/api/projects/stop', { id: p.id });
    await h.waitFor(async () => !(await h.portOpen(port)), { timeout: 15000, what: 'port to close' });
  });

  test('a project still booting when Mina restarts (a long first build) stays "starting", not "stopped"', { timeout: 120000 }, async () => {
    const port = await h.freePort();
    const p = await addAndGet(h.makeProject(root, 'slow-boot', { server: { port, delay: 25000 } }));
    await mina.api('/api/projects/start', { id: p.id });
    await waitState('slow-boot', 'starting', 20000);

    const { home, port: minaPort } = mina;
    await mina.stop();
    mina = await h.startMina({ home, port: minaPort });

    assert.equal((await project('slow-boot')).state, 'starting');
    assert.deepEqual(await mina.api('/api/projects/start', { id: p.id }), { alreadyStarting: true }, 'no second copy');
    await waitState('slow-boot', 'running', 60000);
    await mina.api('/api/projects/stop', { id: p.id });
    await h.waitFor(async () => !(await h.portOpen(port)), { timeout: 15000, what: 'port to close' });
  });
});

describe('unusual folder names survive the whole round trip', () => {
  const names = ["o'brien & co", 'app[1] (copy)', '100% done', 'مشروع عربي', 'emoji 🚀'];
  for (const name of names) {
    test(`start and stop "${name}"`, { timeout: 90000 }, async () => {
      const port = await h.freePort();
      const p = await addAndGet(h.makeProject(path.join(root, 'weird'), name, { server: { port } }));
      assert.deepEqual(await mina.api('/api/projects/start', { id: p.id }), { ok: true });
      await waitState(name, 'running', 60000);
      await mina.api('/api/projects/stop', { id: p.id });
      await h.waitFor(async () => !(await h.portOpen(port)), { timeout: 15000, what: 'port to close' });
    });
  }
});

describe('removing a project', () => {
  test('removes it from the list only', async () => {
    const dir = h.makeProject(root, 'to-remove');
    const p = await addAndGet(dir);
    assert.deepEqual(await mina.api('/api/projects/remove', { id: p.id }), { ok: true });
    assert.equal(await project('to-remove'), undefined);
    assert.ok(fs.existsSync(dir));
  });
});

describe('robustness', () => {
  test('Mina is still healthy after the whole run', async () => {
    assert.ok(mina.alive());
    assert.equal((await mina.raw({ path: '/' })).status, 200);
    assert.ok(!/TypeError|ReferenceError|Unhandled/.test(mina.output), mina.output);
  });
});
