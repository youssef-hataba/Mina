// Regressions found in review: each of these crashed Mina or made it act on the wrong thing.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('../helpers');

const HOME = h.tmpDir('regress-home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const projects = require('../../projects');
const platform = require('../../platform');
const CONFIG = path.join(HOME, '.mina', 'config.json');
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const resetConfig = () => fs.rmSync(path.join(HOME, '.mina'), { recursive: true, force: true });

let root;
before(() => { root = h.tmpDir('regress'); });
after(() => { h.rmQuiet(root); h.rmQuiet(HOME); });

describe('PID ownership (a recycled PID must never be adopted or killed)', () => {
  const pidFile = (id) => path.join(HOME, '.mina', 'logs', `${id}.pid`);
  let victim;
  let p;
  before(async () => {
    resetConfig();
    projects.addProjects([h.makeProject(root, 'owner')]);
    p = readConfig().projects[0];
    victim = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await h.sleep(300);
    fs.mkdirSync(path.dirname(pidFile(p.id)), { recursive: true });
  });
  after(() => h.killQuiet(victim));

  // refreshOwnership is throttled to once every 1.5 s.
  const settle = async () => { await h.sleep(1600); await projects.refreshOwnership(); };

  test('a pid file pointing at an unrelated live process (wrong start time) is discarded', async () => {
    fs.writeFileSync(pidFile(p.id), `${victim.pid} 1000`);
    await settle();
    assert.equal(projects.ownPid(p.id), null);
    assert.ok(!projects.spawnedPids().includes(victim.pid), '/api/kill must not accept it');
    assert.equal(projects.ownerOf([victim.pid]), null, 'its children must not be attributed to the project');
    assert.equal(fs.existsSync(pidFile(p.id)), false, 'the stale file is removed');
  });

  test('an old-format pid file (PID only) is not trusted', async () => {
    fs.writeFileSync(pidFile(p.id), String(victim.pid));
    await settle();
    assert.equal(projects.ownPid(p.id), null);
  });

  test('a pid file whose start time matches is recognised as ours (this is how a Mina restart keeps its servers)', async () => {
    const start = (await platform.startTimes([victim.pid])).get(victim.pid);
    fs.writeFileSync(pidFile(p.id), `${victim.pid} ${start}`);
    await settle();
    assert.equal(projects.ownPid(p.id), victim.pid);
    assert.ok(projects.spawnedPids().includes(victim.pid));
    assert.equal(projects.ownerOf([12345, victim.pid]).name, 'owner');
  });

  test('stop() on a project whose launcher PID was recycled kills nothing', async () => {
    fs.writeFileSync(pidFile(p.id), `${victim.pid} 1000`);
    await settle();
    await projects.stop(p, []);
    await h.sleep(300);
    assert.ok(h.isAlive(victim.pid), 'the unrelated process is still alive');
  });

  test('a dead PID is dropped', async () => {
    const dead = require('child_process').spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => dead.on('exit', r));
    fs.writeFileSync(pidFile(p.id), `${dead.pid} ${Date.now()}`);
    await settle();
    assert.equal(projects.ownPid(p.id), null);
  });
});

describe('group names are data, not code', () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    test(`a group called "${name}" works (it used to crash every page load)`, () => {
      resetConfig();
      projects.addProjects([h.makeProject(root, `proto-${name}-a`), h.makeProject(root, `proto-${name}-b`)]);
      const [pa, pb] = readConfig().projects;
      projects.setGroup(pa.id, name);
      projects.setGroup(pb.id, name);
      const status = projects.withStatus([], () => null);
      assert.ok(status.every((s) => s.group === name));
      assert.equal(projects.groupMembers(name).length, 2);
      assert.ok(Object.keys(projects.groupRoots()).includes(name));
    });
  }

  test('a parent FOLDER named like a prototype key groups fine too', () => {
    resetConfig();
    const parent = path.join(root, 'constructor');
    projects.addProjects([h.makeProject(parent, 'x'), h.makeProject(parent, 'y')]);
    assert.ok(projects.withStatus([], () => null).every((s) => s.group === 'constructor'));
  });

  test('two different parent folders with the same name are two groups, not one', () => {
    resetConfig();
    const one = path.join(root, 'work', 'app');
    const two = path.join(root, 'old', 'app');
    projects.addProjects([h.makeProject(one, 'fe'), h.makeProject(one, 'be'), h.makeProject(two, 'fe'), h.makeProject(two, 'be')]);
    const groups = [...new Set(projects.withStatus([], () => null).map((s) => s.group))].sort();
    assert.deepEqual(groups, ['app (old)', 'app (work)']);
    assert.equal(projects.groupMembers('app (work)').length, 2);
    assert.equal(projects.groupMembers('app').length, 0);
  });
});

