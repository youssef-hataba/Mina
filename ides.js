// Editors installed on this machine, and opening a project folder in one of them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WIN, MAC } = require('./platform');

const LOCAL = process.env.LOCALAPPDATA || '';
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

// win: exe paths (first existing wins; per-user installs under LOCALAPPDATA\Programs are the default for most),
// mac: app bundle names, bin: launcher commands on Linux.
const KNOWN = [
  { id: 'vscode', name: 'VS Code', win: [`${LOCAL}\\Programs\\Microsoft VS Code\\Code.exe`, `${PF}\\Microsoft VS Code\\Code.exe`], mac: ['Visual Studio Code'], bin: ['code'] },
  { id: 'vscode-insiders', name: 'VS Code Insiders', win: [`${LOCAL}\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe`], mac: ['Visual Studio Code - Insiders'], bin: ['code-insiders'] },
  { id: 'cursor', name: 'Cursor', win: [`${LOCAL}\\Programs\\cursor\\Cursor.exe`], mac: ['Cursor'], bin: ['cursor'] },
  { id: 'windsurf', name: 'Windsurf', win: [`${LOCAL}\\Programs\\Windsurf\\Windsurf.exe`], mac: ['Windsurf'], bin: ['windsurf'] },
  { id: 'antigravity', name: 'Antigravity', win: [`${LOCAL}\\Programs\\Antigravity\\Antigravity.exe`], mac: ['Antigravity'], bin: ['antigravity'] },
  { id: 'antigravity-ide', name: 'Antigravity IDE', win: [`${LOCAL}\\Programs\\Antigravity IDE\\Antigravity IDE.exe`], mac: [], bin: [] },
  { id: 'zed', name: 'Zed', win: [`${LOCAL}\\Programs\\Zed\\Zed.exe`], mac: ['Zed'], bin: ['zed', 'zeditor'] },
  { id: 'sublime', name: 'Sublime Text', win: [`${PF}\\Sublime Text\\sublime_text.exe`, `${PF}\\Sublime Text 3\\sublime_text.exe`], mac: ['Sublime Text'], bin: ['subl'] },
  { id: 'notepadpp', name: 'Notepad++', win: [`${PF}\\Notepad++\\notepad++.exe`, `${PF86}\\Notepad++\\notepad++.exe`], mac: [], bin: [] },
  // JetBrains on Windows lives in versioned folders and is found by jetbrainsWin() instead.
  { id: 'webstorm64', name: 'WebStorm', win: [], mac: ['WebStorm'], bin: ['webstorm'] },
  { id: 'idea64', name: 'IntelliJ IDEA', win: [], mac: ['IntelliJ IDEA', 'IntelliJ IDEA CE'], bin: ['idea'] },
  { id: 'pycharm64', name: 'PyCharm', win: [], mac: ['PyCharm', 'PyCharm CE'], bin: ['pycharm'] },
  { id: 'phpstorm64', name: 'PhpStorm', win: [], mac: ['PhpStorm'], bin: ['phpstorm'] },
  { id: 'rider64', name: 'Rider', win: [], mac: ['Rider'], bin: ['rider'] },
  { id: 'goland64', name: 'GoLand', win: [], mac: ['GoLand'], bin: ['goland'] },
];

const JETBRAINS = { webstorm64: 'WebStorm', idea64: 'IntelliJ IDEA', pycharm64: 'PyCharm', phpstorm64: 'PhpStorm', rider64: 'Rider', goland64: 'GoLand' };

// JetBrains installs into versioned folders ("WebStorm 2025.2"), so look inside them.
function jetbrainsWin() {
  const found = [];
  for (const root of [`${PF}\\JetBrains`, `${LOCAL}\\Programs`]) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)); } catch { continue; }
    for (const dir of dirs) {
      for (const [exe, name] of Object.entries(JETBRAINS)) {
        const full = path.join(dir, 'bin', `${exe}.exe`);
        if (fs.existsSync(full) && !found.some((f) => f.id === exe)) found.push({ id: exe, name, exe: full });
      }
    }
  }
  return found;
}

const MAC_APP_DIRS = ['/Applications', path.join(os.homedir(), 'Applications')];
const macApp = (names) => names.flatMap((n) => MAC_APP_DIRS.map((d) => path.join(d, `${n}.app`))).find((p) => fs.existsSync(p));
const onPath = (bins) => bins.flatMap((b) => (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, b))).find((p) => fs.existsSync(p));

// The file manager always comes last; its id stays "explorer" on every OS (the page treats it specially).
function detect() {
  if (WIN) {
    const list = KNOWN.map((k) => ({ ...k, exe: k.win.find((p) => fs.existsSync(p)) })).filter((k) => k.exe);
    return [...list.map(({ id, name, exe }) => ({ id, name, exe })), ...jetbrainsWin(), { id: 'explorer', name: 'File Explorer', exe: 'explorer.exe' }];
  }
  const list = KNOWN.map((k) => ({ id: k.id, name: k.name, exe: MAC ? macApp(k.mac) : onPath(k.bin) })).filter((k) => k.exe);
  return [...list, { id: 'explorer', name: MAC ? 'Finder' : 'File Manager', exe: MAC ? 'open' : 'xdg-open' }];
}

// If Mina itself was started from inside VS Code (a terminal or extension), it inherits ELECTRON_RUN_AS_NODE=1,
// which makes VS Code / Cursor / Antigravity run as plain Node and exit without opening a window.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('VSCODE_')) delete env[k];
  return env;
}

function open(ideId, dir) {
  const ide = detect().find((i) => i.id === ideId);
  if (!ide) return false;
  // macOS apps open through "open -a <bundle>"; Finder is plain "open <dir>".
  const [cmd, args] = MAC && ide.id !== 'explorer' ? ['open', ['-a', ide.exe, dir]] : [ide.exe, [dir]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, env: cleanEnv() }).on('error', () => {}).unref();
  return true;
}

module.exports = { detect, open, cleanEnv };
