// Runs the test suite: node test/run.js [unit|integration] [extra node --test flags]
// Files are passed explicitly because "node --test <dir>" behaves differently across Node 18-24.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const which = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
const flags = process.argv.slice(which ? 3 : 2);
const dirs = which ? [which] : ['unit', 'integration'];

const files = dirs.flatMap((d) => {
  const dir = path.join(__dirname, d);
  if (!fs.existsSync(dir)) throw new Error(`No such test folder: ${d}`);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
});

const tmp = path.join(__dirname, '.tmp');
const clean = () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
clean();
const r = spawnSync(process.execPath, ['--test', ...flags, ...files], { stdio: 'inherit' });
try { clean(); } catch {}
process.exit(r.status ?? 1);
