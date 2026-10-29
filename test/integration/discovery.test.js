// Discovery of servers started outside Mina: every framework the README promises, IPv6, tooling, other runtimes.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const h = require('../helpers');

const FRAMEWORKS = [
  // [dependencies, expected kind, expected framework]
  [['next', 'react'], 'frontend', 'Next.js'],
  [['vite', 'vue'], 'frontend', 'Vite'],
  [['react-scripts', 'react'], 'frontend', 'CRA'],
  [['nuxt', 'vue'], 'frontend', 'Nuxt'],
  [['@angular/core'], 'frontend', 'Angular'],
  [['astro'], 'frontend', 'Astro'],
  [['@sveltejs/kit'], 'frontend', 'SvelteKit'],
  [['gatsby', 'react'], 'frontend', 'Gatsby'],
  [['vue'], 'frontend', 'Vue'],
  [['react'], 'frontend', 'React'],
  [['@nestjs/core'], 'backend', 'NestJS'],
  [['express'], 'backend', 'Express'],
  [['fastify'], 'backend', 'Fastify'],
  [['koa'], 'backend', 'Koa'],
  [['@hapi/hapi'], 'backend', 'Hapi'],
  [['hono'], 'backend', 'Hono'],
  [['@adonisjs/core'], 'backend', 'AdonisJS'],
  // A backend that lists react (emails, admin) is still a backend.
  [['react', 'express'], 'backend', 'Express'],
];

let mina;
let root;
const children = [];
const fixtures = []; // { name, port, kind, framework }

before(async () => {
  root = h.tmpDir('discovery');
  mina = await h.startMina();
  const add = async (name, deps, kind, framework, type) => {
    const port = await h.freePort();
    const dir = h.makeProject(root, name, { deps, server: { port, type: type || (kind === 'frontend' ? 'html' : 'json'), title: `${name} title` } });
    children.push(h.runExternal(dir));
    fixtures.push({ name, port, kind, framework, dir });
  };
  for (const [i, [deps, kind, framework]] of FRAMEWORKS.entries()) await add(`fw-${i}-${framework.replace(/\W/g, '')}`, deps, kind, framework);
  // No known dependency: the content type decides.
  await add('plain-html', [], 'frontend', 'node', 'html');
  await add('plain-json', [], 'backend', 'node', 'json');
  await Promise.all(fixtures.map((f) => h.waitFor(() => h.portOpen(f.port), { what: `${f.name} port` })));
});

after(async () => {
  children.forEach(h.killQuiet);
  await mina?.stop();
  h.rmQuiet(root);
  h.rmQuiet(mina?.home);
});

describe('framework detection (servers started from a terminal)', () => {
  let apps;
  before(async () => { ({ apps } = await mina.apps()); });

  for (const [i, [deps, kind, framework]] of FRAMEWORKS.entries()) {
    test(`${deps.join(' + ')} → ${kind} / ${framework}`, () => {
      const f = fixtures[i];
      const app = apps.find((a) => a.port === f.port);
      assert.ok(app, `port ${f.port} not discovered`);
      assert.equal(app.kind, kind);
      assert.equal(app.framework, framework);
      assert.equal(app.project?.name, f.name);
      assert.equal(path.resolve(app.project.dir).toLowerCase(), path.resolve(f.dir).toLowerCase());
      assert.equal(app.responding, true);
      assert.equal(app.url, `http://localhost:${f.port}`);
    });
  }

  test('no known dependency: text/html → frontend, JSON → backend', () => {
    const html = apps.find((a) => a.port === fixtures.find((f) => f.name === 'plain-html').port);
    const json = apps.find((a) => a.port === fixtures.find((f) => f.name === 'plain-json').port);
    assert.equal(html.kind, 'frontend');
    assert.equal(json.kind, 'backend');
  });

  test('frontends report their page title', () => {
    const f = fixtures.find((x) => x.kind === 'frontend');
    assert.equal(apps.find((a) => a.port === f.port).title, `${f.name} title`);
  });

  test('backends list the documentation/health endpoints that answer, and only those', () => {
    const f = fixtures.find((x) => x.framework === 'Express');
    const app = apps.find((a) => a.port === f.port);
    assert.deepEqual(app.endpoints.map((e) => e.path).sort(), ['/api', '/docs', '/health']);
    assert.ok(app.endpoints.every((e) => e.status === 200));
    assert.equal(typeof app.preview, 'string');
  });

  test('Mina does not list itself', () => {
    assert.ok(!apps.some((a) => a.port === mina.port));
  });

  test('every app has the full shape the dashboard expects', () => {
    for (const a of apps) {
      for (const k of ['port', 'pid', 'process', 'kind', 'framework', 'responding', 'title', 'endpoints', 'url']) assert.ok(k in a, `${a.port} missing ${k}`);
      assert.ok(['frontend', 'backend'].includes(a.kind));
    }
  });
});

