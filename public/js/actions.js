// ---- Actions ----
const conflictText = (list) => list.map((c) => `<li><b>${esc(c.project)}</b>: port ${c.port} is taken by <b>${esc(c.by)}</b></li>`).join('');

// The server answers with a question (install? port taken?) until every answer is in the request.
// The spinner runs only while a request is in flight, not while a dialog waits for the user.
async function startProject(id, el) {
  const p = projects.find((x) => x.id === id);
  const opts = { id };
  for (;;) {
    const res = await withBusy(el, () => api('/api/projects/start', opts));
    if (res.alreadyRunning) { await tell('Already running', `This project is already running on port <b>${res.port}</b>.`); return load(); }
    if (res.error) { await tell('Could not start', esc(res.error)); return load(); }
    if (res.needsInstall) {
      if (!await ask('Install dependencies?', `<b>${esc(p.name)}</b> has no <code>${esc(p.installWhat || 'node_modules')}</code>. Run <code>${esc(p.installCommand || 'npm install')}</code> first?`, { ok: 'Install & start' })) return;
      opts.install = true;
    } else if (res.conflicts) {
      if (!await ask('Port already in use', `<ul>${conflictText(res.conflicts)}</ul>Start anyway? It will probably pick another port.`, { ok: 'Start anyway' })) return;
      opts.force = true;
    } else break;
  }
  activeKey = 'p:' + id;
  watchUntil = Date.now() + 120000;
  await withBusy(el, () => load());
}

async function startGroup(group, el) {
  const opts = { group };
  for (;;) {
    const res = await withBusy(el, () => api('/api/groups/start', opts));
    if (res.needsInstall) {
      if (!await ask('Install dependencies?', `These projects need their dependencies installed: <b>${res.needsInstall.map(esc).join(', ')}</b>. Install them first?`, { ok: 'Install & start' })) return;
      opts.install = true;
    } else if (res.conflicts) {
      if (!await ask('Port already in use', `<ul>${conflictText(res.conflicts)}</ul>Start the group anyway?`, { ok: 'Start anyway' })) return;
      opts.force = true;
    } else break;
  }
  watchUntil = Date.now() + 240000;
  await withBusy(el, () => load());
}

async function stopGroup(group, el) {
  if (!await ask('Stop group?', `Stop every project in <b>${esc(group)}</b>?`, { ok: 'Stop all', danger: true })) return;
  await withBusy(el, async () => { await api('/api/groups/stop', { group }); await load(); });
  toast(`Stopped <b>${esc(group)}</b>`);
}

async function renameGroup(group) {
  const name = await askText('Rename group', 'Every project in this group moves to the new name.', group);
  if (name === null || !name.trim() || name.trim() === group) return;
  const res = await api('/api/groups/rename', { group, name });
  if (res.error) return tell('Could not rename the group', esc(res.error));
  activeKey = 'g:' + name.trim();
  await load();
  toast(`Renamed to <b>${esc(name.trim())}</b>`);
}

async function removeGroup(group) {
  const n = groupItems(group).length;
  if (!await ask('Remove group?', `Stop anything running in <b>${esc(group)}</b> and remove its ${n} project${n > 1 ? 's' : ''} from Mina. The folders stay on disk.`, { ok: 'Remove group', danger: true })) return;
  // Stopping running servers takes a few seconds; show it, so it doesn't look like nothing happened.
  if (activeKey === 'g:' + group) {
    document.querySelector('#view .console').innerHTML =
      `<div class="center"><div class="booting"><span class="spinner"></span> Stopping and removing ${esc(group)}...</div></div>`;
  }
  const res = await api('/api/groups/remove', { group });
  if (res.error) { await tell('Could not remove the group', esc(res.error)); return load(); }
  activeKey = null;
  await load();
  toast(`Removed <b>${esc(group)}</b>`);
}

async function editGroup(id) {
  const p = projects.find((x) => x.id === id);
  const name = await askText('Group', 'Projects in the same group start and stop together. Leave empty for no group.', p.group || '');
  if (name === null) return;
  await api('/api/projects/set-group', { id, group: name });
  await load();
  toast(name.trim() ? `Moved to <b>${esc(name.trim())}</b>` : 'Removed from group');
}

async function stopProject(id, el) {
  if (!await ask('Stop project?', 'This stops the dev server and everything it spawned.', { ok: 'Stop', danger: true })) return;
  await withBusy(el, async () => { await api('/api/projects/stop', { id }); await load(); });
}

async function removeProject(id) {
  if (!await ask('Remove project?', 'It is only removed from this list. The folder stays on disk.', { ok: 'Remove', danger: true })) return;
  await api('/api/projects/remove', { id });
  await load();
  toast('Project removed');
}

async function kill(pid, el) {
  if (!await ask('Stop server?', 'This kills the process listening on this port.', { ok: 'Stop', danger: true })) return;
  await withBusy(el, async () => { await api('/api/kill', { pid }); await load(); });
}

async function saveApp(port, el) {
  const app = apps.find((a) => a.port === port);
  if (!app?.project) return;
  await withBusy(el, async () => { await api('/api/projects/add', { dirs: [app.project.dir] }); await load(); });
  toast(`Saved <b>${esc(app.project.name)}</b>`);
}

function openAdd() {
  candidates = [];
  select('add');
}

async function pickFolder(el) {
  document.getElementById('scanMsg').textContent = 'File Explorer is open (check the taskbar if you can\'t see it)...';
  const { dir } = await withBusy(el, () => api('/api/pick-folder', {}));
  const msg = document.getElementById('scanMsg');
  if (msg) msg.textContent = '';
  if (!dir) return;
  document.getElementById('dir').value = dir;
  scanDir(document.querySelector('.pick .ghost'));
}

async function scanDir(el) {
  const dir = document.getElementById('dir').value.trim();
  if (!dir) return;
  const res = await withBusy(el, () => api('/api/projects/scan', { dir }));
  const saved = new Set(projects.map((p) => p.dir.toLowerCase()));
  candidates = res.candidates.map((c) => ({ ...c, added: saved.has(c.dir.toLowerCase()) }));
  renderView();
  document.getElementById('dir').value = dir;
  if (!candidates.length) document.getElementById('scanMsg').textContent = 'No project with a dev or start script here, or in the folders inside it.';
}

async function addSelected(el) {
  const dirs = [...document.querySelectorAll('.cand input:checked')].map((x) => candidates[x.dataset.n].dir);
  if (!dirs.length) return;
  await withBusy(el, async () => {
    await api('/api/projects/add', { dirs });
    candidates = [];
    activeKey = null;
    await load();
    // Land on what was just added: its group page when they share one, otherwise the (first) project itself.
    const added = projects.filter((p) => dirs.some((d) => d.toLowerCase() === p.dir.toLowerCase()));
    const group = added[0]?.group;
    if (added.length > 1 && group && added.every((p) => p.group === group)) select('g:' + group);
    else if (added.length) select('p:' + added[0].id);
  });
  toast(`Added ${dirs.length} project${dirs.length > 1 ? 's' : ''}`);
}

loadIdes().finally(() => { load(); watchServer(); });
