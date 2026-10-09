import { expect, it } from 'vitest';
import { File } from 'node:buffer';
import { importSkillMarkdown, MAX_MARKDOWN, readSkillFile } from './skill-file';

it('reads quoted and folded YAML metadata while preserving the entire Markdown file', () => {
  const markdown = '---\r\nname: "Code: review"\r\ndescription: >-\r\n  Review changes\r\n  before merging.\r\nmetadata:\r\n  name: Nested\r\n---\r\n# Review\r\n';
  expect(importSkillMarkdown(markdown, 'SKILL.md')).toEqual({ name: 'Code: review', description: 'Review changes before merging.', markdown });
});

it('accepts plain Markdown, an empty header and names derived from the heading or filename', () => {
  expect(importSkillMarkdown('# Review changes\n\nInstructions.', 'SKILL.md').name).toBe('Review changes');
  expect(importSkillMarkdown('Instructions.', 'review.markdown')).toMatchObject({ name: 'review', description: '' });
  expect(importSkillMarkdown('---\n\n---\n# Review\n', 'SKILL.md').name).toBe('Review');
  expect(importSkillMarkdown('---\n---\n# Review\n', 'SKILL.md').name).toBe('Review');
});

it('rejects invalid headers and metadata that cannot be saved to the catalog', () => {
  for (const markdown of ['---\nname: review', '---\nname: [broken\n---\n', '---\n- review\n---\n', '---\nname: [review]\n---\n',
    `---\nname: ${'n'.repeat(121)}\n---\n`, `---\ndescription: ${'d'.repeat(1001)}\n---\n`, '---\nname: &name review\ndescription: *name\n---\n']) {
    expect(() => importSkillMarkdown(markdown, 'SKILL.md')).toThrow();
  }
});

it('enforces UTF-8, the byte limit and Markdown file types before importing', async () => {
  await expect(readSkillFile(new File(['# Review'], 'SKILL.md'))).resolves.toMatchObject({ name: 'Review' });
  await expect(readSkillFile(new File(['\uFEFF# Review\r\n'], 'SKILL.md'))).resolves.toMatchObject({ name: 'Review', markdown: '\uFEFF# Review\r\n' });
  await expect(readSkillFile(new File(['# Review'], 'skill.txt'))).rejects.toThrow('Markdown skill file');
  await expect(readSkillFile(new File([new Uint8Array([0xff])], 'SKILL.md'))).rejects.toThrow('UTF-8');
  await expect(readSkillFile(new File(['\0'], 'SKILL.md'))).rejects.toThrow('256 KiB');
  await expect(readSkillFile(new File(['é'.repeat(MAX_MARKDOWN / 2 + 1)], 'SKILL.md'))).rejects.toThrow('256 KiB');
});
