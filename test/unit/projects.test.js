// projects.js in isolation: detection, scanning, config, groups, logs, input validation.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('../helpers');

// projects.js reads the home folder when it loads, so point it at a throwaway one first.
const HOME = h.tmpDir('unit-home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const projects = require('../../projects');
const CONFIG = path.join(HOME, '.mina', 'config.json');
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const resetConfig = () => fs.rmSync(path.join(HOME, '.mina'), { recursive: true, force: true });

let root;
before(() => { root = h.tmpDir('unit'); });
after(() => { h.rmQuiet(root); h.rmQuiet(HOME); });

describe('detect()', () => {
  test('picks the first dev-like script in priority order', () => {
    const cases = [
      [{ start: 'x', dev: 'x', serve: 'x' }, 'dev'],
      [{ start: 'x', 'start:dev': 'x' }, 'start:dev'],
      [{ start: 'x', develop: 'x' }, 'develop'],
      [{ start: 'x', serve: 'x' }, 'serve'],
      [{ start: 'x', build: 'x' }, 'start'],
    ];
    cases.forEach(([scripts, want], i) => {
      const dir = h.makeProject(root, `scripts-${i}`, { scripts });
      assert.equal(projects.detect(dir).script, want);
    });
  });

  test('returns null without a runnable script, package.json or valid JSON', () => {
    assert.equal(projects.detect(h.makeProject(root, 'no-script', { scripts: { build: 'x', test: 'x' } })), null);
    assert.equal(projects.detect(h.makeProject(root, 'empty-scripts', { scripts: {} })), null);
    const noPkg = path.join(root, 'no-pkg');
    fs.mkdirSync(noPkg);
    assert.equal(projects.detect(noPkg), null);
    const bad = path.join(root, 'bad-json');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'package.json'), '{ not json');
    assert.equal(projects.detect(bad), null);
    assert.equal(projects.detect(path.join(root, 'does-not-exist')), null);
  });

  test('a package.json without "scripts" is not runnable (no crash)', () => {
    const dir = path.join(root, 'no-scripts-key');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
    assert.equal(projects.detect(dir), null);
  });

  test('detects the package manager from the lockfile', () => {
    const cases = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm'], [undefined, 'npm']];
    cases.forEach(([lock, pm], i) => {
      assert.equal(projects.detect(h.makeProject(root, `pm-${i}`, { lock })).pm, pm, `lock ${lock}`);
    });
  });

  test('falls back to the folder name and merges dev + regular dependencies', () => {
    const dir = path.join(root, 'nameless');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'x' }, dependencies: { express: '1' }, devDependencies: { vite: '1' } }));
    const d = projects.detect(dir);
    assert.equal(d.name, 'nameless');
    assert.deepEqual(d.deps.sort(), ['express', 'vite']);
    assert.equal(d.dir, path.resolve(dir));
  });
});

describe('scan()', () => {
  test('a parent folder returns its child projects, skipping noise folders', () => {
    const ws = path.join(root, 'workspace');
    h.makeProject(ws, 'api');
    h.makeProject(ws, 'web');
    h.makeProject(ws, 'node_modules');
    h.makeProject(ws, 'dist');
    h.makeProject(ws, '.hidden');
    fs.mkdirSync(path.join(ws, 'docs'));
    fs.writeFileSync(path.join(ws, 'README.md'), '');
    const names = projects.scan(ws).map((p) => p.name).sort();
    assert.deepEqual(names, ['api', 'web']);
  });

  test('child projects win over a runnable workspace root', () => {
    const ws = h.makeProject(root, 'monorepo', { scripts: { dev: 'concurrently ...' } });
    h.makeProject(ws, 'client');
    assert.deepEqual(projects.scan(ws).map((p) => p.name), ['client']);
  });

  test('a single project folder returns itself', () => {
    const dir = h.makeProject(root, 'single');
    assert.deepEqual(projects.scan(dir).map((p) => p.name), ['single']);
  });

  test('missing paths, files and empty input return []', () => {
    assert.deepEqual(projects.scan(path.join(root, 'nope')), []);
    assert.deepEqual(projects.scan(path.join(h.makeProject(root, 'f'), 'package.json')), []);
    assert.deepEqual(projects.scan(''), []);
  });

  test('handles unusual folder names (spaces, quotes, &, Arabic, emoji)', () => {
    const parent = path.join(root, 'weird names');
    const names = ["my app", "o'brien", 'a&b', 'مشروع', 'rocket🚀', '100%'];
    names.forEach((n) => h.makeProject(parent, n));
    assert.deepEqual(projects.scan(parent).map((p) => p.name).sort(), [...names].sort());
  });
});

