// Starting and stopping non-JS projects through Mina, for real: Django, Laravel, Rails, Go, Rust and .NET.
// Django, Laravel and Rails use small stand-ins for manage.py / artisan / bin/rails (no framework install needed,
// same command line and process tree); Go, Rust and .NET build and run a real program. Each test is skipped
// where its toolchain isn't installed; CI installs all of them.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('../helpers');

let mina;
let root;
before(async () => {
  root = h.tmpDir('rt');
  mina = await h.startMina();
});
after(async () => {
  await h.stopAllProjects(mina);
  await mina?.stop();
  h.rmQuiet(root);
  h.rmQuiet(mina?.home);
});

const PY = h.WIN ? 'python' : 'python3';
function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    if (content === null) fs.mkdirSync(path.join(dir, rel), { recursive: true });
    else fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

// .NET needs a target framework the installed SDK can build.
function dotnetTfm() {
  const r = spawnSync('dotnet', ['--version'], { encoding: 'utf8', shell: h.WIN });
  const major = r.status === 0 && Number(String(r.stdout).trim().split('.')[0]);
  return major >= 6 ? `net${major}.0` : null;
}

const CASES = [
  {
    name: 'Django', runner: 'django', tool: [PY, ['--version']], command: `${PY} manage.py runserver`, kind: 'frontend',
    files: (port) => ({
      'manage.py': `# Stand-in for Django's manage.py: same "python manage.py runserver" command line, serves one page.
import sys, socketserver, http.server
if sys.argv[1:2] == ['runserver']:
    class Page(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'<title>django fixture</title>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    print('Starting development server', flush=True)
    socketserver.TCPServer(('127.0.0.1', ${port}), Page).serve_forever()
`,
    }),
    log: /Starting development server/,
  },
  {
    name: 'Laravel', runner: 'laravel', tool: ['php', ['-v']], command: 'php artisan serve', kind: 'frontend',
    // artisan serve runs a child "php -S", like the real one.
    files: (port) => ({
      artisan: `<?php
if (($argv[1] ?? '') === 'serve') {
    echo "INFO  Server running on [http://127.0.0.1:${port}].\\n";
    passthru(escapeshellarg(PHP_BINARY) . ' -S 127.0.0.1:${port} -t public');
}
`,
      'composer.json': '{"name":"acme/laravel-fixture"}',
      'vendor/autoload.php': '<?php',
      'public/index.php': '<?php header("Content-Type: text/html"); echo "<title>laravel fixture</title>";',
    }),
    log: /Server running/,
    project: 'laravel-fixture',
  },
  {
    name: 'Rails', runner: 'rails', tool: ['ruby', ['-v']], command: 'ruby bin/rails server', kind: 'frontend',
    files: (port) => ({
      Gemfile: "source 'https://rubygems.org'\n",
      'bin/rails': `# Stand-in for bin/rails: same "ruby bin/rails server" command line, serves one page.
require 'socket'
if ARGV[0] == 'server'
  $stdout.sync = true
  puts 'Puma starting in single mode...'
  server = TCPServer.new('127.0.0.1', ${port})
  loop do
    c = server.accept
    while (line = c.gets) && line != "\\r\\n"; end
    body = '<title>rails fixture</title>'
    c.print "HTTP/1.1 200 OK\\r\\nContent-Type: text/html\\r\\nContent-Length: #{body.bytesize}\\r\\nConnection: close\\r\\n\\r\\n#{body}"
    c.close
  end
end
`,
    }),
    log: /Puma starting/,
  },
  {
    name: 'Go', runner: 'go', tool: ['go', ['version']], command: 'go run .', kind: 'backend', timeout: 300000,
    files: (port) => ({
      'go.mod': 'module example.com/mina/go-fixture\n\ngo 1.20\n',
      'main.go': `package main

import (
\t"fmt"
\t"net/http"
)

func main() {
\thttp.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
\t\tw.Header().Set("Content-Type", "application/json")
\t\tw.Write([]byte(\`{"ok":true}\`))
\t})
\tfmt.Println("go fixture listening")
\thttp.ListenAndServe("127.0.0.1:${port}", nil)
}
`,
    }),
    log: /go fixture listening/,
    project: 'go-fixture',
    compiled: true,
  },
  {
    name: 'Rust', runner: 'rust', tool: ['cargo', ['--version']], command: 'cargo run', kind: 'backend', timeout: 300000,
    files: (port) => ({
      'Cargo.toml': '[package]\nname = "rust-fixture"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      'src/main.rs': `use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    let listener = TcpListener::bind("127.0.0.1:${port}").unwrap();
    println!("rust fixture listening");
    for stream in listener.incoming() {
        let mut s = match stream { Ok(s) => s, Err(_) => continue };
        let mut buf = [0u8; 4096];
        let _ = s.read(&mut buf);
        let _ = s.write_all(b"HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n{}");
    }
}
`,
    }),
    log: /rust fixture listening/,
    project: 'rust-fixture',
    compiled: true,
  },
  {
    name: '.NET', runner: 'dotnet', tool: ['dotnet', ['--version']], command: 'dotnet run', kind: 'backend', timeout: 300000,
    available: () => !!dotnetTfm(),
    files: (port) => ({
      'DotnetFixture.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${dotnetTfm()}</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
`,
      'Program.cs': `using System.Net;
using System.Net.Sockets;
using System.Text;

var listener = new TcpListener(IPAddress.Loopback, ${port});
listener.Start();
Console.WriteLine("dotnet fixture listening");
while (true)
{
    using var client = listener.AcceptTcpClient();
    var stream = client.GetStream();
    var buf = new byte[4096];
    stream.Read(buf, 0, buf.Length);
    var answer = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n{}");
    stream.Write(answer, 0, answer.Length);
}
`,
    }),
    log: /dotnet fixture listening/,
    project: 'DotnetFixture',
    compiled: true,
  },
];

