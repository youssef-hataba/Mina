const ICON = {
  // Frontend: a browser window whose page is the logo's stack of teal/purple/blue bars, with the green status light.
  frontend: '<svg viewBox="0 0 24 24" fill="none"><rect x="2.5" y="3.5" width="19" height="17" rx="3" stroke="#6fa0cf" stroke-width="1.7"/><path d="M2.5 8h19" stroke="#6fa0cf" stroke-width="1.7"/><circle cx="5.5" cy="5.75" r=".75" fill="#6db3c4"/><circle cx="7.9" cy="5.75" r=".75" fill="#a094d4"/><circle cx="10.3" cy="5.75" r=".75" fill="#7be0a6"/><rect x="5.5" y="10.4" width="13" height="2.4" rx="1.2" fill="#6db3c4"/><rect x="5.5" y="13.6" width="13" height="2.4" rx="1.2" fill="#a094d4"/><rect x="5.5" y="16.8" width="9" height="2.4" rx="1.2" fill="#7f9fdc"/><circle cx="17.1" cy="18" r="1.2" fill="#7be0a6"/></svg>',
  // Backend: a two-unit server with status lights, wired to the network below.
  backend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2.5" width="18" height="6.5" rx="2"/><rect x="3" y="10.5" width="18" height="6.5" rx="2"/><circle cx="7" cy="5.75" r=".9" fill="currentColor"/><circle cx="7" cy="13.75" r=".9" fill="currentColor"/><path d="M12.5 5.75h5M12.5 13.75h5M12 17v3.5M5.5 20.5h13"/></svg>',
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cls = (x) => (x.kind === 'backend' ? 'be' : 'fe');
const appLabel = (a) => a.project?.name || a.title || a.process;
const STATE_TEXT = { running: 'Running', starting: 'Starting...', queued: 'Queued...', crashed: 'Crashed', stopped: 'Stopped' };
let apps = [];
let projects = [];
let items = [];
let activeKey = null;
let busy = false;
let watchUntil = 0;
let candidates = [];
const TOKEN = document.querySelector('meta[name="token"]').content;

// ---- Dialogs (replace the browser's confirm/alert/prompt) ----
// Resolves with true/false (ask), undefined (tell) or the typed text / null (askText). Enter confirms, Esc cancels.
function dialog({ title, body, ok = 'OK', cancel = 'Cancel', danger = false, input = null, icon = '?' }) {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `
      <div class="dialog ${danger ? 'danger' : ''}" role="dialog" aria-modal="true">
        <h2><i>${icon}</i>${esc(title)}</h2>
        <div class="body">${body}</div>
        ${input !== null ? `<input value="${esc(input)}">` : ''}
        <div class="btns">
          ${cancel ? `<button class="ghost" data-v="0">${esc(cancel)}</button>` : ''}
          <button class="ok" data-v="1">${esc(ok)}</button>
        </div>
      </div>`;
    const field = scrim.querySelector('input');
    const done = (yes) => {
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      resolve(input !== null ? (yes ? field.value : null) : yes);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) done(false);
      if (e.target.dataset.v) done(e.target.dataset.v === '1');
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    (field || scrim.querySelector('.ok')).focus();
    field?.select();
  });
}
const ask = (title, body, opts = {}) => dialog({ title, body, icon: opts.danger ? '■' : '?', ...opts });
const tell = (title, body) => dialog({ title, body, cancel: null, icon: 'i' });
const askText = (title, body, value) => dialog({ title, body, input: value, ok: 'Save', icon: '✎' });

// Every API call carries the per-run token; a 403 means the server restarted and the page is stale.
async function api(url, body) {
  const opts = { headers: { 'X-Token': TOKEN } };
  if (body) Object.assign(opts, { method: 'POST', body: JSON.stringify(body), headers: { ...opts.headers, 'Content-Type': 'application/json' } });
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  // Only a token refusal means a restart; other 403s ("unknown pid": the process already exited) are normal errors.
  if (res.status === 403 && data.error === 'bad token') {
    document.getElementById('view').innerHTML = '<div class="empty"><b>Mina was restarted</b>Reload this page (F5) to reconnect.</div>';
    throw new Error('stale token');
  }
  return data;
}

// One sidebar entry per saved project (any state) plus running apps that aren't saved.
function buildItems() {
  const linked = new Set();
  const fromProjects = projects.map((p) => {
    const app = p.port != null ? apps.find((a) => a.port === p.port) : null;
    if (app) linked.add(app.port);
    return { key: 'p:' + p.id, kind: p.kind, name: p.name, framework: p.framework, state: p.state, project: p, app };
  });
  const loose = apps.filter((a) => !linked.has(a.port)).map((a) => ({
    key: 'a:' + a.port, kind: a.kind, name: appLabel(a), framework: a.framework, state: 'running', app: a,
  }));
  return [...fromProjects, ...loose];
}

// force=false (background re-checks) keeps the view as is when the active item didn't change,
// so the preview and a live log aren't torn down every few seconds.
// A load requested while one is in flight runs right after it, so a change made meanwhile is never missed.
let reloadAfter = false;
async function load(force = true) {
  if (busy) { reloadAfter = true; return; }
  busy = true;
  const btn = document.getElementById('refresh');
  btn.classList.add('spin');
  try {
    ({ apps, projects } = await api('/api/apps' + (document.getElementById('all').checked ? '?all=1' : '')));
    items = buildItems();
    const fe = apps.filter((a) => a.kind === 'frontend').length;
    document.getElementById('count').innerHTML = `<b>${apps.length}</b> running · ${fe} frontend · ${apps.length - fe} backend`;
    // a group page stays open as long as the group still has members
    const exists = activeKey?.startsWith('g:') ? items.some((i) => i.project?.group === activeKey.slice(2)) : items.some((i) => i.key === activeKey);
    if (activeKey !== 'add' && !exists) activeKey = items[0]?.key ?? 'add';
    renderTabs();
    const sig = viewSig();
    if (force || sig !== lastSig) renderView();
  } finally {
    busy = false;
    btn.classList.remove('spin');
  }
  if (reloadAfter) { reloadAfter = false; return load(true); }
  // Re-check only while something is booting, and only for a bounded time. That includes a boot already under
  // way when the page was opened (a reload, a second tab, Mina restarted): it gets its own window to finish.
  const booting = projects.some((p) => p.state === 'starting' || p.state === 'queued');
  if (booting && !watchUntil) watchUntil = Date.now() + 180000;
  if (!booting) watchUntil = 0;
  if (booting && Date.now() < watchUntil) setTimeout(() => load(false), 2500);
}

let lastSig = '';
function viewSig() {
  // A group page changes whenever any member does.
  if (activeKey?.startsWith('g:')) return JSON.stringify([activeKey, groupItems(activeKey.slice(2)).map((i) => [i.key, i.state, i.app?.port])]);
  const i = items.find((x) => x.key === activeKey);
  return JSON.stringify([activeKey, i?.state, i?.app?.port, i?.app?.pid]);
}
