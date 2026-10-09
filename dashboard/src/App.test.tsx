import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError, DashboardApi } from './api';
import type { Content, Entity, Overview, ResourceContent } from './types';

function fixture() {
  const categories = new Map<string, Entity>([['general', { ref: 'general', name: 'General', version: 1, default: true }]]);
  const nodes = new Map<string, Entity>([['general/git', { ref: 'general/git', name: 'Git', description: 'Version control', version: 1, resources: [] }]]);
  const bodies = new Map([['general/git', '# Git\n']]);
  const resources = new Map<string, ResourceContent['resource']>();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const overview: Overview = { identity: { accountId: 'test-account', agentId: 'admin', admin: true }, revision: '2', updatedAt: new Date().toISOString(),
    counts: Object.fromEntries(['categories', 'skills', 'subskills', 'resources'].map((key) => [key, { active: 1, disabled: 0, archived: 0, total: 1 }])) as Overview['counts'] };
  let expire: () => void = () => {};
  const api = {
    origin: 'http://127.0.0.1:8080', verify: vi.fn(async () => overview), overview: vi.fn(async () => overview), dispose: vi.fn(),
    async content(ref: string): Promise<Content> { return { ref, version: nodes.get(ref)!.version, markdown: bodies.get(ref)!, resources: nodes.get(ref)!.resources ?? [] }; },
    async resource(ref: string, path: string): Promise<ResourceContent> { return { ref, version: nodes.get(ref)!.version, resource: resources.get(`${ref}:${path}`)! }; },
    async activity() { return { events: [{ id: '1', agentId: 'admin', operation: 'skill.upsert', ref: 'general/git', version: 1, createdAt: overview.updatedAt }], truncated: false }; },
    async tool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const map = name === 'category_manage' ? categories : nodes;
      const ref = (args.id ?? args.ref) as string;
      const row = map.get(ref);
      if (args.action === 'list') {
        const values = [...map.values()].filter((r) => (args.includeDeleted || !r.deleted) && (!args.categoryId || r.ref.startsWith(`${args.categoryId}/`))
          && (!args.query || `${r.ref} ${r.name}`.toLowerCase().includes(String(args.query).toLowerCase())));
        const limit = Number(args.limit ?? 20);
        const offset = args.cursor ? Number(String(args.cursor).split(':')[1]) : 0;
        return { [name === 'category_manage' ? 'categories' : 'skills']: values.slice(offset, offset + limit),
          truncated: offset + limit < values.length, ...(offset + limit < values.length ? { nextCursor: `page:${offset + limit}` } : {}) };
      }
      if (args.action === 'get') return { [name === 'category_manage' ? 'category' : 'skill']: { ...row } };
      if (args.expectedVersion !== (row?.version ?? 0)) throw new ApiError('VERSION_CONFLICT', row?.version);
      const version = (row?.version ?? 0) + 1;
      if (name === 'resource_manage') {
        const path = args.path as string;
        const remaining = row!.resources?.filter((r) => r.path !== path) ?? [];
        if (args.action === 'upsert') {
          const resource = { mimeType: args.mimeType as string, content: args.content as string, encoding: args.encoding as 'utf8' | 'base64', size: String(args.content).length };
          resources.set(`${ref}:${path}`, resource); remaining.push({ ...resource, path });
        } else resources.delete(`${ref}:${path}`);
        nodes.set(ref, { ...row!, version, resources: remaining });
      } else if (args.action === 'upsert') {
        map.set(ref, { ...row, ref, name: args.name as string, description: args.description as string,
          enabled: args.enabled as boolean, default: args.default as boolean, version, resources: row?.resources ?? [] });
        if (name === 'skill_manage') bodies.set(ref, args.markdown as string);
      } else map.set(ref, { ...row!, version, deleted: args.action === 'delete' });
      return { version };
    },
  };
  const createApi = (_endpoint: string, _token: string, expired: () => void) => { expire = expired; return api as unknown as DashboardApi; };
  return { api, createApi, categories, nodes, bodies, resources, calls, expire: () => expire() };
}
async function connect(f: ReturnType<typeof fixture>) {
  const user = userEvent.setup(); render(<App createApi={f.createApi} />);
  await user.type(screen.getByLabelText('Admin token'), 'test-token');
  await user.click(screen.getByRole('button', { name: 'Connect to service' }));
  await screen.findByRole('heading', { name: 'Overview', level: 1 });
  return user;
}
async function openGit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Catalog' }));
  await user.click(await screen.findByRole('button', { name: 'Open general/git' }));
  await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Git'));
}
beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(window, 'confirm').mockReturnValue(true); });

