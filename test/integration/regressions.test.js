// Server-level regressions from the review: hangs, body decoding, attribution, duplicates, cancellation.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const h = require('../helpers');

let mina;
let root;
const children = [];

before(async () => {
  root = h.tmpDir('reg');
  mina = await h.startMina();
});
after(async () => {
  await h.stopAllProjects(mina);
  children.forEach(h.killQuiet);
  await mina?.stop();
  h.rmQuiet(root);
  h.rmQuiet(mina?.home);
});

const project = async (name) => (await mina.apps()).projects.find((p) => p.name === name);

describe('a scan never hangs on a misbehaving local server', () => {
  test('an endpoint that streams forever (SSE) or stalls after headers does not freeze /api/apps', { timeout: 90000 }, async () => {
    const port = await h.freePort();
    const dir = path.join(root, 'sse-backend');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sse-backend', scripts: { dev: 'node server.js' }, dependencies: { express: '*' } }));
    // "/" answers JSON; every documentation path either streams events forever or sends headers and stalls.
    fs.writeFileSync(path.join(dir, 'server.js'), `
      require('http').createServer((req, res) => {
        if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
        if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        setInterval(() => res.write('data: ping\\n\\n'), 200);
      }).listen(${port}, '127.0.0.1');`);
    children.push(h.runExternal(dir));
    await h.waitFor(() => h.portOpen(port), { what: 'sse port' });
    const t0 = Date.now();
    const { apps } = await mina.apps();
    const took = Date.now() - t0;
    const app = apps.find((a) => a.port === port);
    assert.ok(app, 'discovered');
    assert.ok(took < 30000, `scan took ${took} ms`);
    // Streaming endpoints did answer with 200 headers, so they count as live endpoints.
    assert.ok(app.endpoints.some((e) => e.path === '/api'));
  });
});

