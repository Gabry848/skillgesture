import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillRegistry } from '../src/registry.js';
import { JsonStore } from '../src/store.js';

async function stores(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'skillgesture-cache-'));
  const home = path.join(base, 'home');
  const folder = path.join(base, 'project');
  await mkdir(folder, { recursive: true });
  const first = new JsonStore(home);
  const second = new JsonStore(home);
  await first.initialize();
  await second.initialize();
  t.after(() => rm(base, { recursive: true, force: true }));
  return { folder, first, second, registry: new SkillRegistry(first) };
}

test('cached values are isolated clones and same-process writes invalidate immediately', async (t) => {
  const { first, registry } = await stores(t);
  await registry.manage('group.upsert', { id: 'tools', name: 'Tools' });
  const cached = await first.readCatalog();
  cached.groups[0].name = 'mutated by caller';
  assert.equal((await first.readCatalog()).groups[0].name, 'Tools');

  await registry.manage('skill.upsert', {
    groupId: 'tools', id: 'git', name: 'Git', global: true, markdown: '# Git',
  });
  const current = await first.readCatalog();
  assert.equal(current.revision, 2);
  assert.equal(current.groups[0].skills[0].id, 'git');
});

test('a second store detects catalog, association, and session replacements', async (t) => {
  const { folder, first, second, registry } = await stores(t);
  await registry.manage('group.upsert', { id: 'tools', name: 'Tools' });
  await registry.manage('skill.upsert', {
    groupId: 'tools', id: 'local', name: 'Local', markdown: '# Local',
  });
  await registry.manage('association.set', {
    folder, skills: [{ groupId: 'tools', skillId: 'local' }],
  });
  const session = (await registry.manage('session.open', { folders: [folder], label: 'before' })).session;
  await Promise.all([
    second.readCatalog(), second.readAssociations(), second.readSession(session.sessionId),
  ]);

  await registry.manage('skill.upsert', {
    groupId: 'tools', id: 'local', description: 'changed',
  });
  await registry.manage('association.set', { folder, skills: [] });
  await registry.manage('session.configure', {
    sessionId: session.sessionId, folders: [folder], label: 'after',
  });

  assert.equal((await second.readCatalog()).groups[0].skills[0].description, 'changed');
  assert.deepEqual((await second.readAssociations()).folders, {});
  assert.equal((await second.readSession(session.sessionId)).label, 'after');
  const secondRegistry = new SkillRegistry(second);
  await assert.rejects(
    secondRegistry.read(session.sessionId, { groupId: 'tools', skillId: 'local' }),
    (error) => error.code === 'SKILL_NOT_ACTIVE',
  );
});

test('failed mutations cannot poison cached state', async (t) => {
  const { first, registry } = await stores(t);
  await registry.manage('group.upsert', { id: 'tools', name: 'Tools' });
  await first.readCatalog();
  const writeJsonAtomic = first.writeJsonAtomic.bind(first);
  first.writeJsonAtomic = async () => { throw new Error('injected write failure'); };
  await assert.rejects(
    registry.manage('group.upsert', { id: 'tools', name: 'Changed' }),
    /injected write failure/,
  );
  first.writeJsonAtomic = writeJsonAtomic;
  assert.equal((await first.readCatalog()).groups[0].name, 'Tools');
});

test('changed corrupt files fail closed instead of serving a cached authorization snapshot', async (t) => {
  const { first, registry } = await stores(t);
  await registry.manage('group.upsert', { id: 'tools', name: 'Tools' });
  await first.readCatalog();
  await writeFile(first.catalogPath, '{ invalid json', 'utf8');
  await assert.rejects(first.readCatalog(), (error) => error.code === 'STORE_CORRUPT');
});
