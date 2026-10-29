// The API must be unusable for anything but the dashboard page itself. Every layer is attacked on a live server.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const h = require('../helpers');

let mina;
before(async () => { mina = await h.startMina(); });
after(async () => { await mina?.stop(); h.rmQuiet(mina?.home); });

const post = (path, body, headers = {}) => mina.raw({ method: 'POST', path, body, headers: { 'Content-Type': 'application/json', 'X-Token': mina.token, ...headers } });

describe('dashboard page', () => {
  test('serves the page with a fresh 48-hex-char token and anti-framing headers', async () => {
    const res = await mina.raw({ path: '/' });
    assert.equal(res.status, 200);
    assert.match(mina.token, /^[0-9a-f]{48}$/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(!res.text.includes('__TOKEN__'));
  });

  test('the token changes on every start', async () => {
    const other = await h.startMina();
    try { assert.notEqual(other.token, mina.token); }
    finally { await other.stop(); h.rmQuiet(other.home); }
  });

  test('both localhost and 127.0.0.1 are accepted as Host', async () => {
    for (const host of [`localhost:${mina.port}`, `127.0.0.1:${mina.port}`]) {
      const res = await h.request(mina.port, { headers: { Host: host } });
      assert.equal(res.status, 200, host);
    }
  });
});

describe('Host header (DNS rebinding)', () => {
  const bad = (port) => ['evil.com', `evil.com:${port}`, `localhost`, `localhost:1`, `127.0.0.1`, `0.0.0.0:${port}`, `[::1]:${port}`, `LOCALHOST:${port}x`, `localhost.evil.com:${port}`];
  test('any other Host is refused, for the page and the API', async () => {
    for (const host of bad(mina.port)) {
      for (const p of ['/', '/api/apps', '/style.css']) {
        const res = await h.request(mina.port, { path: p, headers: { Host: host, 'X-Token': mina.token } });
        assert.equal(res.status, 403, `${host} ${p}`);
        assert.ok(!res.text.includes(mina.token), 'token must not leak');
      }
    }
  });

  test('a request with no Host header at all (HTTP/1.0) is refused', async () => {
    const net = require('net');
    const text = await new Promise((resolve) => {
      const sock = net.connect(mina.port, '127.0.0.1', () => sock.end('GET / HTTP/1.0\r\n\r\n'));
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('end', () => resolve(buf));
      sock.on('error', () => resolve(buf));
    });
    assert.match(text, /^HTTP\/1\.[01] (403|400)/);
    assert.ok(!text.includes(mina.token));
  });
});

describe('token', () => {
  test('missing, wrong, wrong-length and case-changed tokens are refused', async () => {
    const tokens = [undefined, '', 'x', mina.token.slice(0, -1), mina.token + 'a', mina.token.toUpperCase(), 'ä'.repeat(48), mina.token.slice(0, 24)];
    for (const t of tokens) {
      const headers = t === undefined ? {} : { 'X-Token': t };
      const get = await mina.raw({ path: '/api/apps', headers });
      assert.equal(get.status, 403, `GET token=${JSON.stringify(t)}`);
      const p = await mina.raw({ method: 'POST', path: '/api/projects/add', body: { dirs: [] }, headers: { ...headers, 'Content-Type': 'application/json' } });
      assert.equal(p.status, 403, `POST token=${JSON.stringify(t)}`);
    }
  });

  test('the token is not accepted from the query string or a cookie', async () => {
    assert.equal((await mina.raw({ path: `/api/apps?token=${mina.token}` })).status, 403);
    assert.equal((await mina.raw({ path: '/api/apps', headers: { Cookie: `token=${mina.token}` } })).status, 403);
  });
});

describe('Origin', () => {
  test('cross-site origins are refused even with a valid token', async () => {
    for (const origin of ['https://evil.com', `http://localhost:${mina.port + 1}`, `https://localhost:${mina.port}`, 'null', `http://127.0.0.1:${mina.port}.evil.com`]) {
      const res = await post('/api/projects/add', { dirs: [] }, { Origin: origin });
      assert.equal(res.status, 403, origin);
    }
  });

  test('the dashboard origin itself is accepted', async () => {
    for (const origin of [`http://localhost:${mina.port}`, `http://127.0.0.1:${mina.port}`]) {
      const res = await post('/api/projects/add', { dirs: [] }, { Origin: origin });
      assert.equal(res.status, 200, origin);
    }
  });

  test('a CORS preflight is never approved', async () => {
    const res = await mina.raw({ method: 'OPTIONS', path: '/api/projects/add', headers: { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-token' } });
    assert.notEqual(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});

describe('request shape', () => {
  test('POST routes need application/json (blocks plain HTML forms)', async () => {
    for (const ct of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await mina.raw({ method: 'POST', path: '/api/projects/add', body: '{"dirs":[]}', headers: { 'X-Token': mina.token, ...(ct ? { 'Content-Type': ct } : {}) } });
      assert.equal(res.status, 415, String(ct));
    }
  });

  test('mutating routes do not answer GET', async () => {
    for (const p of ['/api/kill', '/api/projects/start', '/api/projects/stop', '/api/groups/start', '/api/open', '/api/projects/add']) {
      const res = await mina.raw({ path: p, headers: { 'X-Token': mina.token } });
      assert.equal(res.status, 404, p);
    }
  });

  test('broken or odd JSON bodies are answered without crashing the server', async () => {
    const bodies = ['', '{', 'null', '[]', '"str"', '42', 'true', '{"id":{"$ne":1}}', '{"dirs":"C:\\\\"}', '{"dirs":[1,null,{}]}', '{"group":["a"]}', '{"pid":"abc"}', '{"__proto__":{"x":1}}'];
    const routes = ['/api/kill', '/api/open', '/api/projects/scan', '/api/projects/add', '/api/projects/start', '/api/projects/stop',
      '/api/projects/remove', '/api/projects/set-group', '/api/projects/logs/stream', '/api/groups/start', '/api/groups/stop', '/api/groups/rename', '/api/groups/remove', '/api/nope'];
    for (const route of routes) {
      for (const body of bodies) {
        const res = await mina.raw({ method: 'POST', path: route, body, headers: { 'X-Token': mina.token, 'Content-Type': 'application/json' }, timeout: 15000 });
        assert.ok(res.status < 500, `${route} ${body} -> ${res.status} ${res.text}`);
      }
    }
    assert.ok(mina.alive(), 'server still running');
    assert.equal((await mina.raw({ path: '/' })).status, 200);
  });

  test('an oversized body does not break the server', async () => {
    const res = await post('/api/projects/scan', { dir: 'x'.repeat(200000) });
    assert.ok(res.status < 500);
    assert.ok(mina.alive());
  });

  test('unknown API paths are 404', async () => {
    assert.equal((await mina.raw({ path: '/api/nope', headers: { 'X-Token': mina.token } })).status, 404);
  });
});

describe('dangerous actions are limited to what Mina knows', () => {
  test('/api/kill refuses PIDs that are not dev servers from the latest scan', async () => {
    const victim = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      for (const pid of [victim.pid, process.pid, mina.proc.pid, 0, -1, 4, 1]) {
        const res = await post('/api/kill', { pid });
        assert.equal(res.status, 403, `pid ${pid}`);
      }
      assert.ok(h.isAlive(victim.pid), 'victim survived');
    } finally { h.killQuiet(victim); }
  });

  test('/api/open refuses folders that are not saved projects or running apps', async () => {
    for (const dir of [os.homedir(), h.ROOT, 'C:\\Windows', '/etc', '', '..', '\\\\server\\share']) {
      const res = await post('/api/open', { dir, ide: 'explorer' });
      assert.equal(res.status, 403, dir);
    }
  });

  test('project routes refuse unknown ids', async () => {
    for (const route of ['/api/projects/start', '/api/projects/stop', '/api/projects/remove', '/api/projects/logs/stream']) {
      const res = await post(route, { id: '../../etc' });
      assert.equal(res.status, 404, route);
    }
  });

  test('group routes refuse unknown groups', async () => {
    for (const route of ['/api/groups/start', '/api/groups/stop', '/api/groups/rename', '/api/groups/remove']) {
      assert.equal((await post(route, { group: 'nope', name: 'x' })).status, 404, route);
    }
  });
});

describe('static files', () => {
  test('serves files from public/ with the right type', async () => {
    const css = await mina.raw({ path: '/style.css' });
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    const js = await mina.raw({ path: '/js/core.js' });
    assert.equal(js.status, 200);
    const png = await mina.raw({ path: '/img/mina_Icon.png' });
    assert.equal(png.status, 200);
    assert.equal(png.headers['content-type'], 'image/png');
  });

  test('path traversal and malformed paths never escape public/ or crash', async () => {
    const paths = ['/../server.js', '/..%2fserver.js', '/..%2F..%2Fpackage.json', '/%2e%2e/server.js', '/js/..%5c..%5cserver.js',
      '/js/%2e%2e%2f%2e%2e%2fprojects.js', '/....//server.js', '/%c0%ae%c0%ae/server.js', '/%E0%A4%A.js', '/%.css', '/%00.js',
      '/js/core.js%00.png', '/C:%5cWindows%5cwin.ini.css', `/${'..%2f'.repeat(20)}etc/passwd.css`, '/does-not-exist.css'];
    for (const p of paths) {
      const res = await mina.raw({ path: p });
      assert.ok([400, 403, 404].includes(res.status), `${p} -> ${res.status}`);
      assert.ok(!res.text.includes('require('), `${p} leaked source`);
    }
    assert.ok(mina.alive(), 'server still running');
  });

  test('other methods and paths are 404', async () => {
    assert.equal((await mina.raw({ method: 'POST', path: '/' })).status, 404);
    assert.equal((await mina.raw({ path: '/index.html' })).status, 404);
    assert.equal((await mina.raw({ path: '/server.js' })).status, 404);
    assert.equal((await mina.raw({ path: '/package.json' })).status, 404);
  });
});

describe('network exposure', () => {
  test('only listens on loopback', async (t) => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!lan) return t.skip('no LAN interface');
    assert.equal(await h.portOpen(mina.port, lan.address), false);
  });
});
