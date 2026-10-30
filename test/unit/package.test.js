// The published package: everything the code loads must be in package.json "files", or an npm install breaks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const pkg = require('../../package.json');
const shipped = (rel) => pkg.files.some((f) => (f.endsWith('/') ? rel.startsWith(f) : rel === f));

test('every local require() of a shipped file is shipped too', () => {
  const queue = [pkg.bin.mina.replace(/^\.\//, ''), pkg.main];
  const seen = new Set();
  while (queue.length) {
    const rel = path.normalize(queue.pop()).replace(/\\/g, '/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    assert.ok(shipped(rel), `${rel} is loaded at runtime but missing from package.json "files"`);
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const [, dep] of src.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
      const file = path.join(path.dirname(rel), dep.endsWith('.js') || dep.endsWith('.json') ? dep : `${dep}.js`);
      if (!file.endsWith('package.json')) queue.push(file);
    }
  }
  assert.ok(seen.size >= 6, `followed ${[...seen].join(', ')}`);
});

test('the page and its assets are shipped', () => {
  assert.ok(shipped('index.html'));
  assert.ok(shipped('public/js/core.js'));
});

test('the CLI starts with its node shebang', () => {
  const head = fs.readFileSync(path.join(ROOT, 'bin', 'cli.js'), 'utf8').split('\n')[0];
  assert.match(head.replace(/\r$/, ''), /^#!\/usr\/bin\/env node$/);
});
