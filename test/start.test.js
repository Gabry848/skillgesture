import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the actual launcher without touching Docker, Keychain, or services.
const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const file = process.env.LAUNCHER_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls.push({ name, args });
const save = () => {
  const temporary = file + '.' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, file);
};
const done = (code = 0, output = '') => { save(); process.stdout.write(output); process.exit(code); };
if (name === 'uname') done(0, state.platform || 'Darwin');
if (name === 'sleep') done();
if (name === 'open') { state.dockerReady = true; done(); }
if (name === 'security') {
  if (args[0] === 'find-generic-password') done(state.password ? 0 : 44, state.password || '');
  if (state.keychainDenied) done(1);
  state.password = args[args.indexOf('-w') + 1]; done();
}
if (name === 'npm') { state.installed = true; done(); }
if (name === 'node') {
  if (args[0] === 'src/index.js') {
    state.server = { port: process.env.PORT, pgport: process.env.PGPORT,
      host: process.env.HOST, publicUrl: process.env.PUBLIC_URL,
      passwordMatches: process.env.PGPASSWORD === state.password,
      databaseUrl: process.env.DATABASE_URL, passwordFile: process.env.DATABASE_PASSWORD_FILE,
      tlsCert: process.env.TLS_CERT, tlsKey: process.env.TLS_KEY };
    done(0, 'Skillgesture cloud MCP ready\\n');
  }
  if (args.includes('--input-type=module')) done(state.missingDependencies && !state.installed ? 1 : 0);
  save();
  const result = spawnSync(process.env.LAUNCHER_NODE, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
if (name === 'docker') {
  if (args[0] === 'info') done(state.dockerReady === false ? 1 : 0);
  if (args[0] === 'volume') done(state.volume ? 0 : 1);
  if (args[0] === 'container') {
    if (!state.existing) done(1);
    done(0, JSON.stringify([{ Config: { Env: [
      'POSTGRES_USER=skillgesture', 'POSTGRES_DB=skillgesture',
      'POSTGRES_PASSWORD=' + (state.containerPassword || 'test-password')
    ] }, HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: state.bind || '127.0.0.1', HostPort: state.port || '5433' }] } } }]));
  }
  if (args[0] === 'run') { state.createdPassword = process.env.POSTGRES_PASSWORD; done(); }
  if (args.includes('psql')) done(state.badPassword ? 1 : 0);
  if (args.includes('pg_isready')) done(state.databaseNotReady ? 1 : 0);
  if (args[0] === 'start') done();
}
done(1);
`;

function launch(t, settings = {}, extraEnv = {}, args = []) {
  const folder = mkdtempSync(join(tmpdir(), 'skillgesture-launcher-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const bin = join(folder, 'bin');
  mkdirSync(bin);
  for (const name of ['node', 'npm', 'docker', 'security', 'uname', 'open', 'sleep']) {
    writeFileSync(join(bin, name), mock, { mode: 0o755 });
  }
  const stateFile = join(folder, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ calls: [], ...settings }));
  const env = { ...process.env };
  delete env.PGPASSWORD;
  const result = spawnSync('/bin/bash', [resolve('start.sh'), ...args], {
    cwd: folder, encoding: 'utf8', timeout: 15000,
    env: { ...env, PATH: bin + ':' + env.PATH,
      LAUNCHER_NODE: process.execPath, LAUNCHER_STATE: stateFile, ...extraEnv },
  });
  assert.ifError(result.error);
  return { ...result, state: JSON.parse(readFileSync(stateFile, 'utf8')) };
}

test('launcher creates a persistent loopback database and saves its generated credential', t => {
  const r = launch(t, { dockerReady: false, missingDependencies: true }, {
    DATABASE_URL: 'production', DATABASE_PASSWORD_FILE: '/production', TLS_CERT: '/cert', TLS_KEY: '/key',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.state.createdPassword, /^[a-f0-9]{64}$/);
  assert.equal(r.state.password, r.state.createdPassword);
  const run = r.state.calls.find(c => c.name === 'docker' && c.args[0] === 'run');
  assert.ok(run.args.includes('127.0.0.1:5433:5432'));
  assert.ok(run.args.includes('skillgesture-postgres-data:/var/lib/postgresql'));
  assert.ok(run.args.includes('POSTGRES_PASSWORD'));
  assert.ok(!run.args.some(a => a.includes(r.state.password)));
  assert.equal(r.state.server.passwordMatches, true);
  assert.equal(r.state.server.databaseUrl, undefined);
  assert.equal(r.state.server.passwordFile, undefined);
  assert.equal(r.state.server.tlsCert, undefined);
  assert.equal(r.state.server.tlsKey, undefined);
  assert.equal(r.state.server.publicUrl, 'http://127.0.0.1:8080/mcp');
  assert.equal(r.state.server.host, '127.0.0.1');
  assert.equal(r.state.installed, true);
  assert.ok(r.state.calls.some(c => c.name === 'open'));
  assert.ok(!(r.stdout + r.stderr).includes(r.state.password));
});

test('launcher restarts an existing database with its Keychain password and mapped port', t => {
  const r = launch(t, { existing: true, password: 'test-password', port: '5544' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.state.server.pgport, '5544');
  assert.equal(r.state.server.passwordMatches, true);
  assert.ok(r.state.calls.some(c => c.name === 'docker' && c.args[0] === 'start'));
  assert.ok(!r.state.calls.some(c => c.name === 'docker' && c.args[0] === 'run'));
});

test('launcher adopts the credential of a manually created container', t => {
  const r = launch(t, { existing: true, containerPassword: 'manual-password' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.state.password, 'manual-password');
  assert.equal(r.state.server.passwordMatches, true);
});

test('launcher preserves an orphaned data volume without generating a new password', t => {
  const r = launch(t, { volume: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /volume dati esiste/);
  assert.equal(r.state.password, undefined);
  assert.equal(r.state.server, undefined);
});

test('launcher rejects an incompatible container without starting it', t => {
  const r = launch(t, { existing: true, bind: '0.0.0.0' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /configurazione locale/);
  assert.ok(!r.state.calls.some(c => c.name === 'docker' && c.args[0] === 'start'));
  assert.equal(r.state.password, undefined);
});

test('launcher does not overwrite Keychain after a failed password check', t => {
  const r = launch(t, { existing: true, password: 'test-password', badPassword: true }, { PGPASSWORD: 'wrong-password' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Password Postgres non valida/);
  assert.equal(r.state.password, 'test-password');
  assert.equal(r.state.server, undefined);
});

test('launcher bounds the database wait', t => {
  const r = launch(t, { existing: true, databaseNotReady: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Postgres non è pronto/);
  assert.equal(r.state.calls.filter(c => c.name === 'sleep').length, 60);
  assert.equal(r.state.server, undefined);
});

test('launcher fails before creating a database if Keychain cannot save its password', t => {
  const r = launch(t, { keychainDenied: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Portachiavi/);
  assert.ok(!r.state.calls.some(c => c.name === 'docker' && c.args[0] === 'run'));
});

test('launcher help does not interact with any service', t => {
  const r = launch(t, {}, {}, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage/);
  assert.deepEqual(r.state.calls, []);
});
