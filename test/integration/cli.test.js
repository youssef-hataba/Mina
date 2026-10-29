// The mina command: flags, port validation, single instance, startup entries.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const h = require('../helpers');

const pkg = require('../../package.json');
const home = h.tmpDir('cli-home');
after(() => h.rmQuiet(home));

// Runs the CLI to completion. Never lets it fall back to the real default port 4747.
function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [h.CLI, ...args], { env: h.isolatedEnv(home, env), encoding: 'utf8', timeout: 20000, windowsHide: true });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), timedOut: r.error?.code === 'ETIMEDOUT' };
}

describe('information', () => {
  test('--help and -h print usage', () => {
    for (const flag of ['--help', '-h']) {
      const r = cli([flag]);
      assert.equal(r.code, 0);
      assert.match(r.out, /Usage:/);
      assert.match(r.out, /install-startup/);
    }
  });

  test('--version and -v print the package version', () => {
    for (const flag of ['--version', '-v']) {
      const r = cli([flag]);
      assert.equal(r.code, 0);
      assert.equal(r.out.trim(), pkg.version);
    }
  });

  test('an unknown command fails with help', () => {
    const r = cli(['frobnicate']);
    assert.equal(r.code, 1);
    assert.match(r.out, /Unknown command: frobnicate/);
    assert.match(r.out, /Usage:/);
  });
});

describe('port validation', () => {
  const bad = [['--port', 'abc'], ['--port', '0'], ['--port', '70000'], ['--port', '-5'], ['--port=abc'], ['--port', '12.5'], ['--port']];
  for (const args of bad) {
    test(`refuses ${args.join(' ')}`, () => {
      const r = cli([...args, '--no-open']);
      assert.equal(r.code, 1, r.out);
      assert.ok(!r.timedOut, 'must exit, not start a server');
      assert.match(r.out, /port/i);
      assert.ok(!/at .*\.js:\d+/.test(r.out), 'a clear message, not a stack trace');
    });
  }

  test('refuses an invalid MINA_PORT', () => {
    const r = cli(['--no-open'], { MINA_PORT: 'nope' });
    assert.equal(r.code, 1);
    assert.match(r.out, /Invalid port/);
  });
});

describe('running', () => {
  const run = (args, env = {}) => {
    const proc = spawn(process.execPath, [h.CLI, ...args], { env: h.isolatedEnv(home, env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    return { proc, get out() { return out; } };
  };

  test('--port=N and MINA_PORT both choose the port', async () => {
    for (const [args, env] of [[['--port=' + (await h.freePort())], {}], [[], { MINA_PORT: String(await h.freePort()) }]]) {
      const port = Number(args[0]?.split('=')[1] || env.MINA_PORT);
      const m = run([...args, '--no-open'], env);
      try {
        await h.waitFor(() => m.out.includes(`Mina running on http://localhost:${port}`), { timeout: 15000, what: m.out || 'start' });
        assert.ok(await h.portOpen(port));
      } finally { m.proc.kill(); }
    }
  });

  test('a second "mina" on the same port opens the running one instead of failing', async () => {
    const port = await h.freePort();
    const first = run(['--port', String(port), '--no-open']);
    try {
      await h.waitFor(() => first.out.includes('Mina running'), { timeout: 15000, what: 'first Mina' });
      const second = cli(['--port', String(port), '--no-open']);
      assert.equal(second.code, 0);
      assert.match(second.out, /already running/);
      assert.equal(first.proc.exitCode, null, 'the first one keeps running');
    } finally { first.proc.kill(); }
  });

  test('a port held by something else gives a clear error', async () => {
    const port = await h.freePort();
    // A separate process: spawnSync blocks this one, so a server in here could never answer.
    const squatter = spawn(process.execPath, ['-e', `require('http').createServer((q, r) => r.end('not mina')).listen(${port}, '127.0.0.1')`], { stdio: 'ignore' });
    try {
      await h.waitFor(() => h.portOpen(port), { what: 'squatter' });
      const r = cli(['--port', String(port), '--no-open']);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /already in use/);
    } finally { h.killQuiet(squatter); }
  });

  test('a port held by a server that never answers does not hang the CLI', async () => {
    const port = await h.freePort();
    // Accepts the connection, sends headers, never finishes the body.
    const silent = spawn(process.execPath, ['-e', `require('http').createServer((q, r) => { r.writeHead(200); r.write('x'); }).listen(${port}, '127.0.0.1')`], { stdio: 'ignore' });
    try {
      await h.waitFor(() => h.portOpen(port), { what: 'silent server' });
      const t0 = Date.now();
      const r = cli(['--port', String(port), '--no-open']);
      assert.ok(!r.timedOut, 'the CLI must finish');
      assert.ok(Date.now() - t0 < 15000);
      assert.equal(r.code, 1);
    } finally { h.killQuiet(silent); }
  });
});

describe('startup entry', () => {
  // Point the OS-specific startup folder into the temp home so nothing real is touched.
  const startupEnv = () => {
    const base = path.join(home, 'مستخدم عربي'); // non-ASCII on purpose: the Windows .vbs encoding bug
    return { env: { APPDATA: base, XDG_CONFIG_HOME: path.join(base, '.config') }, base };
  };
  const entryPath = (base) => (h.WIN
    ? path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'mina.vbs')
    : path.join(base, '.config', 'autostart', 'mina.desktop'));

  test('install, then uninstall, with --port before the command', (t) => {
    if (process.platform === 'darwin') return t.skip('macOS uses launchctl; covered by manual testing');
    const { env, base } = startupEnv();
    const r = cli(['--port', '4811', 'install-startup'], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /will start when you log in/);
    const file = entryPath(base);
    assert.ok(fs.existsSync(file), file);
    const raw = fs.readFileSync(file);
    const text = h.WIN ? raw.toString('utf16le').replace(/^﻿/, '') : raw.toString('utf8');
    if (h.WIN) assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 LE BOM so WSH reads non-ASCII paths');
    assert.ok(text.includes('--no-open'));
    assert.ok(text.includes('4811'), 'the chosen port is kept');
    assert.ok(text.includes(h.WIN ? process.execPath : process.execPath.replace(/\\/g, '\\\\')));

    const u = cli(['uninstall-startup'], env);
    assert.equal(u.code, 0);
    assert.match(u.out, /Removed/);
    assert.equal(fs.existsSync(file), false);
    assert.match(cli(['uninstall-startup'], env).out, /not set to start/);
  });

  test('MINA_PORT is written into the startup entry too', (t) => {
    if (process.platform === 'darwin') return t.skip('macOS uses launchctl');
    const { env, base } = startupEnv();
    cli(['install-startup'], { ...env, MINA_PORT: '4822' });
    const raw = fs.readFileSync(entryPath(base));
    const text = h.WIN ? raw.toString('utf16le') : raw.toString('utf8');
    assert.ok(text.includes('4822'));
    cli(['uninstall-startup'], env);
  });

  test('Linux: a "%" in the path is escaped for the desktop entry', (t) => {
    if (h.WIN || process.platform === 'darwin') return t.skip('Linux only');
    const { env, base } = startupEnv();
    cli(['install-startup'], env);
    const exec = fs.readFileSync(entryPath(base), 'utf8').match(/^Exec=(.*)$/m)[1];
    assert.ok(!/(^|[^%])%[^%]/.test(exec), `unescaped % in: ${exec}`);
    cli(['uninstall-startup'], env);
  });
});
