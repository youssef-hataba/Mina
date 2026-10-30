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
    const dirs = Array.from({ length: 120 }, (_, i) => h.makeProject(path.join(root, 'many'), `p${String(i).padStart(2, '0')}-${'x'.repeat(100)}`));
    assert.ok(JSON.stringify({ dirs }).length > 10000, 'bigger than the old 10 KB limit');
    assert.deepEqual(await mina.api('/api/projects/add', { dirs }), { ok: true });
    const saved = (await mina.apps()).projects.filter((p) => p.dir.includes(`${path.sep}many${path.sep}`));
    assert.equal(saved.length, 120);
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

// ---- Found by running Mina on real projects (Planto: NestJS + Next.js + Vite, a Go API, editor extensions). ----

// A one-file server: { port, host, ipv6Only, title, silentPort } -> listens and serves a page with that title.
function serverScript(o) {
  return `
    const http = require('http');
    // Requests counted per User-Agent: several Minas (one per test file) may probe the same server.
    const seen = {};
    const s = http.createServer((q, r) => {
      const by = (seen[q.headers['user-agent'] || ''] ||= {});
      by[q.url] = (by[q.url] || 0) + 1;
      if (q.url === '/__seen') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(seen)); }
      r.writeHead(200, { 'Content-Type': 'text/html' }); r.end('<title>${o.title}</title>');
    });
    s.listen({ port: ${o.port}, host: ${JSON.stringify(o.host)}, ipv6Only: ${!!o.ipv6Only} });
    ${o.silentPort ? `require('net').createServer(() => {}).listen(${o.silentPort}, '127.0.0.1');` : ''}
  `;
}

const ipv6 = () => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).listen({ port: 0, host: '::1' }, () => s.close(() => resolve(true)));
});

describe('two processes on one port (IPv4 and IPv6)', () => {
  test('an editor extension on 127.0.0.1:P does not hide the project server on [::]:P, nor answer for it', async (t) => {
    if (!(await ipv6())) return t.skip('no IPv6 loopback');
    const port = await h.freePort();
    // The editor's preview server: tooling (lives under .vscode), bound to IPv4 only.
    const tooling = path.join(root, '.vscode', 'extensions', 'preview');
    fs.mkdirSync(tooling, { recursive: true });
    fs.writeFileSync(path.join(tooling, 'serve.js'), serverScript({ port, host: '127.0.0.1', title: 'crossnote' }));
    children.push(spawn(process.execPath, [path.join(tooling, 'serve.js')], { stdio: 'ignore' }));
    await h.waitFor(() => h.portOpen(port, '127.0.0.1'), { what: 'tooling server' });
    // The user's app on the same port number, IPv6.
    const app = h.makeProject(root, 'shared-port-app', { deps: ['next'] });
    fs.writeFileSync(path.join(app, 'server.js'), serverScript({ port, host: '::', ipv6Only: true, title: 'The real app' }));
    children.push(h.runExternal(app));
    await h.waitFor(() => h.portOpen(port, '::1'), { what: 'app server' });

    const found = (await mina.apps()).apps.filter((a) => a.port === port);
    assert.equal(found.length, 1, 'listed once');
    assert.equal(found[0].project?.name, 'shared-port-app');
    assert.equal(found[0].title, 'The real app', 'probed on its own address, not the extension\'s');
  });
});

describe('a server with an internal second port', () => {
  test('is listed once, under the port that answers, and its silent port does not slow the scan', async (t) => {
    const port = await h.freePort();
    const internal = await h.freePort();
    const app = h.makeProject(root, 'two-ports', { deps: ['next'] });
    // Public on all interfaces (like Next.js on [::]), plus a silent internal port on 127.0.0.1.
    const host = (await ipv6()) ? '::' : '0.0.0.0';
    fs.writeFileSync(path.join(app, 'server.js'), serverScript({ port, host, title: 'Two ports', silentPort: internal }));
    children.push(h.runExternal(app));
    await h.waitFor(async () => (await h.portOpen(port)) && h.portOpen(internal), { what: 'both ports' });
    const t0 = Date.now();
    const { apps } = await mina.apps();
    const took = Date.now() - t0;
    assert.ok(apps.some((a) => a.port === port && a.project?.name === 'two-ports'));
    assert.ok(!apps.some((a) => a.port === internal), 'the internal port is not a second app');
    assert.ok(took < 7500, `scan took ${took} ms: the silent port was waited on`);
    void t;
  });
});

