// platform.js against the real OS: listing listeners, launching in the background, killing whole trees.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const platform = require('../../platform');
const h = require('../helpers');

const root = h.tmpDir('platform');
after(() => h.rmQuiet(root));

const listenOn = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const s = http.createServer((q, r) => r.end('ok')).listen(port, host, () => resolve(s));
});

describe('isAlive()', () => {
  test('true for this process, false for a dead PID', async () => {
    assert.equal(platform.isAlive(process.pid), true);
    const child = require('child_process').spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => child.on('exit', r));
    await h.sleep(200);
    assert.equal(platform.isAlive(child.pid), false);
  });
});

describe('listListeners()', () => {
  test('finds an IPv4 listener with its PID, process name and command line', async () => {
    const port = await h.freePort();
    const child = h.runExternal(h.makeProject(root, 'lister', { server: { port } }));
    try {
      await h.waitFor(() => h.portOpen(port), { what: 'fixture port' });
      const list = await platform.listListeners();
      assert.ok(Array.isArray(list));
      const l = list.find((x) => x.port === port);
      assert.ok(l, `port ${port} not listed`);
      assert.equal(l.pid, child.pid);
      assert.match(String(l.name), /^node(\.exe)?$/i);
      assert.ok(String(l.cmd).includes('server.js'), `cmd: ${l.cmd}`);
      assert.ok(Array.isArray(l.chain) && l.chain.includes(process.pid), 'ancestor chain includes the test runner');
      if (!h.WIN) assert.equal(path.resolve(l.cwd), path.resolve(path.join(root, 'lister')));
    } finally { h.killQuiet(child); }
  });

  test('finds an IPv6-only listener', async (t) => {
    const port = await h.freePort();
    let s;
    try { s = await listenOn(port, '::1'); } catch { return t.skip('no IPv6 loopback'); }
    try {
      const list = await platform.listListeners();
      assert.ok(list.some((x) => x.port === port && x.pid === process.pid));
    } finally { s.close(); }
  });

  test('every entry has a numeric port and pid', async () => {
    for (const l of await platform.listListeners()) {
      assert.equal(typeof l.port, 'number');
      assert.equal(typeof l.pid, 'number');
    }
  });
});

describe('startTimes() / sameStart()', () => {
  test('a live process has a start time close to now; a dead PID has none', async () => {
    const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { stdio: 'ignore' });
    try {
      await h.sleep(300);
      const times = await platform.startTimes([child.pid, 999999, -1, 0]);
      const t = times.get(child.pid);
      assert.ok(t && Math.abs(t - Date.now()) < 60000, `start time ${t}`);
      assert.equal(times.has(999999), false);
      // Asking again gives the same answer: that stability is what the PID check relies on.
      assert.ok(platform.sameStart((await platform.startTimes([child.pid])).get(child.pid), t));
    } finally { h.killQuiet(child); }
  });

  test('sameStart rejects missing values and different processes', () => {
    assert.equal(platform.sameStart(0, 0), false);
    assert.equal(platform.sameStart(undefined, 5), false);
    assert.equal(platform.sameStart(1_000_000, 1_000_000), true);
    assert.equal(platform.sameStart(1_000_000, 1_000_000 + 60_000), false);
  });

  test('an empty list needs no system call', async () => {
    assert.equal((await platform.startTimes([])).size, 0);
  });
});

