// Everything that differs between Windows and macOS/Linux: listing listening ports, launching and
// killing process trees, the native folder picker, and opening a URL in the browser.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// stdout even when the tool exits non-zero: lsof returns 1 whenever some process could not be inspected.
const output = (cmd, args, opts = {}) => new Promise((resolve) =>
  execFile(cmd, args, { maxBuffer: 1 << 24, ...opts }, (err, stdout) => resolve(String(stdout || ''))));

// ---- Listening ports: [{ port, pid, name, cmd, cwd, chain }] ----

function listListenersWin() {
  const ps = `
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $c = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Sort-Object LocalPort -Unique
    # One process query for all listeners; a query per port was the slow part of every refresh.
    $procs = @{}
    Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }
    $out = foreach ($x in $c) {
      $p = $procs[[int]$x.OwningProcess]
      # Ancestor PIDs, so a server we launched is traced back to its project even with a relative command line.
      $chain = @(); $cur = [int]$x.OwningProcess
      for ($i = 0; $i -lt 12; $i++) {
        $pp = $procs[$cur].ParentProcessId
        if (-not $pp -or $chain -contains [int]$pp) { break }
        $chain += [int]$pp; $cur = [int]$pp
      }
      [pscustomobject]@{ port = $x.LocalPort; pid = $x.OwningProcess; name = $p.Name; cmd = $p.CommandLine; chain = $chain }
    }
    $out | ConvertTo-Json -Compress`;
  return output('powershell', ['-NoProfile', '-Command', ps]).then((stdout) => {
    try {
      const data = JSON.parse(stdout || '[]');
      return Array.isArray(data) ? data : [data];
    } catch { return []; }
  });
}

// "pid ppid rest-of-line" for every process.
async function psTable(column) {
  const rows = new Map();
  for (const line of (await output('ps', ['-A', '-o', `pid=,ppid=,${column}=`])).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), value: m[3].trim() });
  }
  return rows;
}

// Linux reads the kernel's view directly; macOS asks lsof once for every listener's working directory.
async function cwds(pids) {
  const out = new Map();
  if (!pids.length) return out;
  if (!MAC) {
    for (const pid of pids) try { out.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`)); } catch {}
    return out;
  }
  let pid = 0;
  for (const line of (await output('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')])).split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1));
  }
  return out;
}

// The real executable: Next.js and others rename their process title ("next-server (v15)"), which hides "node".
function exeOf(pid, comm) {
  if (!MAC) try { return path.basename(fs.readlinkSync(`/proc/${pid}/exe`)); } catch {}
  return path.basename(comm || '');
}

async function listListenersPosix() {
  const byPort = new Map();
  let pid = 0;
  for (const line of (await output('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'])).split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    const m = line[0] === 'n' && line.match(/:(\d+)$/);
    if (m && pid && !byPort.has(Number(m[1]))) byPort.set(Number(m[1]), pid);
  }
  const [comm, command] = await Promise.all([psTable('comm'), psTable('command')]);
  const dirs = await cwds([...new Set(byPort.values())]);
  return [...byPort].sort((a, b) => a[0] - b[0]).map(([port, pid]) => {
    const chain = [];
    for (let cur = pid, i = 0; i < 12; i++) {
      const pp = command.get(cur)?.ppid;
      if (!pp || chain.includes(pp)) break;
      chain.push(pp);
      cur = pp;
    }
    return { port, pid, name: exeOf(pid, comm.get(pid)?.value), cmd: command.get(pid)?.value || '', cwd: dirs.get(pid) || null, chain };
  });
}

const listListeners = WIN ? listListenersWin : listListenersPosix;

// ---- Launching a shell command in the background, output to log files; resolves with the PID ----

// Windows goes through Start-Process: a detached Node child loses its grandchildren's output there,
// while Start-Process redirects properly and the server keeps running if the dashboard closes.
// Paths travel as env vars so quotes or Arabic in folder names can't break the command.
// cmd itself redirects the output (to env-var paths, so & % ^ in them stay literal), and the working directory is
// wildcard-escaped: Start-Process treats [ ] in a path as a pattern and would refuse a folder like "app[1]".
// The pid file holds "pid startTime": a PID alone can be recycled by an unrelated process later.
function launchWin({ command, dir, out, err, pidFile, env }) {
  // The PID goes to a file, not stdout: the dev server inherits PowerShell's handles, so a stdout pipe
  // would stay open (and keep us waiting) for as long as the server runs.
  const ps = `
    $p = Start-Process cmd.exe -ArgumentList $env:MINA_CMD -WindowStyle Hidden -PassThru \`
      -WorkingDirectory ([Management.Automation.WildcardPattern]::Escape($env:MINA_DIR))
    Set-Content -LiteralPath $env:MINA_PID -Value ("{0} {1}" -f $p.Id, ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds())`;
  try { fs.unlinkSync(pidFile); } catch {}
  if (!fs.existsSync(dir)) return Promise.reject(new Error(`folder not found: ${dir}`));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...env, MINA_CMD: `/d /c (${command}) 1>"%MINA_OUT%" 2>"%MINA_ERR%"`, MINA_DIR: dir, MINA_OUT: out, MINA_ERR: err, MINA_PID: pidFile },
    });
    child.on('error', reject);
    child.on('exit', () => {
      let pid = 0;
      try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/)[0]); } catch {}
      pid ? resolve(pid) : reject(new Error('could not start'));
    });
  });
}

