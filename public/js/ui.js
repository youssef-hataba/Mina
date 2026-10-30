// ---- Feedback helpers ----
// Puts a spinner in the button and disables it; returns the undo function (null if it was already busy).
function busyOn(el) {
  if (!el || el.classList.contains('loading')) return null;
  el.classList.add('loading');
  el.disabled = true;
  return () => { el.classList.remove('loading'); el.disabled = false; };
}

// Runs an API call with the button showing a spinner for its duration.
async function withBusy(el, task) {
  const done = busyOn(el);
  try { return await task(); } finally { done?.(); }
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2200);
  setTimeout(() => t.remove(), 2600);
}

// Small popover menu under a button. entries: [{ label, run, danger }] or 'sep'.
function showMenu(anchor, entries) {
  document.querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = entries.map((e, n) => e === 'sep' ? '<hr>' : `<button data-n="${n}" class="${e.danger ? 'danger' : ''}">${e.label}</button>`).join('');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + 6}px`;
  m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
  const close = () => { m.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc_, true); };
  const outside = (e) => { if (!m.contains(e.target) && e.target !== anchor) close(); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  m.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-n]');
    if (!b) return;
    close();
    entries[b.dataset.n].run();
  });
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', esc_, true);
  });
}

// ---- IDEs ----
let ideList = [];
let viewDir = null; // folder of the item on screen, used by the header buttons
const ideDefault = () => ideList.find((i) => i.id === localStorage.getItem('mina.ide')) || ideList.find((i) => i.id !== 'explorer') || ideList[0];

async function loadIdes() {
  ideList = await api('/api/ides');
}

async function openIn(ideId, el) {
  const ide = ideList.find((i) => i.id === ideId);
  if (!ide || !viewDir) return;
  if (ideId !== 'explorer') localStorage.setItem('mina.ide', ideId);
  // A short minimum so the spinner is visible; the editor itself takes a moment to appear anyway.
  await withBusy(el, () => Promise.all([api('/api/open', { dir: viewDir, ide: ideId }), new Promise((r) => setTimeout(r, 600))]));
  toast(`Opening in <b>${esc(ide.name)}</b>`);
  if (ideId !== 'explorer') renderOpenIn();
}

function openInHtml() {
  const ide = ideDefault();
  if (!ide || !viewDir) return '';
  return `
    <div class="split" id="openIn">
      <button class="hbtn" title="Open the project folder in ${esc(ide.name)}" onclick="openIn('${ide.id}', this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 7-5 5 5 5M16 7l5 5-5 5"/></svg>
        ${esc(ide.name)}
      </button>
      <button class="hbtn caret" title="Open in another editor" onclick="ideMenu(this)">▾</button>
    </div>`;
}

// Re-render only the split button after the default editor changes.
function renderOpenIn() {
  const el = document.getElementById('openIn');
  if (el) el.outerHTML = openInHtml();
}

function ideMenu(anchor) {
  const main = anchor.previousElementSibling;
  showMenu(anchor, ideList.map((i) => ({ label: `Open in ${esc(i.name)}`, run: () => openIn(i.id, main) })));
}

function moreMenu(anchor, id) {
  const p = projects.find((x) => x.id === id);
  showMenu(anchor, [
    { label: 'Set group...', run: () => editGroup(id) },
    { label: 'Copy folder path', run: () => navigator.clipboard.writeText(p.dir).then(() => toast('Path copied')) },
    'sep',
    { label: 'Remove from list', danger: true, run: () => removeProject(id) },
  ]);
}

function groupMenu(anchor, group) {
  const root = groupItems(group)[0]?.project.groupRoot;
  showMenu(anchor, [
    { label: 'Rename group...', run: () => renameGroup(group) },
    ...(root ? [{ label: 'Copy folder path', run: () => navigator.clipboard.writeText(root).then(() => toast('Path copied')) }] : []),
    'sep',
    { label: 'Remove group from Mina', danger: true, run: () => removeGroup(group) },
  ]);
}

const MORE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const RELOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';

// The preview is another origin, so its own location can't be read or reloaded from here; setting src again
// loads it afresh (from the app's start page) without reloading the dashboard.
function reloadPreview(btn) {
  const frame = document.querySelector('#view iframe');
  if (!frame) return;
  btn.classList.add('spin');
  frame.addEventListener('load', () => btn.classList.remove('spin'), { once: true });
  setTimeout(() => btn.classList.remove('spin'), 10000);
  frame.src = frame.src;
}