describe('launch() + killTree()', () => {
  test('folder names with [ ] & % and spaces can be launched (PowerShell wildcard trap)', async () => {
    const dir = path.join(root, 'app[1] & 100% (copy)');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'out[1].log');
    await platform.launch({ command: `node -e "console.log(process.cwd())"`, dir, out, err: path.join(dir, 'err[1].log'), pidFile: path.join(dir, 'p[1].pid'), env: process.env });
    await h.waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').trim(), { what: 'output' });
    assert.equal(path.resolve(fs.readFileSync(out, 'utf8').trim()).toLowerCase(), path.resolve(dir).toLowerCase());
  });

  test('a folder that does not exist is refused cleanly (no crash, no stray process)', async () => {
    await assert.rejects(platform.launch({ command: 'node -e 0', dir: path.join(root, 'gone'), out: path.join(root, 'g.out'), err: path.join(root, 'g.err'), pidFile: path.join(root, 'g.pid'), env: process.env }), /not found/);
  });

  test('"install && run" style commands send the output of both parts to the log', async () => {
    const out = path.join(root, 'chain.out');
    await platform.launch({ command: `node -e "console.log('first')" && node -e "console.log('second')"`, dir: root, out, err: path.join(root, 'chain.err'), pidFile: path.join(root, 'chain.pid'), env: process.env });
    await h.waitFor(() => fs.existsSync(out) && /second/.test(fs.readFileSync(out, 'utf8')), { what: 'both outputs' });
    assert.match(fs.readFileSync(out, 'utf8'), /first[\s\S]*second/);
  });

  test('runs a command in the folder, writes output to log files and the PID file', async () => {
    const dir = path.join(root, 'launch dir with spaces & ünïcode مجلد');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(root, 'l.out');
    const err = path.join(root, 'l.err');
    const pidFile = path.join(root, 'l.pid');
    const script = path.join(dir, 's.js');
    fs.writeFileSync(script, "console.log('cwd=' + process.cwd()); console.error('to-stderr');");
    const pid = await platform.launch({ command: `node s.js`, dir, out, err, pidFile, env: process.env });
    assert.ok(pid > 0);
    // "pid startTime": the start time is what later tells this launcher apart from a recycled PID.
    const [filePid, start] = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
    assert.equal(filePid, pid);
    assert.ok(Math.abs(start - Date.now()) < 60000, `start time ${start} is not recent`);
    await h.waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('cwd='), { what: 'stdout log' });
    await h.waitFor(() => fs.readFileSync(err, 'utf8').includes('to-stderr'), { what: 'stderr log' });
    assert.equal(path.resolve(fs.readFileSync(out, 'utf8').match(/cwd=(.*)/)[1].trim()).toLowerCase(), path.resolve(dir).toLowerCase());
  });

  test('passes environment variables through (quotes and & survive intact)', async () => {
    const out = path.join(root, 'env.out');
    const value = `a "quoted" & 'single' value %PATH% $HOME`;
    await platform.launch({
      command: `node -e "console.log(process.env.MINA_TEST_VALUE)"`,
      dir: root, out, err: path.join(root, 'env.err'), pidFile: path.join(root, 'env.pid'),
      env: { ...process.env, MINA_TEST_VALUE: value },
    });
    await h.waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').trim(), { what: 'env output' });
    assert.equal(fs.readFileSync(out, 'utf8').trim(), value);
  });

  test('the launched server outlives nothing: killTree stops it and every child it spawned', async () => {
    const port = await h.freePort();
    const dir = h.makeProject(root, 'tree', { server: { port, spawnChild: true } });
    const out = path.join(root, 'tree.out');
    const pid = await platform.launch({ command: 'npm run dev', dir, out, err: path.join(root, 'tree.err'), pidFile: path.join(root, 'tree.pid'), env: process.env });
    await h.waitFor(() => h.portOpen(port), { timeout: 30000, what: 'server via npm' });
    const listeners = await platform.listListeners();
    const serverPid = listeners.find((l) => l.port === port).pid;
    assert.notEqual(serverPid, pid, 'the server runs below the launcher (cmd/sh -> npm -> node)');
    await platform.killTree(pid);
    await h.waitFor(async () => !(await h.portOpen(port)), { timeout: 15000, what: 'port to close' });
    const grandchild = Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8'));
    await h.waitFor(() => !platform.isAlive(serverPid) && !platform.isAlive(pid) && !platform.isAlive(grandchild), { timeout: 10000, what: 'whole tree to die' });
  });

  test('killTree on a PID that is already gone does not throw', async () => {
    const child = require('child_process').spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => child.on('exit', r));
    await platform.killTree(child.pid);
  });
});