// detached = its own session and process group, so it outlives the dashboard and the group can be killed as one.
async function launchPosix({ command, dir, out, err, pidFile, env }) {
  if (!fs.existsSync(dir)) throw new Error(`folder not found: ${dir}`);
  const o = fs.openSync(out, 'w');
  const e = fs.openSync(err, 'w');
  let child;
  try {
    child = spawn('/bin/sh', ['-c', command], { cwd: dir, detached: true, stdio: ['ignore', o, e], env });
    // spawn reports a bad cwd or missing shell as an 'error' event; without a listener it would crash Mina.
    child.on('error', () => {});
  } finally {
    fs.closeSync(o);
    fs.closeSync(e);
  }
  if (!child.pid) throw new Error('could not start');
  child.unref();
  const start = (await startTimes([child.pid])).get(child.pid) || 0;
  fs.writeFileSync(pidFile, `${child.pid} ${start}`);
  return child.pid;
}

// ---- Process start times (ms since epoch), to tell a live process from a recycled PID ----

async function startTimes(pids) {
  const out = new Map();
  pids = [...new Set(pids.map(Number).filter((p) => p > 0))];
  if (!pids.length) return out;
  if (WIN) {
    const ps = `foreach ($id in @(${pids.join(',')})) { try { $p = Get-Process -Id $id -ErrorAction Stop; "{0} {1}" -f $id, ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } catch {} }`;
    for (const line of (await output('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true })).split(/\r?\n/)) {
      const [pid, ms] = line.trim().split(/\s+/).map(Number);
      if (pid && ms) out.set(pid, ms);
    }
    return out;
  }
  if (!MAC) {
    // Linux: field 22 of /proc/<pid>/stat is the start in clock ticks after boot (USER_HZ, 100 on every mainstream kernel).
    let btime = 0;
    try { btime = Number(fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m)[1]); } catch { return out; }
    for (const pid of pids) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
        out.set(pid, Math.round((btime + ticks / 100) * 1000));
      } catch {}
    }
    return out;
  }
  // macOS: "ps -o lstart" gives a local timestamp with one-second precision.
  for (const line of (await output('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')])).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    const ms = m && Date.parse(m[2].trim());
    if (ms) out.set(Number(m[1]), ms);
  }
  return out;
}

// Same process if the start times agree (macOS only has whole seconds; Linux ticks are 10 ms).
const sameStart = (a, b) => !!a && !!b && Math.abs(a - b) <= (MAC ? 1500 : 1000);

const launch = WIN ? launchWin : launchPosix;

// ---- Stopping a process and everything it started (cmd/sh -> npm -> node) ----

