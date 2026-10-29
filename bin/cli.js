#!/usr/bin/env node
// mina                      start the dashboard (or reuse a running one) and open it in the browser
// mina --port 4321          same, on another port
// mina --no-open            start without opening the browser (used by the startup entry)
// mina install-startup      start Mina hidden every time you log in
// mina uninstall-startup    undo install-startup
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { WIN, MAC, openUrl } = require('../platform');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
// "--port 4321" and "--port=4321" both work, and the port value is never mistaken for a command.
const portEq = args.find((a) => a.startsWith('--port='));
const portAt = args.indexOf('--port');
const portRaw = portEq ? portEq.slice('--port='.length) : portAt > -1 ? args[portAt + 1] : process.env.MINA_PORT;
const command = args.find((a, i) => !a.startsWith('-') && !(portAt > -1 && i === portAt + 1));
if (portAt > -1 && portRaw === undefined) fail('--port needs a value, for example: mina --port 4321');
if (portRaw !== undefined && portRaw !== '' && !(/^\d+$/.test(portRaw) && +portRaw >= 1 && +portRaw <= 65535)) {
  fail(`Invalid port: ${portRaw}. Use a number from 1 to 65535.`);
}
const PORT = Number(portRaw) || 4747;
const CLI = path.resolve(__filename);
// What the startup entry runs: this exact node and this exact script, so it works without a PATH lookup.
// The port is written in whenever it isn't the default, whether it came from --port or MINA_PORT.
const START_ARGS = [process.execPath, CLI, '--no-open', ...(PORT !== 4747 ? ['--port', String(PORT)] : [])];

function fail(message) {
  console.error(message);
  process.exit(1);
}

const HELP = `Mina: one dashboard for every local dev server.

Usage:
  mina                     start and open http://localhost:${PORT}
  mina --port <n>          use another port (or set MINA_PORT)
  mina --no-open           start without opening the browser
  mina install-startup     start Mina in the background when you log in
  mina uninstall-startup   remove that startup entry
  mina --version`;

// ---- Startup entry, one file per OS ----

const STARTUP = WIN
  ? path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'mina.vbs')
  : MAC
    ? path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.mina.plist')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'mina.desktop');

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Desktop Entry Exec quoting: inside quotes, " ` $ \ get a backslash; the key-file layer then needs every
// backslash doubled again, and a literal % written as %% (a lone % starts a field code like %f).
const desktopArg = (a) => `"${a.replace(/["`$\\]/g, '\\$&').replace(/\\/g, '\\\\').replace(/%/g, '%%')}"`;

function startupFile() {
  // VBScript: Run with window style 0 = no console window.
  if (WIN) return `CreateObject("WScript.Shell").Run "${START_ARGS.map((a) => `""${a}""`).join(' ')}", 0, False\r\n`;
  if (MAC) {
    const log = path.join(os.homedir(), '.mina', 'mina.log');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.mina</string>
  <key>ProgramArguments</key>
  <array>${START_ARGS.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || '')}</string></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
  }
  return `[Desktop Entry]
Type=Application
Name=Mina
Comment=Dashboard for local dev servers
Exec=${START_ARGS.map(desktopArg).join(' ')}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function installStartup() {
  fs.mkdirSync(path.dirname(STARTUP), { recursive: true });
  if (MAC) fs.mkdirSync(path.join(os.homedir(), '.mina'), { recursive: true });
  // Windows Script Host reads a .vbs in the ANSI code page unless it is UTF-16 with a BOM, which keeps
  // non-ASCII paths (an Arabic user name, say) intact.
  if (WIN) fs.writeFileSync(STARTUP, '﻿' + startupFile(), 'utf16le');
  else fs.writeFileSync(STARTUP, startupFile());
  // launchd only reads LaunchAgents at login; load it now so it also runs this session.
  if (MAC) try { execFileSync('launchctl', ['unload', STARTUP], { stdio: 'ignore' }); } catch {}
  if (MAC) try { execFileSync('launchctl', ['load', '-w', STARTUP], { stdio: 'ignore' }); } catch {}
  console.log(`Mina will start when you log in.\n  ${STARTUP}`);
}

function uninstallStartup() {
  if (!fs.existsSync(STARTUP)) return console.log('Mina is not set to start at login.');
  if (MAC) try { execFileSync('launchctl', ['unload', '-w', STARTUP], { stdio: 'ignore' }); } catch {}
  fs.unlinkSync(STARTUP);
  console.log('Removed. Mina will no longer start at login.');
}

// ---- Run ----

// A Mina already on this port answers its page with the Mina title; anything else there is a real conflict.
function minaRunning() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1500, headers: { Host: `localhost:${PORT}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(/<title>Mina\b/.test(body)));
      res.on('close', () => resolve(false)); // cut off mid-answer (a no-op after 'end')
    });
    // Hard deadline: whatever holds the port might send headers and then never finish. Not unref'd: once the
    // socket is destroyed this timer is all that keeps the process alive long enough to report the conflict.
    const timer = setTimeout(() => { req.destroy(); resolve(false); }, 3000);
    req.on('timeout', () => { clearTimeout(timer); req.destroy(); resolve(false); });
    req.on('error', () => { clearTimeout(timer); resolve(false); });
    req.on('close', () => clearTimeout(timer));
  });
}

async function run() {
  const url = `http://localhost:${PORT}`;
  if (await minaRunning()) {
    console.log(`Mina is already running on ${url}`);
    if (!flag('--no-open')) openUrl(url);
    return;
  }
  process.env.MINA_PORT = String(PORT);
  const { server } = require('../server');
  if (!flag('--no-open')) server.once('listening', () => openUrl(url));
}

if (flag('--help') || flag('-h')) console.log(HELP);
else if (flag('--version') || flag('-v')) console.log(require('../package.json').version);
else if (command === 'install-startup') installStartup();
else if (command === 'uninstall-startup') uninstallStartup();
else if (command) { console.error(`Unknown command: ${command}\n\n${HELP}`); process.exitCode = 1; }
else run();