describe('config: add / remove / groups', () => {
  test('addProjects saves runnable folders once and ignores the rest', () => {
    resetConfig();
    const a = h.makeProject(root, 'cfg-a');
    const b = h.makeProject(root, 'cfg-b');
    const junk = path.join(root, 'cfg-junk');
    fs.mkdirSync(junk);
    projects.addProjects([a, b, a, junk, path.join(root, 'missing')]);
    const list = readConfig().projects;
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((p) => p.name).sort(), ['cfg-a', 'cfg-b']);
    for (const p of list) {
      assert.match(p.id, /^[0-9a-f]{10}$/);
      assert.equal(p.script, 'dev');
      assert.equal(p.pm, 'npm');
    }
    // Adding again (and with different casing / trailing separator where the OS ignores case) changes nothing.
    projects.addProjects([a + path.sep, h.WIN ? a.toUpperCase() : a]);
    assert.equal(readConfig().projects.length, 2);
  });

  test('ids are stable for the same folder', () => {
    resetConfig();
    const a = h.makeProject(root, 'stable');
    projects.addProjects([a]);
    const id1 = readConfig().projects[0].id;
    resetConfig();
    projects.addProjects([a]);
    assert.equal(readConfig().projects[0].id, id1);
  });

  test('removeProject only removes from the list, never from disk', () => {
    resetConfig();
    const a = h.makeProject(root, 'rm-me');
    projects.addProjects([a]);
    projects.removeProject(readConfig().projects[0].id);
    assert.equal(readConfig().projects.length, 0);
    assert.ok(fs.existsSync(path.join(a, 'package.json')));
    projects.removeProject('does-not-exist');
  });

  test('a corrupt config.json is treated as empty instead of crashing', () => {
    resetConfig();
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, '{{{');
    assert.deepEqual(projects.withStatus([], () => null), []);
    projects.addProjects([h.makeProject(root, 'after-corrupt')]);
    assert.equal(readConfig().projects.length, 1);
  });

  test('projects sharing a parent folder are grouped automatically under its name', () => {
    resetConfig();
    const shop = path.join(root, 'shop');
    projects.addProjects([h.makeProject(shop, 'api'), h.makeProject(shop, 'web'), h.makeProject(root, 'solo')]);
    const status = projects.withStatus([], () => null);
    const byName = Object.fromEntries(status.map((p) => [p.name, p]));
    assert.equal(byName.api.group, 'shop');
    assert.equal(byName.web.group, 'shop');
    assert.equal(byName.solo.group, null, 'a lone project is not a group');
    assert.equal(projects.groupMembers('shop').length, 2);
    assert.equal(path.resolve(byName.api.groupRoot), path.resolve(shop));
  });

  test('explicit groups win, and "" means no group', () => {
    const status = projects.withStatus([], () => null);
    const api = status.find((p) => p.name === 'api');
    const solo = status.find((p) => p.name === 'solo');
    projects.setGroup(solo.id, '  Team X  ');
    projects.setGroup(api.id, '');
    const again = Object.fromEntries(projects.withStatus([], () => null).map((p) => [p.name, p]));
    assert.equal(again.solo.group, 'Team X', 'trimmed');
    assert.equal(again.api.group, null);
    assert.equal(again.web.group, 'shop', 'the other member keeps its folder group');
    assert.deepEqual(projects.groupMembers('Team X').map((p) => p.name), ['solo']);
    assert.deepEqual(projects.groupMembers('nope'), []);
  });

  test('a group spanning unrelated folders has no root when the only common folder is too broad', () => {
    const roots = projects.groupRoots();
    assert.equal(typeof roots, 'object');
    // Team X is a single project, so its root is its own folder.
    assert.ok(roots['Team X']);
  });

  test('withStatus reports missing folders, missing node_modules and the run command', () => {
    resetConfig();
    const gone = h.makeProject(root, 'will-vanish');
    const bare = h.makeProject(root, 'bare', { nodeModules: false, lock: 'pnpm-lock.yaml', deps: ['express'] });
    projects.addProjects([gone, bare]);
    fs.rmSync(gone, { recursive: true, force: true });
    const s = Object.fromEntries(projects.withStatus([], () => null).map((p) => [p.name, p]));
    assert.equal(s['will-vanish'].missing, true);
    assert.equal(s.bare.missing, false);
    assert.equal(s.bare.needsInstall, true);
    assert.equal(s.bare.command, 'pnpm run dev');
    assert.equal(s.bare.state, 'stopped');
    assert.equal(s.bare.hasLog, false);
  });

  test('a running app marks its project running and remembers its port', () => {
    resetConfig();
    const dir = h.makeProject(root, 'runner');
    projects.addProjects([dir]);
    const app = { port: 4321, kind: 'backend', framework: 'Express', project: { name: 'runner', dir: h.WIN ? dir.toUpperCase() : dir } };
    const [p] = projects.withStatus([app], () => null);
    assert.equal(p.state, 'running');
    assert.equal(p.port, 4321);
    assert.equal(p.kind, 'backend');
    assert.equal(readConfig().projects[0].lastPort, 4321);
  });
});

