// ---- Sidebar ----
function tab(i) {
  const sub = i.app ? `:${i.app.port} · ${esc(i.framework)}` : `${STATE_TEXT[i.state]} · ${esc(i.framework)}`;
  const action = i.project
    ? (BUSY.has(i.state)
      ? `<span class="mini stop-mini" title="Stop" onclick="event.stopPropagation(); stopProject('${i.project.id}', this)">■</span>`
      : `<span class="mini play-mini" title="Start" onclick="event.stopPropagation(); startProject('${i.project.id}', this)">▶</span>`)
    : '';
  return `
    <button class="tab ${cls(i)} ${i.key === activeKey ? 'active' : ''} ${i.state !== 'running' ? 'off' : ''}" onclick="select('${i.key}')">
      <span class="badge">${ICON[i.kind]}</span>
      <span class="txt">
        <div class="nm">${esc(i.name)}</div>
        <div class="sm mono">${sub}</div>
      </span>
      ${action}
      <span class="dot ${i.state}"></span>
    </button>`;
}

const BUSY = new Set(['running', 'starting', 'queued']);
// Members of a group, backends first (the order "Start all" uses).
const groupItems = (g) => items.filter((i) => i.project?.group === g).sort((a, b) => (a.kind === 'backend' ? 0 : 1) - (b.kind === 'backend' ? 0 : 1));

// Named groups first (backends listed before frontends, matching start order), then ungrouped items by kind.
function renderTabs() {
  const named = [...new Set(items.map((i) => i.project?.group).filter(Boolean))];
  const groupHtml = named.map((g) => {
    const list = groupItems(g);
    const up = list.filter((i) => i.state === 'running').length;
    const any = list.some((i) => BUSY.has(i.state));
    const all = list.every((i) => BUSY.has(i.state));
    const arg = esc(JSON.stringify(g));
    return `
      <div class="ghead ${activeKey === 'g:' + g ? 'active' : ''}" title="Open the ${esc(g)} group" onclick="select(${esc(JSON.stringify('g:' + g))})">
        <span class="gname">${esc(g)}</span>
        <span class="gcount mono">${up}/${list.length}</span>
        ${all ? '' : `<span class="mini play-mini on" title="Start all" onclick="event.stopPropagation(); startGroup(${arg}, this)">▶</span>`}
        ${any ? `<span class="mini stop-mini on" title="Stop all" onclick="event.stopPropagation(); stopGroup(${arg}, this)">■</span>` : ''}
      </div>
      <div class="gbody">${list.map(tab).join('')}</div>`;
  }).join('');
  const kinds = [['frontend', 'FRONTEND', 'var(--fe)'], ['backend', 'BACKEND', 'var(--be)']];
  const loose = items.filter((i) => !i.project?.group);
  document.getElementById('tabs').innerHTML =
    `<button class="add ${activeKey === 'add' ? 'active' : ''}" onclick="openAdd()">+ Add project</button>` +
    groupHtml +
    kinds.map(([kind, title, color]) => {
      const list = loose.filter((i) => i.kind === kind);
      return list.length ? `<div class="group">${title} <i style="background:${color}"></i></div>${list.map(tab).join('')}` : '';
    }).join('');
}

