import path from 'node:path';
import { JsonStore, SCHEMA_VERSION } from '../src/store.js';

function number(index, size) {
  return String(index).padStart(String(Math.max(0, size - 1)).length, '0');
}

export function benchmarkSkillId(index, size) {
  return `skill-${number(index, size)}`;
}

export function benchmarkCatalog(size) {
  if (!Number.isInteger(size) || size < 1) throw new TypeError('size must be a positive integer');
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    groups: [{
      id: 'benchmark',
      name: 'Benchmark',
      description: 'Deterministic generated discovery corpus',
      enabled: true,
      version: 1,
      skills: Array.from({ length: size }, (_, index) => {
        const suffix = number(index, size);
        return {
          id: benchmarkSkillId(index, size),
          name: `Generated Skill ${suffix}`,
          description: `Deterministic lexical benchmark entry ${suffix} for discovery search and batch reads`,
          enabled: true,
          global: true,
          version: 1,
          markdownPath: 'skills/benchmark/shared/versions/1/SKILL.md',
          resources: [],
          subskills: [],
        };
      }),
    }],
  };
}

export async function generateBenchmarkStore(root, size) {
  const store = new JsonStore(path.resolve(root));
  await store.initialize();
  await store.writeMarkdown('skills/benchmark/shared/versions/1/SKILL.md', '# Generated benchmark skill\n');
  await store.writeJsonAtomic(store.catalogPath, benchmarkCatalog(size));
  return store;
}