describe('start() input validation', () => {
  // These values come from config.json, which a user (or a bad actor with file access) can edit by hand.
  const evil = [
    { script: 'dev & calc', pm: 'npm' },
    { script: 'dev; rm -rf ~', pm: 'npm' },
    { script: 'dev$(whoami)', pm: 'npm' },
    { script: 'dev`id`', pm: 'npm' },
    { script: 'dev|more', pm: 'npm' },
    { script: 'dev\nwhoami', pm: 'npm' },
    { script: 'dev', pm: 'calc' },
    { script: 'dev', pm: 'npm & calc' },
    { script: '', pm: 'npm' },
  ];
  for (const p of evil) {
    test(`rejects ${JSON.stringify(p)}`, async () => {
      await assert.rejects(projects.start({ id: 'x', dir: root, ...p }), /bad script/);
    });
  }
});

describe('readLogs()', () => {
  test('reads incrementally from offsets and restarts after truncation', () => {
    const logs = path.join(HOME, '.mina', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const out = path.join(logs, 'L1.log');
    fs.writeFileSync(out, 'one\n');
    let r = projects.readLogs('L1');
    assert.equal(r.out, 'one\n');
    assert.equal(r.err, '');
    fs.appendFileSync(out, 'two\n');
    r = projects.readLogs('L1', r.offsets);
    assert.equal(r.out, 'two\n');
    r = projects.readLogs('L1', r.offsets);
    assert.equal(r.out, '', 'nothing new');
    fs.writeFileSync(out, 'x\n');
    r = projects.readLogs('L1', { out: 999, err: -1 });
    assert.equal(r.out, 'x\n', 'a shorter file (restart) is read from the start');
  });

  test('only the last 64 KB of a big log is sent first', () => {
    const out = path.join(HOME, '.mina', 'logs', 'L2.log');
    fs.writeFileSync(out, 'a'.repeat(200 * 1024) + 'END');
    const r = projects.readLogs('L2');
    assert.ok(r.out.length <= 64 * 1024);
    assert.ok(r.out.endsWith('END'));
  });

  test('missing logs read as empty', () => {
    const r = projects.readLogs('never-ran');
    assert.deepEqual(r, { out: '', err: '', offsets: { out: 0, err: 0 } });
  });
});