describe('probes stay out of the user\'s logs', () => {
  test('a backend\'s documentation paths are probed once per process, not on every refresh', async () => {
    const port = await h.freePort();
    // Every test file runs its own Mina, and each one scans the whole machine. Inside a .vscode folder the
    // server is tooling to them (hidden by default), so only this file's Mina, asking for everything, probes it.
    const app = h.makeProject(path.join(root, '.vscode', 'probe-count'), 'quiet-backend', { deps: ['express'] });
    fs.writeFileSync(path.join(app, 'server.js'), serverScript({ port, host: '127.0.0.1', title: 'api' }).replace("'text/html'", "'application/json'"));
    children.push(h.runExternal(app));
    await h.waitFor(() => h.portOpen(port), { what: 'backend' });
    for (let i = 0; i < 3; i++) await mina.apps(true);
    const agent = `Mina/${require('../../package.json').version} (localhost:${mina.port})`;
    const all = JSON.parse((await h.request(port, { path: '/__seen' })).text);
    assert.ok(all[agent], `no probe carried "${agent}"; agents seen: ${Object.keys(all).join(' | ')}`);
    const seen = all[agent];
    assert.equal(seen['/docs'], 1, `GET /docs ${seen['/docs']} times`);
    assert.ok((seen['/'] || 0) <= 1, `GET / ${seen['/']} times in 3 refreshes`);
  });
});

// ---- Live updates between tabs ----

// Opens GET /api/events like a dashboard tab and collects the messages.
function listen(m, token = m.token) {
  const messages = [];
  let resolveStatus;
  const status = new Promise((r) => { resolveStatus = r; });
  const req = require('http').get({ host: '127.0.0.1', port: m.port, path: '/api/events', headers: { Host: m.host, 'X-Token': token } }, (res) => {
    resolveStatus(res.statusCode);
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        try { messages.push(JSON.parse(buf.slice(0, nl))); } catch { messages.push({ raw: buf.slice(0, nl) }); }
        buf = buf.slice(nl + 1);
      }
    });
  });
  req.on('error', () => {});
  return { messages, status, close: () => req.destroy() };
}

describe('live updates between tabs', () => {
  test('a tab is told at once when another tab adds, starts and stops a project', { timeout: 90000 }, async () => {
    const tab = listen(mina);
    assert.equal(await tab.status, 200);
    await h.waitFor(() => tab.messages.some((x) => x.type === 'hello'), { what: 'hello' });
    const changes = () => tab.messages.filter((x) => x.type === 'change').length;

    const port = await h.freePort();
    const dir = h.makeProject(root, 'live-update', { server: { port } });
    let before = changes();
    await mina.api('/api/projects/add', { dirs: [dir] });
    await h.waitFor(() => changes() > before, { timeout: 3000, what: 'change after add' });

    const p = await project('live-update');
    before = changes();
    await mina.api('/api/projects/start', { id: p.id });
    await h.waitFor(() => changes() > before, { timeout: 3000, what: 'change after start' });
    await h.waitFor(() => h.portOpen(port), { timeout: 30000, what: 'server' });

    before = changes();
    await mina.api('/api/projects/stop', { id: p.id });
    await h.waitFor(() => changes() > before, { timeout: 3000, what: 'change after stop' });
    tab.close();
  });

  test('reading a page does not count as a change; a refused action does not either', async () => {
    const tab = listen(mina);
    await h.waitFor(() => tab.messages.some((x) => x.type === 'hello'), { what: 'hello' });
    await mina.apps();
    await mina.api('/api/projects/start', { id: 'nope' });
    await h.sleep(600);
    assert.equal(tab.messages.filter((x) => x.type === 'change').length, 0);
    tab.close();
  });

  test('the event stream needs the token like every other API route', async () => {
    const stranger = listen(mina, 'wrong');
    assert.equal(await stranger.status, 403);
    stranger.close();
  });
});

describe('a refresh never returns a result from before it was asked', () => {
  test('a server that comes up while a scan is running is in the next answer', { timeout: 90000 }, async () => {
    // A dev server that accepts connections but never answers makes every scan wait out its probe.
    const silentPort = await h.freePort();
    const silent = h.makeProject(root, 'slow-to-probe', { deps: ['next'] });
    fs.writeFileSync(path.join(silent, 'server.js'), `require('net').createServer(() => {}).listen(${silentPort}, '127.0.0.1');`);
    children.push(h.runExternal(silent));
    await h.waitFor(() => h.portOpen(silentPort), { what: 'silent server' });

    const port = await h.freePort();
    const dir = h.makeProject(root, 'late-comer', { server: { port } });
    const slowScan = mina.apps(); // started before the new server exists
    await h.sleep(300);
    children.push(h.runExternal(dir));
    await h.waitFor(() => h.portOpen(port), { what: 'late server' });
    const fresh = await mina.apps(); // asked after it came up, while the slow scan may still be running
    await slowScan;
    assert.ok(fresh.apps.some((a) => a.port === port), 'the answer includes the server that came up before the request');
  });
});
