import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillRegistry } from '../src/registry.js';
import { JsonStore } from '../src/store.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'skillgesture-test-'));
  const home = path.join(base, 'home');
  const folderA = path.join(base, 'project-a');
  const folderB = path.join(base, 'project-b');
  const nested = path.join(folderA, 'nested');
  await Promise.all([
    mkdir(folderA, { recursive: true }),
    mkdir(folderB, { recursive: true }),
    mkdir(nested, { recursive: true }),
  ]);
  const registry = new SkillRegistry(new JsonStore(home));
  await registry.initialize();
  t.after(() => rm(base, { recursive: true, force: true }));
  return {
    base,
    home,
    folderA: await realpath(folderA),
    folderB: await realpath(folderB),
    nested: await realpath(nested),
    registry,
  };
}

async function seed(registry, folderA) {
  await registry.manage('group.upsert', { id: 'coding', name: 'Coding' });
  await registry.manage('skill.upsert', {
    groupId: 'coding',
    id: 'git',
    name: 'Git',
    description: 'Global Git guidance',
    global: true,
    markdown: '# Git\n\nGlobal body.',
  });
  await registry.manage('skill.upsert', {
    groupId: 'coding',
    id: 'node',
    name: 'Node.js',
    description: 'Node project guidance',
    markdown: '# Node.js\n\nFolder body.',
  });
  await registry.manage('subskill.upsert', {
    groupId: 'coding',
    skillId: 'node',
    id: 'testing',
    name: 'Node testing',
    description: 'Testing with node:test',
    markdown: '# Node testing\n\nUse node:test.',
  });
  await registry.manage('association.set', {
    folder: folderA,
    skills: [{ groupId: 'coding', skillId: 'node' }],
  });
}

test('builds a lightweight tree and reads Markdown only on demand', async (t) => {
  const { registry, folderA } = await fixture(t);
  await seed(registry, folderA);
  const { session } = await registry.manage('session.open', { folders: [folderA], label: 'agent-a' });

  const tree = await registry.tree(session.sessionId);
  assert.equal(JSON.stringify(tree).includes('Folder body'), false);
  assert.deepEqual(tree.groups[0].skills.map((skill) => skill.id), ['git', 'node']);
  assert.deepEqual(tree.groups[0].skills.find((skill) => skill.id === 'node').subskills.map((item) => item.id), ['testing']);

  const read = await registry.read(session.sessionId, { groupId: 'coding', skillId: 'node', subskillId: 'testing' });
  assert.match(read.markdown, /Use node:test/);
  assert.deepEqual(read.matchedFolders, [folderA]);
});

test('supports enabled globals without a session and requires sessions for scoped content', async (t) => {
  const { registry, folderA } = await fixture(t);
  await seed(registry, folderA);
  await registry.manage('subskill.upsert', {
    groupId: 'coding',
    skillId: 'git',
    id: 'advanced',
    name: 'Advanced Git',
    markdown: '# Advanced Git',
    resources: [{ path: 'reference.md', content: 'global reference' }],
  });

  const tree = await registry.tree();
  assert.deepEqual(tree.context, { scope: 'global-only', session: null });
  assert.equal(tree.sessionId, null);
  assert.deepEqual(tree.groups[0].skills.map((skill) => skill.id), ['git']);
  assert.deepEqual(tree.groups[0].skills[0].subskills.map((subskill) => subskill.id), ['advanced']);

  const read = await registry.read(undefined, { groupId: 'coding', skillId: 'git', subskillId: 'advanced' });
  assert.equal(read.sessionId, null);
  assert.match(read.markdown, /Advanced Git/);
  const resource = await registry.read(undefined, {
    groupId: 'coding', skillId: 'git', subskillId: 'advanced', resourcePath: 'reference.md',
  });
  assert.equal(resource.resource.content, 'global reference');

  await assert.rejects(
    registry.read(undefined, { groupId: 'coding', skillId: 'node' }),
    (error) => error.code === 'SESSION_REQUIRED',
  );
  await registry.manage('node.setEnabled', {
    ref: { groupId: 'coding', skillId: 'git' }, enabled: false,
  });
  assert.deepEqual((await registry.tree(undefined, true)).groups, []);
  await assert.rejects(
    registry.read(undefined, { groupId: 'coding', skillId: 'git' }),
    (error) => error.code === 'SKILL_NOT_ACTIVE',
  );
});