// ---- Main view ----
const shortUrl = (url) => url.replace(/^https?:\/\//, '');

function header(i) {
  const a = i.app;
  const p = i.project;
  const m = mode[i.key] || 'main';
  const seg = p ? `
    <div class="seg">
      <button class="${m === 'main' ? 'on' : ''}" onclick="setMode('${i.key}','main')">${i.kind === 'backend' ? 'Console' : 'Preview'}</button>
      <button class="${m === 'logs' ? 'on' : ''}" onclick="setMode('${i.key}','logs')">Logs${p.logLive ? ' <i class="live-dot"></i>' : ''}</button>
    </div>` : '';
  const stopBtn = p
    ? `<button class="hbtn danger" onclick="stopProject('${p.id}', this)">${STOP_ICON}Stop</button>`
    : `<button class="hbtn danger" onclick="kill(${a.pid}, this)">${STOP_ICON}Stop</button>`;
  const saveBtn = !p && a.project ? `<button class="hbtn" onclick="saveApp(${a.port}, this)">+ Save</button>` : '';
  const more = p ? `<button class="hbtn icon" title="More" onclick="moreMenu(this, '${p.id}')">${MORE_ICON}</button>` : '';
  const sub = [a.project?.dir, a.title && a.title !== i.name ? a.title : null, `PID ${a.pid}`].filter(Boolean).map(esc).join(' · ');
  return `
    <div class="bar">
      <div class="ident">
        <div class="name">${esc(i.name)} <span class="kind ${cls(i)}">${i.kind.toUpperCase()} · ${esc(i.framework)}</span></div>
        <div class="meta mono" title="${sub}">${sub}</div>
      </div>
      ${seg}
      <div class="actions">
        ${openInHtml()}
        <a class="hbtn link ${cls(i)} mono" href="${a.url}" target="_blank" title="Open in a new tab">${shortUrl(a.url)} ↗</a>
        ${saveBtn}${stopBtn}${more}
      </div>
    </div>`;
}

function backendConsole(a) {
  const status = a.responding ? a.status : '—';
  const statusCls = !a.responding ? 'warn' : a.status < 500 ? 'ok' : 'warn';
  const endpoints = a.endpoints.length
    ? a.endpoints.map((e) => `
        <a class="ep mono" href="${a.url}${e.path}" target="_blank">
          <span class="m">GET</span><span class="p">${esc(e.path)}</span>
          <span class="t">${e.status} · ${esc(e.type.split(';')[0] || '—')}</span>
        </a>`).join('')
    : '<div class="note">No docs or health endpoint found on the usual paths (/api, /docs, /swagger, /health...)</div>';
  return `
    <div class="console">
      <div class="row">
        <div class="box"><h3>STATUS ON /</h3><div class="kv mono ${statusCls}">${status}</div></div>
        <div class="box"><h3>PORT</h3><div class="kv mono">${a.port}</div></div>
        <div class="box"><h3>FRAMEWORK</h3><div class="kv">${esc(a.framework)}</div></div>
        <div class="box"><h3>CONTENT-TYPE</h3><div class="kv mono" style="font-size:14px">${esc(a.contentType.split(';')[0] || '—')}</div></div>
      </div>
      <div class="box"><h3>RESPONDING ENDPOINTS</h3>${endpoints}</div>
      <div class="box"><h3>RESPONSE TO GET /</h3>${a.preview ? `<pre>${esc(a.preview)}</pre>` : '<div class="note">No response</div>'}</div>
    </div>`;
}

// A saved project that isn't listening yet: stopped, booting, or crashed.
function projectPanel(i) {
  const p = i.project;
  let main;
  if (p.missing) main = '<div class="note">This folder no longer exists or has no runnable script.</div>';
  else if (p.state === 'starting') main = '<div class="booting"><span class="spinner"></span> Starting... it will show up here as soon as its port opens.</div>';
  else if (p.state === 'queued') main = '<div class="booting"><span class="spinner"></span> Waiting for the group backend to come up first...</div>';
  else {
    const crashed = p.state === 'crashed'
      ? `<div class="crash">Exited before opening a port. The reason is usually in the log below.</div>` : '';
    main = `${crashed}<button class="play" onclick="startProject('${p.id}', this)">▶ Start</button>`;
  }
  return `
    <div class="bar">
      <div class="ident">
        <div class="name">${esc(p.name)} <span class="kind ${cls(i)}">${i.kind.toUpperCase()} · ${esc(i.framework)}</span></div>
        <div class="meta mono" title="${esc(p.dir)}">${STATE_TEXT[p.state]} · ${esc(p.dir)}</div>
      </div>
      <div class="actions">
        ${p.state === 'starting' || p.state === 'queued' ? `<button class="hbtn danger" onclick="stopProject('${p.id}', this)">${STOP_ICON}Cancel</button>` : ''}
        ${openInHtml()}
        <button class="hbtn icon" title="More" onclick="moreMenu(this, '${p.id}')">${MORE_ICON}</button>
      </div>
    </div>
    <div class="console">
      <div class="box">
        <h3>PROJECT</h3>
        <div class="kvline"><span>Folder</span><span class="mono">${esc(p.dir)}</span></div>
        <div class="kvline"><span>Command</span><span class="mono">${esc(p.command)}</span></div>
        <div class="kvline"><span>Group</span><span>${p.group ? esc(p.group) : '<span class="note">None</span>'}</span></div>
        ${p.lastPort ? `<div class="kvline"><span>Last port</span><span class="mono">:${p.lastPort}</span></div>` : ''}
        ${p.needsInstall ? '<div class="kvline"><span>node_modules</span><span class="warn-text">not installed, Mina will ask before starting</span></div>' : ''}
      </div>
      <div class="center">${main}</div>
      ${p.hasLog || p.state === 'starting' ? logBox(p, false) : ''}
    </div>`;
}

// The whole group on one page: every member with its state, and actions that apply to all of them.
function groupPanel(g) {
  const list = groupItems(g);
  const root = list[0]?.project.groupRoot;
  const up = list.filter((i) => i.state === 'running').length;
  const any = list.some((i) => BUSY.has(i.state));
  const all = list.every((i) => BUSY.has(i.state));
  const arg = esc(JSON.stringify(g));
  const rows = list.map((i) => {
    const p = i.project;
    const where = i.app ? `<span class="mono">:${i.app.port}</span>` : '';
    const link = i.app ? `<a class="hbtn link ${cls(i)} mono" href="${i.app.url}" target="_blank" title="Open in a new tab" onclick="event.stopPropagation()">${shortUrl(i.app.url)} ↗</a>` : '';
    const btn = BUSY.has(i.state)
      ? `<button class="hbtn danger" onclick="event.stopPropagation(); stopProject('${p.id}', this)">${STOP_ICON}${i.state === 'running' ? 'Stop' : 'Cancel'}</button>`
      : `<button class="hbtn go" onclick="event.stopPropagation(); startProject('${p.id}', this)">▶ Start</button>`;
    return `
      <div class="gm ${cls(i)}" onclick="select('${i.key}')" title="Open ${esc(p.name)}">
        <span class="badge">${ICON[i.kind]}</span>
        <span class="txt">
          <span class="nm">${esc(p.name)} <span class="kind ${cls(i)}">${i.kind.toUpperCase()} · ${esc(i.framework)}</span></span>
          <span class="sm mono">${esc(p.command)} · ${esc(p.dir)}</span>
        </span>
        <span class="gstate"><span class="dot ${i.state}"></span>${STATE_TEXT[i.state]} ${where}</span>
        ${link}${btn}
      </div>`;
  }).join('');
  return `
    <div class="bar">
      <div class="ident">
        <div class="name">${esc(g)} <span class="kind grp">GROUP · ${list.length} PROJECT${list.length > 1 ? 'S' : ''}</span></div>
        <div class="meta mono" title="${esc(root || '')}">${up} of ${list.length} running${root ? ` · ${esc(root)}` : ''}</div>
      </div>
      <div class="actions">
        ${openInHtml()}
        ${all ? '' : `<button class="hbtn go" onclick="startGroup(${arg}, this)">▶ Start all</button>`}
        ${any ? `<button class="hbtn danger" onclick="stopGroup(${arg}, this)">${STOP_ICON}Stop all</button>` : ''}
        <button class="hbtn icon" title="More" onclick="groupMenu(this, ${arg})">${MORE_ICON}</button>
      </div>
    </div>
    <div class="console">
      <div class="box">
        <h3>PROJECTS</h3>
        ${rows}
        <div class="note gnote">Start all brings the backends up first, then the frontends once the backends are listening.</div>
      </div>
    </div>`;
}

function addPanel() {
  const list = candidates.length ? `
    <div class="box">
      <h3>FOUND ${candidates.length} PROJECT${candidates.length > 1 ? 'S' : ''}</h3>
      ${candidates.map((c, n) => `
        <label class="cand">
          <input type="checkbox" data-n="${n}" ${c.added ? 'disabled' : 'checked'}>
          <span class="kind ${cls(c)}">${c.kind.toUpperCase()} · ${esc(c.framework)}</span>
          <span class="cname">${esc(c.name)}</span>
          <span class="mono cdir">${esc(c.dir)}</span>
          <span class="mono cdir">${esc(c.pm)} run ${esc(c.script)}</span>
          ${c.added ? '<span class="note">Already added</span>' : ''}
        </label>`).join('')}
      <button class="play" style="margin-top:14px" onclick="addSelected(this)">Add selected</button>
    </div>` : '';
  return `
    <div class="bar"><div class="ident"><div class="name">Add project</div>
      <div class="meta">Pick a project folder, or a folder that holds several (like frontend + backend).</div></div></div>
    <div class="console">
      <div class="box">
        <div class="pick">
          <button class="play" onclick="pickFolder(this)">📁 Browse...</button>
          <input id="dir" class="mono" placeholder="or paste a path: C:\\Users\\...\\my-project" onkeydown="if(event.key==='Enter') scanDir(this.nextElementSibling)">
          <button class="ghost" onclick="scanDir(this)">Scan</button>
        </div>
        <div class="note" id="scanMsg"></div>
      </div>
      ${list}
    </div>`;
}

function renderView() {
  stopLog();
  lastSig = viewSig();
  const view = document.getElementById('view');
  if (activeKey === 'add') { viewDir = null; view.innerHTML = addPanel(); return; }
  if (activeKey?.startsWith('g:')) {
    const g = activeKey.slice(2);
    viewDir = groupItems(g)[0]?.project.groupRoot || null;
    view.innerHTML = groupPanel(g);
    return;
  }
  const i = items.find((x) => x.key === activeKey);
  if (!i) {
    viewDir = null;
    view.innerHTML = '<div class="empty"><b>Nothing running</b>Start any project, or add one with "+ Add project".</div>';
    return;
  }
  viewDir = i.project?.dir || i.app?.project?.dir || null;
  if (!i.app) view.innerHTML = projectPanel(i);
  else if (i.project && mode[i.key] === 'logs') {
    view.innerHTML = header(i) + (i.project.hasLog
      ? `<div class="console">${logBox(i.project, true)}</div>`
      : '<div class="empty"><b>No logs for this project</b>Logs are only captured for projects started from Mina. If you started it from a terminal, its output is there.</div>');
  } else {
    view.innerHTML = header(i) + (i.kind === 'backend' ? backendConsole(i.app) : `<iframe src="${i.app.url}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"></iframe>`);
  }
  if (document.getElementById('log')) streamLog(i.project.id);
}

function select(key) {
  activeKey = key;
  renderTabs();
  renderView();
}