describe('request bodies', () => {
  test('a non-ASCII path split across TCP chunks arrives intact', async () => {
    const dir = h.makeProject(path.join(root, 'عربي'), 'مشروع-تجريبي');
    const body = Buffer.from(JSON.stringify({ dir }), 'utf8');
    // Split inside a multi-byte character.
    const cut = body.indexOf(Buffer.from('عربي', 'utf8')) + 1;
    const text = await new Promise((resolve, reject) => {
      const sock = net.connect(mina.port, '127.0.0.1', async () => {
        // HTTP/1.0 so the answer comes back unchunked and is easy to read here.
        sock.write(`POST /api/projects/scan HTTP/1.0\r\nHost: ${mina.host}\r\nX-Token: ${mina.token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
        sock.write(body.subarray(0, cut));
        await h.sleep(150);
        sock.end(body.subarray(cut));
      });
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (d) => { buf += d; });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
    });
    const json = JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4));
    assert.equal(json.candidates.length, 1);
    assert.equal(json.candidates[0].name, 'مشروع-تجريبي');
  });

  test('a body over 1 MB is refused with 413 instead of silently becoming {}', async () => {
    const res = await mina.raw({ method: 'POST', path: '/api/projects/add', body: JSON.stringify({ dirs: ['x'.repeat(1100000)] }),
      headers: { 'X-Token': mina.token, 'Content-Type': 'application/json' } });
    assert.equal(res.status, 413);
  });

  test('adding many folders at once in one request works', async () => {
    const dirs = Array.from({ length: 60 }, (_, i) => h.makeProject(path.join(root, 'many'), `p${String(i).padStart(2, '0')}-${'x'.repeat(100)}`));
    assert.ok(JSON.stringify({ dirs }).length > 10000, 'bigger than the old 10 KB limit');
    assert.deepEqual(await mina.api('/api/projects/add', { dirs }), { ok: true });
    const saved = (await mina.apps()).projects.filter((p) => p.dir.includes(`${path.sep}many${path.sep}`));
    assert.equal(saved.length, 60);
    for (const p of saved) await mina.api('/api/projects/remove', { id: p.id });
  });
});

describe('attribution', () => {
  test('a server started from a path with spaces is linked to its project', async () => {
    const port = await h.freePort();
    const dir = h.makeProject(path.join(root, 'John Smith', 'my projects'), 'spaced-api', { deps: ['express'], server: { port, type: 'json' } });
    // Quoted absolute script path, the way Windows shows it in the command line.
    children.push(spawn(process.execPath, [path.join(dir, 'server.js')], { cwd: root, stdio: 'ignore', windowsHide: true }));
    await h.waitFor(() => h.portOpen(port), { what: 'spaced port' });
    const app = (await mina.apps()).apps.find((a) => a.port === port);
    assert.ok(app);
    assert.equal(app.project?.name, 'spaced-api');
    assert.equal(app.framework, 'Express');
  });

  test('a hoisted monorepo binary (root/node_modules/...) launched by Mina belongs to the sub-project', { timeout: 90000 }, async () => {
    const repo = path.join(root, 'monorepo');
    const port = await h.freePort();
    // The "framework binary" lives in the repo root's node_modules, the app in apps/web.
    const bin = path.join(repo, 'node_modules', 'fake-next', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'monorepo-root', private: true, workspaces: ['apps/*'] }));
    fs.writeFileSync(path.join(bin, 'next.js'), `require('http').createServer((q, r) => { r.writeHead(200, {'Content-Type': 'text/html'}); r.end('<title>web</title>'); }).listen(${port}, '127.0.0.1');`);
    const web = h.makeProject(path.join(repo, 'apps'), 'web', { deps: ['next'], scripts: { dev: `node ${JSON.stringify(path.join(bin, 'next.js'))}` } });
    await mina.api('/api/projects/add', { dirs: [web] });
    const p = await project('web');
    await mina.api('/api/projects/start', { id: p.id });
    const running = await h.waitFor(async () => { const x = await project('web'); return x?.state === 'running' && x; }, { timeout: 60000, interval: 1000, what: 'web running' });
    assert.equal(running.port, port);
    const app = (await mina.apps()).apps.find((a) => a.port === port);
    assert.equal(path.resolve(app.project.dir).toLowerCase(), path.resolve(web).toLowerCase());
    await mina.api('/api/projects/stop', { id: p.id });
    await h.waitFor(async () => !(await h.portOpen(port)), { timeout: 15000, what: 'port close' });
  });
});

describe('no duplicates, real cancellation', () => {
  test('two quick start clicks launch one copy', { timeout: 90000 }, async () => {
    const port = await h.freePort();
    const dir = h.makeProject(root, 'double-click', { server: { port, delay: 4000, marker: path.join(root, 'double-click.up') } });
    await mina.api('/api/projects/add', { dirs: [dir] });
    const p = await project('double-click');
    const [a, b] = await Promise.all([mina.api('/api/projects/start', { id: p.id }), mina.api('/api/projects/start', { id: p.id })]);
    const results = [a, b].map((r) => JSON.stringify(r)).sort();
    assert.deepEqual(results, ['{"alreadyStarting":true}', '{"ok":true}']);
    // A third click while it boots is refused as well.
    assert.deepEqual(await mina.api('/api/projects/start', { id: p.id }), { alreadyStarting: true });
    await h.waitFor(() => h.portOpen(port), { timeout: 30000, what: 'port' });
    await h.sleep(1500);
    assert.equal(fs.readFileSync(path.join(root, 'double-click.up'), 'utf8').trim().split('\n').length, 1, 'only one server came up');
    await mina.api('/api/projects/stop', { id: p.id });
    await h.waitFor(async () => !(await h.portOpen(port)), { timeout: 15000, what: 'port close' });
  });

  test('cancelling one queued project in a group keeps it from starting', { timeout: 90000 }, async () => {
    const ws = path.join(root, 'cancel-one');
    const apiPort = await h.freePort();
    const webPort = await h.freePort();
    h.makeProject(ws, 'api', { deps: ['express'], server: { port: apiPort, type: 'json', delay: 10000 } });
    h.makeProject(ws, 'web', { deps: ['vite'], server: { port: webPort, marker: path.join(ws, 'web.up') } });
    await mina.api('/api/projects/add', { dirs: [path.join(ws, 'api'), path.join(ws, 'web')] });
    await mina.api('/api/groups/start', { group: 'cancel-one' });
    await h.sleep(800);
    const web = (await mina.apps()).projects.find((x) => x.dir === path.resolve(path.join(ws, 'web')));
    assert.equal(web.state, 'queued');
    await mina.api('/api/projects/stop', { id: web.id });
    await h.waitFor(() => h.portOpen(apiPort), { timeout: 30000, what: 'api up' });
    await h.sleep(5000);
    assert.equal(fs.existsSync(path.join(ws, 'web.up')), false, 'the cancelled frontend never started');
    await mina.api('/api/groups/stop', { group: 'cancel-one' });
    await h.waitFor(async () => !(await h.portOpen(apiPort)), { timeout: 15000, what: 'api close' });
  });

  test('stop pressed while the launch is still in flight stops it once it has a PID', { timeout: 90000 }, async () => {
    const port = await h.freePort();
    const dir = h.makeProject(root, 'in-flight', { server: { port, delay: 2000 } });
    await mina.api('/api/projects/add', { dirs: [dir] });
    const p = await project('in-flight');
    const starting = mina.api('/api/projects/start', { id: p.id });
    await h.sleep(50);
    await mina.api('/api/projects/stop', { id: p.id });
    await starting;
    await h.sleep(5000);
    assert.equal(await h.portOpen(port), false, 'nothing is listening');
    const after = await project('in-flight');
    assert.ok(['stopped', 'crashed'].includes(after.state), after.state);
  });
});