function killTreeWin(pid) {
  return new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve()));
}

// Our launches lead their own process group, so -pid takes the whole tree; anything else (a server started
// from a terminal) gets a plain kill. SIGTERM first so servers can clean up, SIGKILL if they hang on.
async function killTreePosix(pid) {
  const signal = (s) => {
    try { process.kill(-pid, s); return true; } catch {}
    try { process.kill(pid, s); return true; } catch { return false; }
  };
  if (!signal('SIGTERM')) return;
  for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(150);
  if (isAlive(pid)) signal('SIGKILL');
}

const killTree = WIN ? killTreeWin : killTreePosix;

// ---- Native "choose a folder" dialog; resolves with the path or null ----

// The modern Explorer "Select folder" window (IFileOpenDialog with FOS_PICKFOLDERS); WinForms only offers the old tree dialog.
const PICKER_CS = `
using System;
using System.Runtime.InteropServices;
public static class MinaPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr hwnd);
    void SetFileTypes(uint c, IntPtr s);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr e, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint o);
    void GetOptions(out uint o);
    void SetDefaultFolder(IShellItem i);
    void SetFolder(IShellItem i);
    void GetFolder(out IShellItem i);
    void GetCurrentSelection(out IShellItem i);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem i);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem p);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

  public static string Pick(IntPtr owner, string start) {
    var d = (IFileOpenDialog)new FileOpenDialog();
    uint o; d.GetOptions(out o);
    d.SetOptions(o | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    d.SetTitle("Mina - choose a project folder");
    d.SetOkButtonLabel("Select folder");
    if (!string.IsNullOrEmpty(start)) {
      try { IShellItem f; SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out f); d.SetFolder(f); } catch {}
    }
    if (d.Show(owner) != 0) return null;
    IShellItem r; d.GetResult(out r);
    string p; r.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
    return p;
  }
}`;

// The C# and the start folder travel as env vars, so nothing in them needs quoting. A hidden topmost form
// owns the dialog so it appears in front of the browser instead of behind it.
function pickFolderWin(start) {
  const ps = `
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -TypeDefinition $env:MINA_CS
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen' }
    $owner.Show(); $owner.Activate()
    $picked = [MinaPicker]::Pick($owner.Handle, $env:MINA_START)
    $owner.Close()
    if ($picked) { $picked }`;
  return output('powershell', ['-NoProfile', '-STA', '-Command', ps], { env: { ...process.env, MINA_CS: PICKER_CS, MINA_START: start } });
}

// The start folder is passed as an argument (argv), never spliced into the script.
function pickFolderMac(start) {
  const script = [
    'on run argv',
    'try',
    'return POSIX path of (choose folder with prompt "Mina - choose a project folder" default location (POSIX file (item 1 of argv)))',
    'on error',
    'return ""',
    'end try',
    'end run',
  ];
  return output('osascript', [...script.flatMap((l) => ['-e', l]), start]);
}

// zenity (GNOME and most others), then kdialog (KDE). Without either the user types the path instead.
async function pickFolderLinux(start) {
  const z = await new Promise((resolve) => execFile('zenity', ['--file-selection', '--directory', '--title=Mina - choose a project folder',
    `--filename=${start}${path.sep}`], (err, stdout) => resolve(err?.code === 'ENOENT' ? null : String(stdout || ''))));
  if (z !== null) return z;
  return output('kdialog', ['--getexistingdirectory', start, '--title', 'Mina - choose a project folder']);
}

async function pickFolder(start) {
  const picked = (await (WIN ? pickFolderWin : MAC ? pickFolderMac : pickFolderLinux)(start)).trim();
  // Finder answers "/Users/me/app/"; keep the trailing slash out of saved paths.
  return picked ? picked.replace(/(.)[\\/]$/, '$1') : null;
}

// ---- Browser ----

function openUrl(url) {
  const [cmd, args] = WIN ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : [MAC ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

module.exports = { WIN, MAC, listListeners, launch, killTree, pickFolder, openUrl, isAlive, startTimes, sameStart };
