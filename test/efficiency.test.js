import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillRegistry } from '../src/registry.js';
import { JsonStore } from '../src/store.js';

const corpus = JSON.parse(await readFile(new URL('./fixtures/discovery.json', import.meta.url), 'utf8'));

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'skillgesture-efficiency-'));
  const registry = new SkillRegistry(new JsonStore(home));
  await registry.initialize();
  t.after(() => rm(home, { recursive: true, force: true }));
  await registry.manage('group.upsert', { id: 'tools', name: 'Tools', description: 'Development tools' });
  for (const skill of corpus.skills) {
    await registry.manage('skill.upsert', {
      groupId: 'tools', ...skill, global: true, markdown: `# ${skill.name}\n`,
    });
  }
  return registry;
}

function compactSkills(result) {
  return result.groups.flatMap((group) => group.skills);
}

test('keeps legacy discovery as default and projects compact-v1 without admin fields', async (t) => {
  const registry = await fixture(t);
  const session = (await registry.manage('session.open', {})).session;
  assert.deepEqual(await registry.tree(session.sessionId), await registry.tree(session.sessionId, { format: 'legacy' }));

  const compact = await registry.tree(session.sessionId, { format: 'compact-v1' });
  assert.equal(compact.complete, true);
  assert.equal(compact.truncated, false);
  assert.equal(compact.counts.returned, corpus.skills.length);
  const skill = compactSkills(compact)[0];
  assert.match(skill.ref, /^tools\//);
  assert.equal('version' in skill, false);
  assert.equal('enabled' in skill, false);
  assert.equal('matchedFolders' in skill, false);
  assert.equal(Buffer.byteLength(JSON.stringify(compact)) <= 32 * 1024, true);
});

test('ranks a deterministic lexical corpus and paginates with validated cursors', async (t) => {
  const registry = await fixture(t);
  for (const entry of corpus.queries) {
    const result = await registry.tree(undefined, { format: 'compact-v1', query: entry.query });
    assert.equal(compactSkills(result)[0].id, entry.first, entry.query);
  }

  const first = await registry.tree(undefined, { format: 'compact-v1', limit: 2, groupId: 'tools' });
  assert.equal(first.complete, false);
  assert.equal(first.truncated, true);
  assert.equal(first.counts.returned, 2);
  assert.equal(first.guidance.field, 'cursor');
  const second = await registry.tree(undefined, {
    format: 'compact-v1', limit: 2, groupId: 'tools', cursor: first.nextCursor,
  });
  assert.equal(second.counts.returned, 2);
  assert.notDeepEqual(compactSkills(first).map((skill) => skill.id), compactSkills(second).map((skill) => skill.id));
  await assert.rejects(
    registry.tree(undefined, { format: 'compact-v1', cursor: `${first.nextCursor}x` }),
    (error) => error.code === 'INVALID_CURSOR',
  );
});

test('returns notModified only for the current index and invalidates it on catalog changes', async (t) => {
  const registry = await fixture(t);
  const initial = await registry.tree(undefined, { format: 'compact-v1', query: 'git' });
  const unchanged = await registry.tree(undefined, {
    format: 'compact-v1', query: 'git', knownIndexVersion: initial.indexVersion,
  });
  assert.deepEqual(Object.keys(unchanged).sort(), ['context', 'format', 'indexVersion', 'notModified']);
  assert.equal(unchanged.notModified, true);

  const unknown = await registry.tree(undefined, {
    format: 'compact-v1', query: 'git', knownIndexVersion: '000000000000000000000000',
  });
  assert.equal(unknown.notModified, false);
  await registry.manage('skill.upsert', {
    groupId: 'tools', id: 'git', description: 'Updated version control guidance',
  });
  const changed = await registry.tree(undefined, {
    format: 'compact-v1', query: 'git', knownIndexVersion: initial.indexVersion,
  });
  assert.equal(changed.notModified, false);
  assert.notEqual(changed.indexVersion, initial.indexVersion);
});

test('truncates compact discovery explicitly at the deterministic byte budget', async (t) => {
  const registry = await fixture(t);
  for (let index = 0; index < 40; index += 1) {
    await registry.manage('skill.upsert', {
      groupId: 'tools',
      id: `large-${String(index).padStart(2, '0')}`,
      name: `Large ${String(index).padStart(2, '0')}`,
      description: `${String(index).padStart(2, '0')} ${'description '.repeat(80)}`,
      global: true,
      markdown: '# Large',
    });
  }
  const result = await registry.tree(undefined, { format: 'compact-v1', limit: 50 });
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.ok(result.counts.returned < result.counts.matched);
  assert.ok(result.nextCursor);
  assert.equal(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024, true);
});

test('session.open can include compact discovery using the same semantics', async (t) => {
  const registry = await fixture(t);
  const opened = await registry.manage('session.open', {
    label: 'combined', discovery: { format: 'compact-v1', query: 'git', limit: 1 },
  });
  assert.equal(opened.resumed, false);
  assert.equal(opened.discovery.context.session, opened.session.sessionId);
  assert.equal(compactSkills(opened.discovery)[0].id, 'git');
});

test('batch reads preserve order and isolate mixed failures', async (t) => {
  const registry = await fixture(t);
  await registry.manage('skill.upsert', {
    groupId: 'tools', id: 'scoped', name: 'Scoped', markdown: '# Scoped',
  });
  const batch = await registry.readMany(undefined, [
    { groupId: 'tools', skillId: 'git' },
    { groupId: 'tools', skillId: 'scoped' },
    { groupId: 'tools', skillId: 'missing' },
    { groupId: 'tools', skillId: 'docs' },
  ]);
  assert.deepEqual(batch.items.map((item) => item.ok), [true, false, false, true]);
  assert.equal(batch.items[0].ref.skillId, 'git');
  assert.equal(batch.items[1].error.code, 'SESSION_REQUIRED');
  assert.equal(batch.items[2].error.code, 'SKILL_NOT_FOUND');
  assert.equal(batch.items[3].ref.skillId, 'docs');
  await assert.rejects(registry.readMany(undefined, Array(9).fill({ groupId: 'tools', skillId: 'git' })),
    (error) => error.code === 'INVALID_INPUT');
});

test('batch response cap reports oversized items without discarding earlier reads', async (t) => {
  const registry = await fixture(t);
  const markdown = `# Large\n${'x'.repeat(256 * 1024 - 20)}`;
  for (let index = 0; index < 5; index += 1) {
    await registry.manage('skill.upsert', {
      groupId: 'tools', id: `body-${index}`, name: `Body ${index}`, global: true, markdown,
    });
  }
  const result = await registry.readMany(undefined, Array.from({ length: 5 }, (_, index) => ({
    groupId: 'tools', skillId: `body-${index}`,
  })));
  assert.equal(result.items.length, 5);
  assert.equal(result.items[0].ok, true);
  assert.ok(result.items.some((item) => item.error?.code === 'RESPONSE_TOO_LARGE'));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024);
});

