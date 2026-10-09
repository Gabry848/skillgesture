import { parseDocument } from 'yaml';

export const MAX_MARKDOWN = 256 * 1024;

export function importSkillMarkdown(markdown: string, filename: string) {
  if (new TextEncoder().encode(markdown).length > MAX_MARKDOWN || markdown.includes('\0')) {
    throw new Error('Markdown must be text no larger than 256 KiB.');
  }
  const source = markdown.replace(/^\uFEFF/, '');
  let metadata: Record<string, unknown> = {};
  let body = source;
  if (/^---[ \t]*\r?\n/.test(source)) {
    const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(source);
    if (!frontmatter) throw new Error('The skill file has an unclosed YAML header.');
    const document = parseDocument(frontmatter[1], { schema: 'failsafe' });
    if (document.errors.length) throw new Error('The skill file has an invalid YAML header.');
    let value: unknown;
    try { value = document.toJS({ maxAliasCount: 0 }); }
    catch { throw new Error('The skill file has an unsupported YAML header.'); }
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      throw new Error('The YAML header must contain named fields.');
    }
    metadata = (value ?? {}) as Record<string, unknown>;
    body = source.slice(frontmatter[0].length);
  }
  const field = (key: string, max: number) => {
    const value = Object.hasOwn(metadata, key) ? metadata[key] : undefined;
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.trim().length > max) {
      throw new Error(`The skill ${key} must be text no longer than ${max} characters.`);
    }
    return value.trim();
  };
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  const name = field('name', 120) || (heading || filename.replace(/\.(?:md|markdown)$/i, '') || 'New skill').slice(0, 120);
  return { name, description: field('description', 1000), markdown };
}

export async function readSkillFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>) {
  if (!/\.(?:md|markdown)$/i.test(file.name)) throw new Error('Choose a Markdown skill file (.md).');
  if (file.size > MAX_MARKDOWN) throw new Error('Markdown must be text no larger than 256 KiB.');
  let markdown: string;
  try { markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('Unable to read this file as UTF-8 text.'); }
  return importSkillMarkdown(markdown, file.name);
}
