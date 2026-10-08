import path from 'node:path';
import { readdir, lstat } from 'node:fs/promises';
import { JsonStore } from './store.js';
import { ResourcePath } from './cloud-contracts.js';
import { fail } from './errors.js';
import { tokenHash } from './postgres-store.js';

export async function importLocalCatalog({ store, root, principal, defaultCategories } = {}) {
  if (!principal?.admin) fail('FORBIDDEN', 'Administrative access is required');
  const source = new JsonStore(path.resolve(root));
  // Never initialize or mutate the source repository.
  const catalog = await source.readCatalog();
  const associations = await source.readAssociations();
  const groupIds = new Set(catalog.groups.map((group) => group.id));
  if (defaultCategories?.some((id) => !groupIds.has(id))) fail('INVALID_INPUT', 'Unknown default category');
  if (defaultCategories === undefined && catalog.groups.some((group) =>
    group.skills.some((skill) => skill.global) && group.skills.some((skill) => !skill.global))) {
    fail('MIGRATION_SCOPE_AMBIGUOUS', 'Mixed global/folder groups require an explicit defaultCategories selection');
  }
  const defaults = new Set(defaultCategories ?? catalog.groups
    .filter((group) => group.skills.length && group.skills.every((skill) => skill.global)).map((group) => group.id));
  return store.mutate(principal, 'catalog.import', async (client) => {
    const { rows: existing } = await client.query('SELECT id FROM sg_categories WHERE account_id=$1 LIMIT 1', [principal.accountId]);
    if (existing.length) fail('IMPORT_TARGET_NOT_EMPTY', 'Import into an empty account to avoid overwriting data');
    const counts = { categories: 0, skills: 0, subskills: 0, resources: 0 };
    const archived = new Set();
    const archive = async (relativePath, bytes) => {
      if (archived.has(relativePath)) return;
      const hash = tokenHash(bytes);
      await client.query('INSERT INTO sg_blobs(account_id,hash,bytes) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [principal.accountId, hash, bytes]);
      await client.query('INSERT INTO sg_import_files(account_id,path,blob_hash) VALUES ($1,$2,$3)', [principal.accountId, relativePath, hash]);
      archived.add(relativePath);
    };
    const archiveDirectory = async (relativePath) => {
      const absolute = source.resolveSkillPath(relativePath);
      let entries;
      try {
        const stat = await lstat(absolute);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STORE_CORRUPT', 'Unsafe import resource directory');
        entries = await readdir(absolute, { withFileTypes: true });
      } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const relative = `${relativePath}/${entry.name}`;
        if (entry.isSymbolicLink()) fail('STORE_CORRUPT', 'Import resources cannot be symbolic links');
        if (entry.isDirectory()) await archiveDirectory(relative);
        else await archive(relative, await source.readResource(relative));
      }
    };
    const importNode = async (group, skill, node, subskill) => {
      const ref = `${group.id}/${skill.id}${subskill ? `/${node.id}` : ''}`;
      const root = `skills/${group.id}/${skill.id}${subskill ? `/subskills/${node.id}` : ''}`;
      const activeMarkdown = await source.readMarkdown(node.markdownPath);
      if (Buffer.byteLength(activeMarkdown) > 256 * 1024 || activeMarkdown.includes('\0')) fail('STORE_CORRUPT', 'Imported Markdown exceeds the content budget');
      await client.query(`INSERT INTO sg_nodes(account_id,ref,category_id,skill_id,subskill_id,parent_ref,name,description,enabled,version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [principal.accountId, ref, group.id, skill.id, subskill ? node.id : null, subskill ? `${group.id}/${skill.id}` : null,
        node.name, node.description, node.enabled, node.version]);
      let lastMarkdown;
      for (let version = 1; version <= node.version; version++) {
        const markdownPath = `${root}/versions/${version}/SKILL.md`;
        try {
          lastMarkdown = await source.readMarkdown(markdownPath);
          if (Buffer.byteLength(lastMarkdown) > 256 * 1024) fail('STORE_CORRUPT', 'Historical Markdown exceeds the content budget');
          await archive(markdownPath, Buffer.from(lastMarkdown));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await archiveDirectory(`${root}/versions/${version}/resources`);
        if (version === node.version) lastMarkdown = activeMarkdown;
        if (lastMarkdown !== undefined) await client.query('INSERT INTO sg_versions(account_id,ref,version,markdown) VALUES ($1,$2,$3,$4)',
          [principal.accountId, ref, version, lastMarkdown]);
      }
      await archive(node.markdownPath, Buffer.from(activeMarkdown));
      let resourceBytes = 0;
      if (node.resources.length > 200) fail('STORE_CORRUPT', 'Imported resources exceed their count budget');
      for (const resource of node.resources) {
        ResourcePath.parse(resource.path);
        const bytes = await source.readResource(resource.storagePath);
        resourceBytes += bytes.byteLength;
        if (resourceBytes > 20 * 1024 * 1024) fail('STORE_CORRUPT', 'Imported resources exceed their size budget');
        await archive(resource.storagePath, bytes);
        await client.query(`INSERT INTO sg_resources(account_id,ref,version,path,mime_type,encoding,size,blob_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [principal.accountId, ref, node.version, resource.path, resource.mimeType, resource.encoding, bytes.byteLength, tokenHash(bytes)]);
        counts.resources++;
      }
      counts[subskill ? 'subskills' : 'skills']++;
    };
    for (const group of catalog.groups) {
      await client.query(`INSERT INTO sg_categories(account_id,id,name,description,enabled,preload,version)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [principal.accountId, group.id, group.name, group.description, group.enabled, defaults.has(group.id), group.version]);
      counts.categories++;
      for (const skill of group.skills) {
        await importNode(group, skill, skill, false);
        for (const subskill of skill.subskills) await importNode(group, skill, subskill, true);
      }
    }
    await client.query('INSERT INTO sg_import_metadata(account_id,catalog,associations) VALUES ($1,$2,$3)',
      [principal.accountId, JSON.stringify(catalog), JSON.stringify(associations)]);
    return counts;
  });
}