test('uses exact folder matching and unions multiple folder scopes', async (t) => {
  const { registry, folderA, folderB, nested } = await fixture(t);
  await seed(registry, folderA);

  const nestedSession = (await registry.manage('session.open', { folders: [nested] })).session;
  const nestedTree = await registry.tree(nestedSession.sessionId);
  assert.deepEqual(nestedTree.groups[0].skills.map((skill) => skill.id), ['git']);
  await assert.rejects(
    registry.read(nestedSession.sessionId, { groupId: 'coding', skillId: 'node' }),
    (error) => error.code === 'SKILL_NOT_ACTIVE',
  );

  await registry.manage('association.set', {
    folder: folderB,
    skills: [{ groupId: 'coding', skillId: 'node' }],
  });
  const multi = (await registry.manage('session.open', { folders: [folderA, folderB] })).session;
  const multiTree = await registry.tree(multi.sessionId);
  const node = multiTree.groups[0].skills.find((skill) => skill.id === 'node');
  assert.deepEqual(node.matchedFolders, [folderA, folderB].sort());
});

test('disables hierarchy nodes and rejects on-demand reads', async (t) => {
  const { registry, folderA } = await fixture(t);
  await seed(registry, folderA);
  const session = (await registry.manage('session.open', { folders: [folderA] })).session;

  await registry.manage('node.setEnabled', {
    ref: { groupId: 'coding', skillId: 'node' },
    enabled: false,
  });
  const tree = await registry.tree(session.sessionId);
  assert.deepEqual(tree.groups[0].skills.map((skill) => skill.id), ['git']);
  const administrativeTree = await registry.tree(session.sessionId, true);
  assert.equal(administrativeTree.groups[0].skills.find((skill) => skill.id === 'node').enabled, false);
  await assert.rejects(
    registry.read(session.sessionId, { groupId: 'coding', skillId: 'node' }),
    (error) => error.code === 'SKILL_NOT_ACTIVE',
  );
});

test('persists independent durable sessions across registry instances', async (t) => {
  const { home, folderA, folderB, registry } = await fixture(t);
  const sessions = await Promise.all([
    registry.manage('session.open', { folders: [folderA], label: 'one' }),
    registry.manage('session.open', { folders: [folderB], label: 'two' }),
  ]);
  assert.notEqual(sessions[0].session.sessionId, sessions[1].session.sessionId);

  const restarted = new SkillRegistry(new JsonStore(home));
  await restarted.initialize();
  const resumed = await restarted.manage('session.open', { sessionId: sessions[0].session.sessionId });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.session.folders, [folderA]);
  const listed = await restarted.manage('session.list', {});
  assert.equal(listed.sessions.length, 2);
});

test('compact-v2 keeps scoped subskill refs and disabled states without leaking folder skills globally', async (t) => {
  const { registry, folderA } = await fixture(t);
  await seed(registry, folderA);
  const globals = await registry.tree(undefined, { format: 'compact-v2', includeDisabled: true });
  assert.deepEqual(globals.skills.map((item) => item.ref), ['coding/git']);
  const session = (await registry.manage('session.open', { folders: [folderA] })).session;
  const scoped = await registry.tree(session.sessionId, { format: 'compact-v2' });
  const node = scoped.skills.find((item) => item.ref === 'coding/node');
  assert.equal(node.name, 'Node.js');
  assert.equal(node.scope, 'folder');
  assert.equal(node.subskills[0].ref, 'coding/node/testing');
  assert.equal(node.subskills[0].enabled, undefined);

  await registry.manage('node.setEnabled', { ref: { groupId: 'coding' }, enabled: false });
  const disabled = await registry.tree(session.sessionId, { format: 'compact-v2', includeDisabled: true });
  assert.ok(disabled.skills.every((item) => item.enabled === false));
  assert.equal(disabled.skills.find((item) => item.ref === 'coding/node').subskills[0].enabled, false);
  assert.deepEqual((await registry.tree(undefined, { format: 'compact-v2', includeDisabled: true })).skills, []);
});
