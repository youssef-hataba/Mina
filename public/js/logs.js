// ---- Logs ----
const mode = {}; // item key -> 'main' | 'logs'
let logAbort = null;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ERR_LINE = /error|failed|exception|ERR!|EADDRINUSE|cannot find|not found/i;
const WARN_LINE = /warn/i;

function logBox(p, tall) {
  const badge = p.logLive ? '<span class="live-badge">● LIVE</span>' : '<span class="old-badge">from last run</span>';
  return `
    <div class="logbox ${tall ? 'tall' : ''}">
      <div class="loghead"><span>LOGS</span>${badge}<span class="mono logpath" title="${esc(p.logFile)}">${esc(p.logFile)}</span>
        <button class="ghost small" onclick="document.getElementById('log').textContent=''">Clear</button></div>
      <pre id="log" class="log mono"><span class="note">No output yet...</span></pre>
    </div>`;
}

// Lines are coloured by what they say, not by stream: Go's log package, Python's logging and many servers write
// everything (startup messages included) to stderr. forceErr is for Mina's own error notes.
function appendLog(text, forceErr) {
  const el = document.getElementById('log');
  if (!el || !text) return;
  if (el.querySelector('.note')) el.textContent = '';
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const line of text.replace(ANSI, '').replace(/\r/g, '').split('\n')) {
    if (!line.trim()) continue;
    const span = document.createElement('span');
    span.className = forceErr ? 'l-err' : WARN_LINE.test(line) ? 'l-warn' : ERR_LINE.test(line) ? 'l-err' : '';
    span.textContent = line + '\n';
    frag.appendChild(span);
  }
  el.appendChild(frag);
  while (el.childNodes.length > 2000) el.removeChild(el.firstChild);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function stopLog() {
  logAbort?.abort();
  logAbort = null;
}

// Reads the newline-delimited JSON stream until the view changes.
async function streamLog(id) {
  stopLog();
  const ctrl = new AbortController();
  logAbort = ctrl;
  try {
    const res = await fetch('/api/projects/logs/stream', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        appendLog(msg.out, false);
        appendLog(msg.err, false);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') appendLog('Log stream disconnected: ' + e.message, true);
  }
}

function setMode(key, m) {
  mode[key] = m;
  renderView();
}