const project = async (name) => (await mina.apps()).projects.find((p) => p.name === name);

describe('non-JS projects: add → start → running → logs → stop', () => {
  for (const c of CASES) {
    test(c.name, { timeout: c.timeout || 120000 }, async (t) => {
      if (!h.has(...c.tool) || (c.available && !c.available())) return t.skip(`${c.tool[0]} is not installed`);
      const port = await h.freePort();
      const dir = write(path.join(root, c.runner), c.files(port));
      const name = c.project || c.runner;

      // Offered by a scan with the right label and command.
      const { candidates } = await mina.api('/api/projects/scan', { dir });
      assert.equal(candidates.length, 1, JSON.stringify(candidates));
      assert.equal(candidates[0].framework, c.name);
      assert.equal(candidates[0].command, c.command);

      await mina.api('/api/projects/add', { dirs: [dir] });
      const saved = await project(name);
      assert.ok(saved, `saved as ${name}`);
      assert.equal(saved.command, c.command);
      assert.equal(saved.needsInstall, false);

      assert.deepEqual(await mina.api('/api/projects/start', { id: saved.id }), { ok: true });
      const tail = (f) => { try { return fs.readFileSync(f, 'utf8').slice(-1500); } catch { return '(none)'; } };
      const running = await h.waitFor(async () => {
        const p = await project(name);
        if (p?.state === 'crashed') throw new Error(`crashed:\n${tail(p.logFile.replace(/\.log$/, '.err.log'))}`);
        return p?.state === 'running' && p;
      }, { timeout: (c.timeout || 120000) - 20000, interval: 1500, what: `${c.name} to run` }).catch(async (e) => {
        // Everything needed to tell "never listened" from "listening but not linked to the project".
        const { apps, projects: list } = await mina.apps(true);
        const p = list.find((x) => x.name === name);
        const onPort = apps.find((a) => a.port === port);
        throw new Error(`${e.message}\nstate: ${p?.state}\nport ${port} open: ${await h.portOpen(port)}\n`
          + `app on port: ${JSON.stringify(onPort && { process: onPort.process, project: onPort.project, framework: onPort.framework })}\n`
          + `stdout:\n${tail(p.logFile)}\nstderr:\n${tail(p.logFile.replace(/\.log$/, '.err.log'))}`);
      });
      assert.equal(running.port, port);
      assert.equal(running.framework, c.name);
      assert.equal(running.logLive, true);

      // Listed as an app by default, even when the binary isn't named after a known runtime (Go, Rust, .NET).
      const app = (await mina.apps()).apps.find((a) => a.port === port);
      assert.ok(app, 'listed without "show everything"');
      assert.equal(app.framework, c.name);
      assert.equal(app.kind, c.kind);
      assert.equal(app.project.name, name);
      assert.match(fs.readFileSync(running.logFile, 'utf8'), c.log);

      assert.deepEqual(await mina.api('/api/projects/stop', { id: saved.id }), { ok: true });
      await h.waitFor(async () => !(await h.portOpen(port)), { timeout: 20000, what: 'port to close' });
      await h.waitFor(async () => (await project(name))?.state === 'stopped', { timeout: 15000, what: 'stopped' });
    });
  }
});

describe('install step', () => {
  test('a Laravel app without vendor/ asks for composer install before starting', async () => {
    const dir = write(path.join(root, 'lv-fresh'), { artisan: '<?php', 'composer.json': '{"name":"acme/lv-fresh"}' });
    await mina.api('/api/projects/add', { dirs: [dir] });
    const p = await project('lv-fresh');
    assert.equal(p.installCommand, 'composer install');
    assert.deepEqual(await mina.api('/api/projects/start', { id: p.id }), { needsInstall: true });
    assert.equal((await project('lv-fresh')).state, 'stopped');
  });
});

describe('servers started from a terminal', () => {
  test('a Django dev server started by hand is recognised as Django (macOS/Linux: from its working directory)', async (t) => {
    if (h.WIN) return t.skip('Windows does not expose a process\'s working directory; a relative "manage.py" can\'t be traced');
    if (!h.has(PY, ['--version'])) return t.skip('python is not installed');
    const port = await h.freePort();
    const dir = write(path.join(root, 'dj-terminal'), CASES[0].files(port));
    const child = require('child_process').spawn(PY, ['manage.py', 'runserver'], { cwd: dir, stdio: 'ignore' });
    try {
      await h.waitFor(() => h.portOpen(port), { what: 'django fixture' });
      const app = (await mina.apps()).apps.find((a) => a.port === port);
      assert.ok(app);
      assert.equal(app.framework, 'Django');
      assert.equal(app.project.name, 'dj-terminal');
    } finally { h.killQuiet(child); }
  });
});
