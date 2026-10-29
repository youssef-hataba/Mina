// node:test reporter for GitHub Actions: each failing test becomes an error annotation on its file and line,
// readable on the run page and the PR without opening the logs. Used next to the normal spec reporter in CI.
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Workflow-command escaping: % first, then line breaks; properties also escape : and ,
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function message(err) {
  if (!err) return 'failed';
  const inner = err.cause || err;
  const text = inner.message || String(inner);
  const detail = inner.actual !== undefined || inner.expected !== undefined
    ? `\nactual: ${JSON.stringify(inner.actual)}\nexpected: ${JSON.stringify(inner.expected)}`
    : '';
  return (text + detail).slice(0, 2000);
}

module.exports = async function* githubReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const d = event.data;
    // A failing suite repeats its children's failures; report each test once.
    if (d.details?.type === 'suite') continue;
    const file = d.file ? path.relative(ROOT, d.file).replace(/\\/g, '/') : '';
    const where = file ? `file=${prop(file)},line=${d.line || 1},` : '';
    yield `::error ${where}title=${prop(`${process.platform} node ${process.versions.node}: ${d.name}`)}::${esc(message(d.details?.error))}\n`;
  }
};