test('compact-v2 preserves search decisions and paginates the full index without repeated metadata', async (t) => {
  const registry = await fixture(t);
  for (const entry of corpus.queries) {
    const result = await registry.tree(undefined, { format: 'compact-v2', query: entry.query });
    assert.equal(result.skills[0].ref, `tools/${entry.first}`, entry.query);
  }
  const baseline = await registry.tree(undefined, { format: 'compact-v1' });
  const minimal = await registry.tree(undefined, { format: 'compact-v2' });
  assert.deepEqual(minimal.skills.map((item) => item.ref), compactSkills(baseline).map((item) => item.ref));
  assert.ok(Buffer.byteLength(JSON.stringify(minimal)) < Buffer.byteLength(JSON.stringify(baseline)));
  assert.equal('groups' in minimal, false);
  assert.equal('context' in minimal, false);
  assert.equal('counts' in minimal, false);
  assert.ok(minimal.skills.every((item) => !('id' in item) && !('subskills' in item)));

  const refs = [];
  let cursor;
  do {
    const page = await registry.tree(undefined, { format: 'compact-v2', limit: 2, cursor });
    refs.push(...page.skills.map((item) => item.ref));
    assert.equal(page.truncated, page.nextCursor !== undefined);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(refs, minimal.skills.map((item) => item.ref));
  assert.equal(new Set(refs).size, refs.length);
});

test('compact-v2 cache and cursors cannot cross query, format, or catalog changes', async (t) => {
  const registry = await fixture(t);
  const initial = await registry.tree(undefined, { format: 'compact-v2', query: 'git', limit: 1 });
  const cached = await registry.tree(undefined, {
    format: 'compact-v2', query: 'git', knownIndexVersion: initial.indexVersion,
  });
  assert.deepEqual(cached, { indexVersion: initial.indexVersion, notModified: true });
  const different = await registry.tree(undefined, {
    format: 'compact-v2', query: 'docs', knownIndexVersion: initial.indexVersion,
  });
  assert.equal(different.notModified, undefined);
  assert.equal(different.skills[0].ref, 'tools/docs');

  const page = await registry.tree(undefined, { format: 'compact-v2', limit: 1 });
  for (const options of [{ format: 'compact-v1' }, { format: 'compact-v2', query: 'git' }]) {
    await assert.rejects(registry.tree(undefined, { ...options, cursor: page.nextCursor }),
      (error) => error.code === 'INVALID_CURSOR');
  }
  await registry.manage('skill.upsert', { groupId: 'tools', id: 'git', description: 'Changed instructions' });
  await assert.rejects(registry.tree(undefined, { format: 'compact-v2', cursor: page.nextCursor }),
    (error) => error.code === 'INVALID_CURSOR');
  const changed = await registry.tree(undefined, {
    format: 'compact-v2', query: 'git', knownIndexVersion: initial.indexVersion,
  });
  assert.notEqual(changed.indexVersion, initial.indexVersion);
});

test('compact-v2 enforces its byte budget and preserves resumable truncation', async (t) => {
  const registry = await fixture(t);
  for (let index = 0; index < 40; index += 1) {
    await registry.manage('skill.upsert', {
      groupId: 'tools', id: `large-${index}`, name: `Large ${index}`,
      description: 'description '.repeat(80), global: true, markdown: '# Large',
    });
  }
  const page = await registry.tree(undefined, { format: 'compact-v2', limit: 50 });
  assert.equal(page.truncated, true);
  assert.ok(page.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32 * 1024);
  const next = await registry.tree(undefined, { format: 'compact-v2', limit: 50, cursor: page.nextCursor });
  assert.equal(next.truncated, false);
  assert.equal(page.skills.length + next.skills.length, corpus.skills.length + 40);
});