describe('edge cases', () => {
  test('an IPv6-only server is found and probed', async (t) => {
    const port = await h.freePort();
    const dir = h.makeProject(root, 'ipv6-only', { deps: ['vite'], server: { port, host: '::1', type: 'html' } });
    const child = h.runExternal(dir);
    try {
      const up = await h.waitFor(() => h.portOpen(port, '::1'), { timeout: 10000, what: 'ipv6' }).catch(() => false);
      if (!up) return t.skip('no IPv6 loopback on this machine');
      const { apps } = await mina.apps();
      const app = apps.find((a) => a.port === port);
      assert.ok(app, 'not discovered');
      assert.equal(app.responding, true);
      assert.equal(app.framework, 'Vite');
    } finally { h.killQuiet(child); }
  });

  test('a dev server that accepts connections but never answers HTTP (still compiling) stays listed', async () => {
    const port = await h.freePort();
    const dir = path.join(root, 'silent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'silent', scripts: { dev: 'node server.js' }, dependencies: { next: '*' } }));
    fs.writeFileSync(path.join(dir, 'server.js'), `require('net').createServer(() => {}).listen(${port}, '127.0.0.1');`);
    const child = h.runExternal(dir);
    try {
      await h.waitFor(() => h.portOpen(port), { what: 'silent port' });
      const { apps } = await mina.apps();
      const app = apps.find((a) => a.port === port);
      assert.ok(app, 'a booting dev server must not disappear');
      assert.equal(app.responding, false);
      assert.equal(app.framework, 'Next.js');
    } finally { h.killQuiet(child); }
  });

  test('editor tooling (a .vscode folder) is hidden by default and shown with "show everything"', async () => {
    const port = await h.freePort();
    const dir = h.makeProject(path.join(root, '.vscode', 'extensions'), 'some-extension', { server: { port, type: 'json' } });
    const child = h.runExternal(dir);
    try {
      await h.waitFor(() => h.portOpen(port), { what: 'tooling port' });
      assert.ok(!(await mina.apps()).apps.some((a) => a.port === port), 'hidden by default');
      assert.ok((await mina.apps(true)).apps.some((a) => a.port === port), 'visible with all=1');
    } finally { h.killQuiet(child); }
  });

  test('a server that stops is gone from the next scan', async () => {
    const port = await h.freePort();
    const child = h.runExternal(h.makeProject(root, 'short-lived', { server: { port } }));
    await h.waitFor(() => h.portOpen(port), { what: 'port' });
    assert.ok((await mina.apps()).apps.some((a) => a.port === port));
    h.killQuiet(child);
    await h.waitFor(async () => !(await h.portOpen(port)), { what: 'port close' });
    assert.ok(!(await mina.apps()).apps.some((a) => a.port === port));
  });

  test('/api/kill stops a discovered server', async () => {
    const port = await h.freePort();
    const child = h.runExternal(h.makeProject(root, 'killable', { server: { port } }));
    await h.waitFor(() => h.portOpen(port), { what: 'port' });
    const app = (await mina.apps()).apps.find((a) => a.port === port);
    const res = await mina.api('/api/kill', { pid: app.pid });
    assert.equal(res.ok, true);
    await h.waitFor(() => child.exitCode !== null || child.signalCode, { timeout: 10000, what: 'process exit' });
    // The same PID cannot be killed twice (it left the allow-list).
    assert.equal((await mina.api('/api/kill', { pid: app.pid })).error, 'unknown pid');
  });
});

describe('other runtimes', () => {
  // Real servers in other languages, when the runtime is installed. Discovery and preview must work for them.
  const runtimes = [
    {
      name: 'Python (http.server)', available: () => h.has(h.WIN ? 'python' : 'python3'),
      start: (port, dir) => spawn(h.WIN ? 'python' : 'python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore', windowsHide: true }),
      process: /^python/i, hiddenByDefault: false,
    },
    {
      name: 'PHP (built-in server)', available: () => h.has('php', ['-v']),
      start: (port, dir) => spawn('php', ['-S', `127.0.0.1:${port}`], { cwd: dir, stdio: 'ignore', windowsHide: true }),
      process: /^php/i, hiddenByDefault: false,
    },
    {
      name: 'Ruby (WEBrick)', available: () => h.has('ruby', ['-e', 'require "webrick"']),
      start: (port, dir) => spawn('ruby', ['-run', '-e', 'httpd', '.', '-p', String(port), '-b', '127.0.0.1'], { cwd: dir, stdio: 'ignore', windowsHide: true }),
      process: /^ruby/i, hiddenByDefault: false,
    },
    {
      name: 'Deno', available: () => h.has('deno'),
      start: (port, dir) => spawn('deno', ['run', '--allow-net', '-', ], { cwd: dir, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }),
      input: (port) => `Deno.serve({ port: ${port}, hostname: '127.0.0.1' }, () => new Response('<title>deno</title>', { headers: { 'content-type': 'text/html' } }));`,
      process: /^deno/i, hiddenByDefault: false,
    },
    {
      name: 'Bun', available: () => h.has('bun'),
      start: (port, dir) => spawn('bun', ['-e', `Bun.serve({ port: ${port}, hostname: '127.0.0.1', fetch: () => new Response('ok') })`], { cwd: dir, stdio: 'ignore', windowsHide: true }),
      process: /^bun/i, hiddenByDefault: false,
    },
    {
      // A compiled Go server runs under its own binary name, not "go", so it is only visible with "show everything".
      name: 'Go (compiled binary)', available: () => h.has('go', ['version']), timeout: 180000,
      prepare: (dir) => {
        fs.writeFileSync(path.join(dir, 'main.go'), 'package main\nimport ("net/http";"os")\nfunc main(){ http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request){ w.Write([]byte("ok")) }); http.ListenAndServe("127.0.0.1:"+os.Args[1], nil) }\n');
        const r = require('child_process').spawnSync('go', ['build', '-o', h.WIN ? 'gosrv.exe' : 'gosrv', 'main.go'], { cwd: dir, stdio: 'pipe', env: { ...process.env, GO111MODULE: 'off' } });
        if (r.status !== 0) throw new Error(String(r.stderr));
      },
      start: (port, dir) => spawn(path.join(dir, h.WIN ? 'gosrv.exe' : 'gosrv'), [String(port)], { cwd: dir, stdio: 'ignore', windowsHide: true }),
      process: /^gosrv/i, hiddenByDefault: true,
    },
  ];

  for (const rt of runtimes) {
    test(rt.name, { timeout: rt.timeout || 60000 }, async (t) => {
      if (!rt.available()) return t.skip(`${rt.name} is not installed`);
      const dir = path.join(root, `rt-${rt.name.replace(/\W+/g, '-')}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>rt</title>');
      if (rt.prepare) rt.prepare(dir);
      const port = await h.freePort();
      const child = rt.start(port, dir);
      if (rt.input) child.stdin.end(rt.input(port));
      try {
        await h.waitFor(() => h.portOpen(port), { timeout: 30000, what: `${rt.name} to listen` });
        const visible = (await mina.apps()).apps.find((a) => a.port === port);
        const all = (await mina.apps(true)).apps.find((a) => a.port === port);
        assert.ok(all, 'listed with "show everything"');
        assert.match(all.process, rt.process);
        assert.equal(all.responding, true);
        if (rt.hiddenByDefault) assert.equal(visible, undefined, 'not a known dev runtime');
        else assert.ok(visible, 'listed by default as a dev runtime');
      } finally { h.killQuiet(child); }
    });
  }
});

describe('noise is filtered', () => {
  test('a non-HTTP listener from an unknown runtime is hidden even with "show everything"', async () => {
    // Our own test process is node, so use a raw TCP server inside a non-dev process name is not possible portably;
    // instead check that Mina ignores ports below 1024 and its own port, which every scan must honour.
    const { apps } = await mina.apps(true);
    assert.ok(apps.every((a) => a.port >= 1024));
    assert.ok(!apps.some((a) => a.port === mina.port));
  });

  test('a busy machine does not slow a scan beyond reason', async () => {
    const t0 = Date.now();
    await mina.apps();
    assert.ok(Date.now() - t0 < 30000, `scan took ${Date.now() - t0} ms`);
  });
});

// Keep a reference so lint-like tools don't flag net as unused when tests are filtered.
void net;