describe('dashboard workflows', () => {
  it('connects, forgets credentials on logout and clears all loaded data on expiry', async () => {
    const f = fixture(); const user = await connect(f);
    await user.click(screen.getByRole('button', { name: 'Connection' }));
    expect(screen.getByText('test-account')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change connection' }));
    expect(screen.getByLabelText('Admin token')).toHaveValue('');
    expect(screen.queryByText('test-account')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Service URL'), 'http://127.0.0.1:8080/mcp');
    await user.type(screen.getByLabelText('Admin token'), 'next-token');
    await user.click(screen.getByRole('button', { name: 'Connect to service' }));
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    f.expire();
    await screen.findByLabelText('Admin token');
    expect(screen.getByLabelText('Admin token')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Catalog' })).toBeDisabled();
    expect(f.api.dispose).toHaveBeenCalled();
  });

  it('creates and edits categories, changes default and enable flags, archives and restores', async () => {
    const f = fixture(); const user = await connect(f);
    await user.click(screen.getByRole('button', { name: 'Catalog' }));
    await user.click(await screen.findByRole('tab', { name: 'Categories' }));
    await user.click(screen.getByRole('button', { name: 'New category' }));
    await user.type(screen.getByLabelText('Category ID'), 'docs');
    await user.type(screen.getByLabelText('Name'), 'Documentation');
    await user.click(screen.getByLabelText('Default category'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.categories.get('docs')).toMatchObject({ version: 1, default: true });
    expect(screen.getByLabelText('Category ID')).toHaveAttribute('readonly');
    await user.click(screen.getByLabelText('Enabled'));
    await user.type(screen.getByLabelText('Description'), 'Reference skills');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(f.categories.get('docs')).toMatchObject({ version: 2, enabled: false, description: 'Reference skills' }));
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await screen.findByRole('button', { name: 'Restore' });
    expect(f.categories.get('docs')?.deleted).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await screen.findByRole('button', { name: 'Archive' });
    expect(f.categories.get('docs')).toMatchObject({ version: 4, deleted: false });
  });

  it('edits Markdown, provides a safe preview and creates a subskill', async () => {
    const f = fixture(); const user = await connect(f); await openGit(user);
    const markdown = screen.getByLabelText(/^Markdown/);
    fireEvent.change(markdown, { target: { value: '# Review\n\n**Strong**\n\n<script>dangerous()</script>\n\n[Bad](javascript:alert(1))' } });
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument();
    expect(document.querySelector('.markdown-preview script')).toBeNull();
    expect(screen.getByText('Bad').getAttribute('href')).not.toMatch(/^javascript:/);
    await user.click(screen.getByRole('tab', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.bodies.get('general/git')).toContain('# Review');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'New skill' }));
    await user.type(screen.getByLabelText('Reference'), 'general/git/review');
    await user.type(screen.getByLabelText('Name'), 'Review child');
    await user.type(screen.getByLabelText(/^Markdown/), '# Child');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.nodes.get('general/git/review')?.version).toBe(1);
  });

  it('uploads, edits and deletes resources with parent versions and confirmation', async () => {
    const f = fixture(); const user = await connect(f); await openGit(user);
    await user.click(screen.getByRole('tab', { name: /Resources/ }));
    await user.upload(screen.getByLabelText('Upload resource'), new File(['first content'], 'notes.txt', { type: 'text/plain' }));
    await screen.findByLabelText('Text content');
    await user.click(screen.getByRole('button', { name: 'Save resource' }));
    await screen.findByRole('button', { name: 'notes.txt' });
    expect(f.nodes.get('general/git')?.version).toBe(2);
    await user.click(screen.getByRole('button', { name: 'notes.txt' }));
    await waitFor(() => expect(screen.getByLabelText('Text content')).toHaveValue('first content'));
    await user.clear(screen.getByLabelText('Text content')); await user.type(screen.getByLabelText('Text content'), 'edited content');
    await user.click(screen.getByRole('button', { name: 'Save resource' }));
    await waitFor(() => expect(f.resources.get('general/git:notes.txt')?.content).toBe('edited content'));
    await user.click(screen.getByRole('button', { name: 'Delete notes.txt' }));
    await screen.findByText('No bundled resources');
    expect(f.nodes.get('general/git')?.version).toBe(4);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Delete notes.txt'));
    expect(f.calls.filter((c) => c.name === 'resource_manage').map((c) => c.args.expectedVersion)).toEqual([1, 2, 3]);
  });

  it('keeps a draft through a conflict and loading latest, then saves only after an explicit choice', async () => {
    const f = fixture(); const user = await connect(f); await openGit(user);
    await user.clear(screen.getByLabelText(/^Markdown/)); await user.type(screen.getByLabelText(/^Markdown/), '# My draft');
    f.nodes.set('general/git', { ...f.nodes.get('general/git')!, version: 2 }); f.bodies.set('general/git', '# Remote edit');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Your draft is safe.');
    expect(screen.getByLabelText(/^Markdown/)).toHaveValue('# My draft');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Load latest version' }));
    await screen.findByText('Server version v2');
    expect(screen.getByLabelText(/^Markdown/)).toHaveValue('# My draft');
    expect(f.bodies.get('general/git')).toBe('# Remote edit');
    await user.click(screen.getByRole('button', { name: 'Keep draft on v2' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.bodies.get('general/git')).toBe('# My draft');
    expect(f.nodes.get('general/git')?.version).toBe(3);
  });

  it('warns on unsaved changes and leaves a cancelled draft intact', async () => {
    const f = fixture(); const user = await connect(f); await openGit(user);
    await user.type(screen.getByLabelText('Name'), ' changed');
    vi.mocked(window.confirm).mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Git changed');
    const event = new Event('beforeunload', { cancelable: true });
    fireEvent(window, event);
    expect(event.defaultPrevented).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(f.nodes.get('general/git')?.deleted).toBeUndefined();
  });

  it('preserves a resource draft through a conflict and uses a reviewed current parent version', async () => {
    const f = fixture(); const user = await connect(f); await openGit(user);
    await user.click(screen.getByRole('tab', { name: /Resources/ }));
    await user.click(screen.getByRole('button', { name: 'New text resource' }));
    await user.type(screen.getByLabelText('Resource path'), 'guide.md');
    await user.type(screen.getByLabelText('Text content'), '# Local resource');
    f.nodes.set('general/git', { ...f.nodes.get('general/git')!, version: 2 });
    f.bodies.set('general/git', '# Remote Markdown');
    await user.click(screen.getByRole('button', { name: 'Save resource' }));
    await screen.findByText('Your draft is safe.');
    expect(screen.getByLabelText('Text content')).toHaveValue('# Local resource');
    await user.click(screen.getByRole('button', { name: 'Load latest version' }));
    await screen.findByText('Server version v2');
    expect(screen.getByLabelText('Text content')).toHaveValue('# Local resource');
    await user.click(screen.getByRole('button', { name: 'Keep draft on v2' }));
    expect(screen.getByLabelText('Text content')).toHaveValue('# Local resource');
    await user.click(screen.getByRole('button', { name: 'Save resource' }));
    await waitFor(() => expect(f.resources.get('general/git:guide.md')?.content).toBe('# Local resource'));
    expect(f.nodes.get('general/git')?.version).toBe(3);
    expect(f.bodies.get('general/git')).toBe('# Remote Markdown');
  });

  it('downloads the original resource bytes as an attachment', async () => {
    const f = fixture();
    f.nodes.get('general/git')!.resources = [{ path: 'binary.bin', mimeType: 'application/octet-stream', encoding: 'base64', size: 4 }];
    f.resources.set('general/git:binary.bin', { content: 'AAEC/w==', mimeType: 'application/octet-stream', encoding: 'base64', size: 4 });
    const createURL = vi.fn((_blob: Blob) => 'blob:resource');
    const originalCreate = URL.createObjectURL; const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createURL; URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('binary.bin'); expect(this.href).toBe('blob:resource');
    });
    try {
      const user = await connect(f); await openGit(user);
      await user.click(screen.getByRole('tab', { name: /Resources/ }));
      await user.click(screen.getByRole('button', { name: 'Download binary.bin' }));
      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      expect(createURL).toHaveBeenCalledWith(expect.any(Blob));
      expect(createURL.mock.calls[0][0].type).toBe('application/octet-stream');
    } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
  });

  it('filters the catalog and opens read-only audit details', async () => {
    const f = fixture(); const user = await connect(f);
    await user.click(screen.getByRole('button', { name: 'Catalog' }));
    await screen.findByRole('button', { name: 'Open general/git' });
    await user.type(screen.getByLabelText('Search catalog'), 'missing');
    await screen.findByText('No items found');
    await user.click(screen.getByRole('button', { name: 'Activity' }));
    const row = await screen.findByText('skill.upsert');
    await user.click(within(row.closest('tr')!).getByRole('button'));
    await screen.findByRole('heading', { name: 'Activity event' });
    expect(screen.getByText('Event ID')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restore|save/i })).not.toBeInTheDocument();
  });

  it('follows list cursors, resets on filters and discovers category choices beyond the first page', async () => {
    const f = fixture();
    for (let i = 0; i < 55; i++) f.categories.set(`category-${i}`, { ref: `category-${i}`, name: `Category ${i}`, version: 1 });
    for (let i = 0; i < 22; i++) f.nodes.set(`general/skill-${i}`, { ref: `general/skill-${i}`, name: `Skill ${i}`, version: 1 });
    const user = await connect(f);
    await user.click(screen.getByRole('button', { name: 'Catalog' }));
    await screen.findByRole('button', { name: 'Open general/git' });
    await screen.findByRole('option', { name: 'Category 54' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2');
    await screen.findByRole('button', { name: 'Open general/skill-21' });
    expect(screen.queryByRole('button', { name: 'Open general/git' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByRole('button', { name: 'Open general/git' });
    await user.selectOptions(screen.getByLabelText('Filter category'), 'category-54');
    await screen.findByText('No items found');
    expect(screen.getByText('Page 1')).toBeInTheDocument();
    expect(f.calls.some((c) => c.name === 'category_manage' && c.args.cursor === 'page:50')).toBe(true);
  });
});