describe('config safety', () => {
  test('a corrupt config is moved aside, not overwritten', () => {
    resetConfig();
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, '{"projects": [ oops');
    projects.addProjects([h.makeProject(root, 'after-broken')]);
    const backups = fs.readdirSync(path.dirname(CONFIG)).filter((f) => f.startsWith('config.json.broken-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(CONFIG), backups[0]), 'utf8'), '{"projects": [ oops');
    assert.equal(readConfig().projects.length, 1);
  });

  test('a config with the wrong shape is tolerated', () => {
    for (const bad of ['null', '[]', '{"projects": 5}', '{"projects": [null, 1, {"id": 3}, {"dir": "x"}]}', '{}']) {
      resetConfig();
      fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
      fs.writeFileSync(CONFIG, bad);
      assert.deepEqual(projects.withStatus([], () => null), [], bad);
      assert.equal(projects.getProject('x'), undefined);
      assert.deepEqual(projects.groupRoots(), {});
    }
  });

  test('saving leaves no temp files behind', () => {
    resetConfig();
    projects.addProjects([h.makeProject(root, 'atomic')]);
    assert.deepEqual(fs.readdirSync(path.dirname(CONFIG)).filter((f) => f.endsWith('.tmp')), []);
  });
});

describe('scan() edge cases', () => {
  test('an app with a helper subproject (e2e/) is offered together with it', () => {
    const app = h.makeProject(root, 'real-app', { deps: ['next'] });
    h.makeProject(app, 'e2e');
    assert.deepEqual(projects.scan(app, (deps) => deps.includes('next')).map((p) => p.name), ['real-app', 'e2e']);
  });

  test('an unreadable folder returns [] instead of throwing', (t) => {
    const locked = h.WIN ? 'C:\\System Volume Information' : '/root';
    if (!fs.existsSync(locked)) return t.skip('no protected folder here');
    assert.deepEqual(projects.scan(locked), []);
  });
});

describe('logs: multi-byte characters are never split', () => {
  test('a read that ends inside a character keeps its bytes for the next read', () => {
    const out = path.join(HOME, '.mina', 'logs', 'U1.log');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const full = Buffer.from('مرحبا ✓ 🚀', 'utf8');
    fs.writeFileSync(out, full.subarray(0, full.length - 2)); // the rocket emoji is cut in half
    let r = projects.readLogs('U1');
    assert.equal(r.out, 'مرحبا ✓ ');
    assert.ok(!r.out.includes('\uFFFD'), 'no replacement character');
    fs.writeFileSync(out, full);
    r = projects.readLogs('U1', r.offsets);
    assert.equal(r.out, '🚀');
  });
});

describe('groupRoots on network shares', () => {
  test('a UNC path keeps its \\\\server\\share root', (t) => {
    if (!h.WIN) return t.skip('Windows only');
    resetConfig();
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify({ projects: [
      { id: 'u1', dir: '\\\\server\\share\\repo\\api', name: 'api', script: 'dev', pm: 'npm', group: 'net' },
      { id: 'u2', dir: '\\\\server\\share\\repo\\web', name: 'web', script: 'dev', pm: 'npm', group: 'net' },
    ] }));
    assert.equal(projects.groupRoots().net, '\\\\server\\share\\repo');
  });

  test('folders on different drives have no common root', (t) => {
    if (!h.WIN) return t.skip('Windows only');
    resetConfig();
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify({ projects: [
      { id: 'd1', dir: 'C:\\a\\api', name: 'api', script: 'dev', pm: 'npm', group: 'g' },
      { id: 'd2', dir: 'D:\\a\\web', name: 'web', script: 'dev', pm: 'npm', group: 'g' },
    ] }));
    assert.equal(projects.groupRoots().g, null);
  });
});
