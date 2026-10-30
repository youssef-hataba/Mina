// runners.js: recognising Django, Laravel, Rails, Go, Rust and .NET folders, and the exact command each gets.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('../helpers');

const HOME = h.tmpDir('runners-home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const runners = require('../../runners');
const projects = require('../../projects');

let root;
before(() => { root = h.tmpDir('runners'); });
after(() => { h.rmQuiet(root); h.rmQuiet(HOME); });

// A folder with the given files ({ 'relative/path': 'content' }).
function folder(name, files) {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    if (content === null) fs.mkdirSync(path.join(dir, rel), { recursive: true });
    else fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const PY = h.WIN ? 'python' : 'python3';

describe('Django', () => {
  test('manage.py that mentions Django → python manage.py runserver', () => {
    const d = runners.detect(folder('dj', { 'manage.py': "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'site.settings')\nfrom django.core.management import execute_from_command_line" }));
    assert.equal(d.runner, 'django');
    assert.equal(d.framework, 'Django');
    assert.equal(d.kind, 'backend');
    assert.equal(d.command, `${PY} manage.py runserver`);
    assert.equal(d.install, null);
    assert.equal(d.name, 'dj');
  });

  test('the project\'s own virtualenv is used when there is one (.venv before venv before env)', () => {
    const exe = (v) => (h.WIN ? `${v}\\Scripts\\python.exe` : `${v}/bin/python`);
    const manage = 'import django';
    const both = folder('dj-venv', { 'manage.py': manage, [exe('venv').replace(/\\/g, '/')]: '', [exe('.venv').replace(/\\/g, '/')]: '' });
    assert.equal(runners.detect(both).command, `${exe('.venv')} manage.py runserver`);
    const env = folder('dj-env', { 'manage.py': manage, [exe('env').replace(/\\/g, '/')]: '' });
    assert.equal(runners.detect(env).command, `${exe('env')} manage.py runserver`);
  });

  test('a manage.py that is not Django is not taken for Django', () => {
    assert.equal(runners.detect(folder('not-dj', { 'manage.py': 'print("my own tool")' })), null);
  });
});

describe('Laravel', () => {
  test('artisan + composer.json → php artisan serve, named after the composer package', () => {
    const d = runners.detect(folder('lv', { artisan: '<?php', 'composer.json': '{"name":"acme/shop"}', 'vendor/autoload.php': '' }));
    assert.equal(d.runner, 'laravel');
    assert.equal(d.framework, 'Laravel');
    assert.equal(d.command, 'php artisan serve');
    assert.equal(d.name, 'shop');
    assert.equal(d.install, null);
  });

  test('without vendor/ Mina offers composer install', () => {
    const d = runners.detect(folder('lv-fresh', { artisan: '<?php', 'composer.json': '{}' }));
    assert.equal(d.install, 'composer install');
    assert.equal(d.installWhat, 'vendor');
  });

  test('its package.json (Vite for assets) does not turn it into a Node project', () => {
    const d = runners.detect(folder('lv-vite', { artisan: '<?php', 'composer.json': '{}', 'package.json': '{"scripts":{"dev":"vite"},"devDependencies":{"vite":"*"}}' }));
    assert.equal(d.runner, 'laravel');
  });
});

describe('Rails', () => {
  test('Gemfile + bin/rails → ruby bin/rails server (works on Windows too)', () => {
    const d = runners.detect(folder('rb', { Gemfile: "gem 'rails'", 'bin/rails': '#!/usr/bin/env ruby' }));
    assert.equal(d.runner, 'rails');
    assert.equal(d.command, 'ruby bin/rails server');
  });

  test('a Gemfile alone (a Ruby library) is not a Rails app', () => {
    assert.equal(runners.detect(folder('gem-only', { Gemfile: "gem 'rake'" })), null);
  });
});

describe('Go', () => {
  test('go.mod → go run ., named after the last part of the module path', () => {
    const d = runners.detect(folder('goapp', { 'go.mod': 'module github.com/acme/billing-api\n\ngo 1.22\n' }));
    assert.equal(d.runner, 'go');
    assert.equal(d.command, 'go run .');
    assert.equal(d.name, 'billing-api');
  });

  test('a runnable package.json next to go.mod wins (the Go file is usually tooling there)', () => {
    const d = runners.detect(folder('go-and-node', { 'go.mod': 'module x', 'package.json': '{"scripts":{"dev":"vite"}}' }));
    assert.equal(d.runner, 'node');
  });
});

describe('Rust', () => {
  test('Cargo.toml with [package] → cargo run, named from the manifest', () => {
    const d = runners.detect(folder('rs', { 'Cargo.toml': '[package]\nname = "edge-proxy"\nversion = "0.1.0"\n\n[dependencies]\nname_like = "1"\n' }));
    assert.equal(d.runner, 'rust');
    assert.equal(d.command, 'cargo run');
    assert.equal(d.name, 'edge-proxy');
  });

  test('a workspace root without [package] is not runnable itself; its members are', () => {
    const ws = folder('rs-ws', { 'Cargo.toml': '[workspace]\nmembers = ["api"]\n', 'api/Cargo.toml': '[package]\nname = "api"\n' });
    assert.equal(runners.detect(ws), null);
    assert.deepEqual(projects.scan(ws).map((p) => p.name), ['api']);
  });
});

describe('.NET', () => {
  test('one .csproj → dotnet run', () => {
    const d = runners.detect(folder('net', { 'Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"/>' }));
    assert.equal(d.runner, 'dotnet');
    assert.equal(d.command, 'dotnet run');
    assert.equal(d.name, 'Api');
  });

  test('several .csproj → the first safely named one is passed with --project', () => {
    const d = runners.detect(folder('net-multi', { 'a&b.csproj': '', 'Web.csproj': '', 'Zed.csproj': '' }));
    assert.equal(d.command, 'dotnet run --project Web.csproj');
  });

  test('several .csproj with unsafe names only → not runnable (never put into a command)', () => {
    assert.equal(runners.detect(folder('net-unsafe', { 'a&b.csproj': '', 'c;d.csproj': '' })), null);
  });

  test('a single unsafely named .csproj is fine: its name never enters the command', () => {
    assert.equal(runners.detect(folder('net-one-odd', { 'my&app.csproj': '' })).command, 'dotnet run');
  });
});

describe('every command any runner can produce passes the safety check', () => {
  test('across all fixtures above', () => {
    for (const name of fs.readdirSync(root)) {
      const d = runners.detect(path.join(root, name));
      if (!d) continue;
      assert.ok(runners.safeCommand(d.command), `${name}: ${d.command}`);
      if (d.install) assert.ok(runners.safeCommand(d.install), `${name}: ${d.install}`);
    }
  });
});

describe('identify() (which project a running server belongs to)', () => {
  test('a PHP process in a Laravel folder is Laravel; a node process there is its Vite package.json', () => {
    const dir = folder('lv-id', { artisan: '<?php', 'composer.json': '{"name":"acme/lv-id"}', 'package.json': '{"name":"lv-assets","devDependencies":{"vite":"*"}}' });
    assert.equal(runners.identify(dir).framework, 'Laravel');
    const js = runners.identify(dir, { js: true });
    assert.equal(js.framework, null);
    assert.equal(js.name, 'lv-assets');
    assert.deepEqual(js.deps, ['vite']);
  });

  test('a package.json without dev scripts still names a Node project', () => {
    assert.equal(runners.identify(folder('pkg-no-scripts', { 'package.json': '{"name":"lib"}' })).name, 'lib');
  });

  test('a folder with nothing recognisable is null', () => {
    assert.equal(runners.identify(folder('nothing', { 'readme.md': 'hi' })), null);
  });
});

describe('scan() and saved projects across technologies', () => {
  test('a parent folder with mixed projects finds each, and skips vendor/target/venv/bin/obj', () => {
    const ws = folder('mixed', {
      'api/manage.py': 'import django',
      'shop/artisan': '<?php', 'shop/composer.json': '{"name":"x/shop"}',
      'web/package.json': '{"name":"web","scripts":{"dev":"vite"}}',
      'svc/go.mod': 'module svc',
      'vendor/package.json': '{"scripts":{"dev":"x"}}',
      'target/Cargo.toml': '[package]\nname="t"',
      'venv/manage.py': 'django',
      'bin/package.json': '{"scripts":{"dev":"x"}}',
      'obj/x.csproj': '',
    });
    assert.deepEqual(projects.scan(ws).map((p) => `${p.name}:${p.runner}`).sort(), ['api:django', 'shop:laravel', 'svc:go', 'web:node']);
  });

  test('a Django app with sub-apps in subfolders is offered itself, too', () => {
    const ws = folder('dj-parent', { 'manage.py': 'django', 'tools/package.json': '{"scripts":{"dev":"x"}}' });
    assert.deepEqual(projects.scan(ws).map((p) => p.runner), ['django', 'node']);
  });

  test('a saved Laravel project reports its framework, command and install step', () => {
    const dir = folder('lv-saved', { artisan: '<?php', 'composer.json': '{"name":"acme/lv-saved"}' });
    projects.addProjects([dir]);
    const p = projects.withStatus([], () => null).find((x) => x.name === 'lv-saved');
    assert.equal(p.runner, 'laravel');
    assert.equal(p.framework, 'Laravel');
    assert.equal(p.kind, 'backend');
    assert.equal(p.command, 'php artisan serve');
    assert.equal(p.needsInstall, true);
    assert.equal(p.installCommand, 'composer install');
    assert.equal(p.installWhat, 'vendor');
  });
});
