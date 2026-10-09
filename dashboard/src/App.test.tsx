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
    async catalog(params: Record<string, string | undefined>) {
      calls.push({ name: 'catalog', args: params });
      const state = (row: Entity, skill: boolean): Entity['state'] => {
        const category = skill ? categories.get(row.ref.split('/')[0]) : undefined;
        const parent = skill && row.ref.split('/').length === 3 ? nodes.get(row.ref.split('/').slice(0, 2).join('/')) : undefined;
        return row.deleted || category?.deleted || parent?.deleted ? 'archived' : row.enabled === false || category?.enabled === false || parent?.enabled === false ? 'disabled' : 'active';
      };
      const available = (status: Entity['state']) => (params.includeDeleted === 'true' || status !== 'archived') && (params.includeDisabled === 'true' || status !== 'disabled');
      const skills = [...nodes.values()].map((row) => ({ ...row, state: state(row, true), categoryName: categories.get(row.ref.split('/')[0])?.name })).filter((row) => available(row.state));
      const items = (params.kind === 'category' ? [...categories.values()].map((row) => ({ ...row, state: state(row, false), skillCount: skills.filter((skill) => skill.ref.startsWith(`${row.ref}/`)).length })) : skills)
        .filter((row) => available(row.state) && (!params.categoryId || row.ref.startsWith(`${params.categoryId}/`))
          && (!params.query || `${row.ref} ${row.name} ${row.description}`.toLowerCase().includes(params.query.toLowerCase())));
      const totalPages = Math.max(1, Math.ceil(items.length / Number(params.limit ?? 20)));
      const page = Math.min(Number(params.page ?? 1), totalPages);
      const limit = Number(params.limit ?? 20);
      return { items: items.slice((page - 1) * limit, page * limit), total: items.length, totalPages, page, limit };
    },
    async tool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const map = name === 'category_manage' ? categories : nodes;
      const ref = (args.id ?? args.ref) as string;
      const previousRef = args.previousRef as string | undefined;
      const row = map.get(previousRef ?? ref);
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
      if (previousRef && previousRef !== ref) {
        if (map.has(ref)) throw new ApiError('REF_ALREADY_EXISTS');
        const moving = [...nodes.values()].filter((value) => value.ref === previousRef || value.ref.startsWith(`${previousRef}/`));
        for (const value of moving) {
          const target = ref + value.ref.slice(previousRef.length);
          nodes.set(target, { ...value, ref: target, version: value.version + (value.ref === previousRef ? 0 : 1) });
          nodes.delete(value.ref); bodies.set(target, bodies.get(value.ref)!); bodies.delete(value.ref);
          for (const [key, resource] of [...resources]) if (key.startsWith(`${value.ref}:`)) {
            resources.set(target + key.slice(value.ref.length), resource); resources.delete(key);
          }
        }
      }
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
  await user.click(await screen.findByRole('row', { name: 'Skill Git' }));
  await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Git'));
}
async function chooseCategory(user: ReturnType<typeof userEvent.setup>, name = 'General') {
  await user.click(screen.getByRole('button', { name: 'Choose category' }));
  await user.click(await screen.findByRole('option', { name }));
}
beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(window, 'confirm').mockReturnValue(true); });

describe('dashboard workflows', () => {
  it('shows category names, hides disabled skills by default and opens a skill from any cell', async () => {
    const f = fixture(); f.nodes.set('general/hidden', { ref: 'general/hidden', name: 'Hidden', version: 1, enabled: false });
    const user = await connect(f); await user.click(screen.getByRole('button', { name: 'Catalog' }));
    const row = await screen.findByRole('row', { name: 'Skill Git' });
    expect(within(row).getByText('General')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Reference' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Open / })).not.toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'Skill Hidden' })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Show disabled'));
    await screen.findByRole('row', { name: 'Skill Hidden' });
    await user.click(within(screen.getByRole('row', { name: 'Skill Git' })).getByText('General'));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Git'));
  });

  it('opens category skills with the keyboard, edits a nested skill and archives with X using the current version', async () => {
    const f = fixture(); f.nodes.set('general/extra', { ref: 'general/extra', name: 'Extra', enabled: true, version: 1 }); f.bodies.set('general/extra', '# Extra');
    const user = await connect(f); await user.click(screen.getByRole('button', { name: 'Catalog' }));
    await user.click(await screen.findByRole('tab', { name: 'Categories' }));
    const row = await screen.findByRole('row', { name: 'Category General' });
    expect(within(row).getByText('2')).toBeInTheDocument();
    row.focus(); await user.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Edit Git' });
    await user.click(screen.getByRole('button', { name: 'Edit Git' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Git'));
    await user.type(screen.getByLabelText('Name'), ' updated');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await screen.findByRole('button', { name: 'Edit Git updated' });
    await user.click(screen.getByRole('button', { name: 'Remove Extra from category' }));
    await waitFor(() => expect(f.nodes.get('general/extra')?.deleted).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Extra' })).not.toBeInTheDocument());
    expect(f.calls.find((call) => call.args.action === 'delete' && call.args.ref === 'general/extra')?.args.expectedVersion).toBe(1);
    expect(within(screen.getByRole('region', { name: 'Category skills' })).getByText('Page 1 of 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(screen.getByRole('row', { name: 'Category General' })).getByText('1')).toBeInTheDocument());
  });

  it('creates a category from the searchable menu and keeps the new skill disabled', async () => {
    const f = fixture(); const user = await connect(f);
    await user.click(screen.getByRole('button', { name: 'Catalog' }));
    await user.click(await screen.findByRole('button', { name: 'New skill' }));
    expect(screen.getByLabelText('Enabled')).not.toBeChecked();
    await user.type(screen.getByRole('combobox', { name: 'Category' }), 'Design tools');
    await user.click(await screen.findByRole('option', { name: 'New category “Design tools”' }));
    await user.type(screen.getByLabelText('Name'), 'Sketch');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.categories.get('design-tools')).toMatchObject({ name: 'Design tools', default: false, enabled: true, version: 1 });
    expect(f.nodes.get('design-tools/sketch')).toMatchObject({ name: 'Sketch', enabled: false, version: 1 });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('row', { name: 'Skill Sketch' })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Show disabled'));
    expect(within(await screen.findByRole('row', { name: 'Skill Sketch' })).getByText('Design tools')).toBeInTheDocument();
  });

  it('reuses a category created concurrently without overwriting its metadata', async () => {
    const f = fixture(); const user = await connect(f);
    await user.click(screen.getByRole('button', { name: 'Catalog' }));
    await user.click(await screen.findByRole('button', { name: 'New skill' }));
    await user.type(screen.getByRole('combobox', { name: 'Category' }), 'Team');
    await user.click(await screen.findByRole('option', { name: 'New category “Team”' }));
    f.categories.set('team', { ref: 'team', name: 'Existing team', description: 'Preserved', version: 1 });
    await user.type(screen.getByLabelText('Name'), 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.categories.get('team')).toMatchObject({ name: 'Existing team', description: 'Preserved', version: 1 });
    expect(f.nodes.get('team/review')?.enabled).toBe(false);
  });

  it('keeps the existing reference when reviewing a new skill collision with a different display name', async () => {
    const f = fixture(); f.nodes.get('general/git')!.name = 'Git toolbox';
    const user = await connect(f); await user.click(screen.getByRole('button', { name: 'Catalog' }));
    await user.click(await screen.findByRole('button', { name: 'New skill' }));
    await chooseCategory(user); await user.type(screen.getByLabelText('Name'), 'Git');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Your draft is safe.');
    await user.click(screen.getByRole('button', { name: 'Load latest version' }));
    await screen.findByText('Server version v1');
    await user.click(screen.getByRole('button', { name: 'Replace draft with latest' }));
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('General');
    expect(screen.getByLabelText('Reference skill name')).toHaveValue('git');
    expect(screen.getByLabelText('Reference skill name')).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('Name')).toHaveValue('Git toolbox');
    await user.type(screen.getByLabelText('Name'), ' updated');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.nodes.get('general/git')).toMatchObject({ name: 'Git toolbox updated', version: 2 });
    expect(f.nodes.has('general/git-toolbox-updated')).toBe(false);
    expect(f.calls.filter((call) => call.name === 'skill_manage' && call.args.action === 'upsert').at(-1)?.args)
      .toMatchObject({ ref: 'general/git', expectedVersion: 1 });
  });

  it('shows only the category beneath the skill name and saves an editable reference without losing resources', async () => {
    const f = fixture(); f.categories.set('tools', { ref: 'tools', name: 'Development tools', version: 1 });
    f.nodes.get('general/git')!.resources = [{ path: 'guide.md', mimeType: 'text/markdown', encoding: 'utf8', size: 5 }];
    f.resources.set('general/git:guide.md', { content: 'Guide', mimeType: 'text/markdown', encoding: 'utf8', size: 5 });
    const user = await connect(f); await openGit(user);
    const description = screen.getByRole('dialog', { name: 'Git' }).getAttribute('aria-describedby')!;
    expect(document.getElementById(description)).toHaveTextContent(/^General$/);
    expect(screen.queryByLabelText('Reference')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('General');
    expect(screen.getByLabelText('Reference skill name')).toHaveValue('git');
    await chooseCategory(user, 'Development tools');
    await user.clear(screen.getByLabelText('Reference skill name')); await user.type(screen.getByLabelText('Reference skill name'), 'version-control');
    expect(document.getElementById(description)).toHaveTextContent(/^Development tools$/);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.calls.find((call) => call.args.previousRef === 'general/git')?.args)
      .toMatchObject({ action: 'upsert', ref: 'tools/version-control', previousRef: 'general/git', expectedVersion: 1 });
    expect(f.nodes.has('general/git')).toBe(false);
    expect(f.bodies.get('tools/version-control')).toBe('# Git\n');
    await user.click(screen.getByRole('tab', { name: /Resources/ }));
    await user.click(await screen.findByRole('button', { name: 'guide.md' }));
    await waitFor(() => expect(screen.getByLabelText('Text content')).toHaveValue('Guide'));
  });

  it('reviews the original skill after a reference-change conflict and retries the move with its current version', async () => {
    const f = fixture(); const user = await connect(f); await openGit(user);
    await user.clear(screen.getByLabelText('Reference skill name')); await user.type(screen.getByLabelText('Reference skill name'), 'new-git');
    f.nodes.get('general/git')!.version = 2; f.bodies.set('general/git', '# Remote edit');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Your draft is safe.');
    await user.click(screen.getByRole('button', { name: 'Load latest version' }));
    await screen.findByText('Server version v2');
    expect(screen.getByLabelText('Reference skill name')).toHaveValue('new-git');
    await user.click(screen.getByRole('button', { name: 'Keep draft on v2' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.nodes.get('general/new-git')?.version).toBe(3);
    expect(f.calls.filter((call) => call.args.previousRef === 'general/git').at(-1)?.args.expectedVersion).toBe(2);
  });

  it('keeps resource reads and archive actions on the saved reference until a changed reference is saved', async () => {
    const f = fixture();
    f.nodes.get('general/git')!.resources = [{ path: 'guide.md', mimeType: 'text/markdown', encoding: 'utf8', size: 5 }];
    f.resources.set('general/git:guide.md', { content: 'Guide', mimeType: 'text/markdown', encoding: 'utf8', size: 5 });
    const user = await connect(f); await openGit(user);
    await user.clear(screen.getByLabelText('Reference skill name')); await user.type(screen.getByLabelText('Reference skill name'), 'unsaved');
    await user.click(screen.getByRole('tab', { name: /Resources/ }));
    await user.click(screen.getByRole('button', { name: 'guide.md' }));
    await waitFor(() => expect(screen.getByLabelText('Text content')).toHaveValue('Guide'));
    expect(screen.getByRole('button', { name: 'Save resource' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await screen.findByRole('button', { name: 'Restore' });
    expect(f.nodes.get('general/git')?.deleted).toBe(true);
    expect(f.nodes.has('general/unsaved')).toBe(false);
    await user.click(screen.getByRole('tab', { name: 'Edit' }));
    expect(screen.getByLabelText('Reference skill name')).toHaveValue('git');
  });

  it('creates a category while editing an existing skill and preserves its reference name', async () => {
    const f = fixture(); const user = await connect(f); await openGit(user);
    await user.clear(screen.getByRole('combobox', { name: 'Category' }));
    await user.type(screen.getByRole('combobox', { name: 'Category' }), 'Version control');
    await user.click(await screen.findByRole('option', { name: 'New category “Version control”' }));
    expect(screen.getByLabelText('Reference skill name')).toHaveValue('git');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.categories.get('version-control')?.name).toBe('Version control');
    expect(f.nodes.get('version-control/git')).toMatchObject({ name: 'Git', version: 2 });
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Version control');
    expect(screen.getByLabelText('Reference skill name')).toHaveValue('git');
    expect(screen.queryByText('Version control will be created when you save.')).not.toBeInTheDocument();
  });

  it('restores both reference fields when replacing a conflicting draft with the current skill', async () => {
    const f = fixture(); f.categories.set('tools', { ref: 'tools', name: 'Tools', version: 1 });
    const user = await connect(f); await openGit(user); await chooseCategory(user, 'Tools');
    await user.clear(screen.getByLabelText('Reference skill name')); await user.type(screen.getByLabelText('Reference skill name'), 'new-git');
    f.nodes.get('general/git')!.version = 2;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Your draft is safe.');
    await user.click(screen.getByRole('button', { name: 'Load latest version' }));
    await screen.findByText('Server version v2');
    await user.click(screen.getByRole('button', { name: 'Replace draft with latest' }));
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('General');
    expect(screen.getByLabelText('Reference skill name')).toHaveValue('git');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.nodes.get('general/git')?.version).toBe(3);
    expect(f.nodes.has('tools/new-git')).toBe(false);
  });

  it('keeps navigation and logout usable when the sidebar is collapsed', async () => {
    const f = fixture(); const user = await connect(f);
    expect(screen.getByRole('button', { name: 'Log out' }).closest('aside')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Close sidebar' }));
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: 'Catalog' }));
    await screen.findByRole('row', { name: 'Skill Git' });
    await user.click(screen.getByRole('button', { name: 'Open sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await screen.findByLabelText('Admin token');
    expect(screen.getByRole('button', { name: 'Catalog' })).toBeDisabled();
  });

  it('imports a skill file and creates it with only a reference entered manually', async () => {
    const f = fixture(); const user = await connect(f);
    await user.click(screen.getByRole('button', { name: 'Catalog' }));
    await user.click(await screen.findByRole('button', { name: 'New skill' }));
    const markdown = '---\nname: Review\ndescription: Review proposed changes.\n---\n# Review\n\nRead the diff.\n';
    const file = new File([markdown], 'SKILL.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(markdown).buffer });
    await user.upload(screen.getByLabelText('Import skill file', { selector: 'input' }), file);
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Review'));
    expect(screen.getByLabelText('Description')).toHaveValue('Review proposed changes.');
    expect(screen.getByLabelText(/^Markdown/)).toHaveValue(markdown);
    await chooseCategory(user);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(f.nodes.get('general/review')).toMatchObject({ name: 'Review', description: 'Review proposed changes.', version: 1, enabled: false });
    expect(f.bodies.get('general/review')).toBe(markdown);
    expect(f.calls.find((call) => call.args.ref === 'general/review' && call.args.action === 'upsert')?.args.expectedVersion).toBe(0);
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('preserves the reference and existing draft when an imported file is invalid or replacement is cancelled', async () => {
    const f = fixture(); const user = await connect(f);
    await user.click(screen.getByRole('button', { name: 'Catalog' }));
    await user.click(await screen.findByRole('button', { name: 'New skill' }));
    await chooseCategory(user);
    const upload = screen.getByLabelText('Import skill file', { selector: 'input' });
    const markdownFile = (content: string) => {
      const file = new File([content], 'SKILL.md', { type: 'text/markdown' });
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer });
      return file;
    };
    await user.upload(upload, markdownFile('# Review'));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Review'));
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('General');
    expect(window.confirm).not.toHaveBeenCalled();
    await user.upload(upload, markdownFile('---\nname: [broken\n---\n'));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Name')).toHaveValue('Review');
    expect(screen.getByLabelText(/^Markdown/)).toHaveValue('# Review');
    vi.mocked(window.confirm).mockReturnValue(false);
    await user.upload(upload, markdownFile('# Different'));
    expect(screen.getByLabelText('Name')).toHaveValue('Review');
    expect(f.calls.some((call) => call.args.action === 'upsert')).toBe(false);
  });

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
    await chooseCategory(user);
    await user.type(screen.getByLabelText('Reference skill name'), 'git/review');
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
    await screen.findByRole('row', { name: 'Skill Git' });
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
    await screen.findByRole('row', { name: 'Skill Git' });
    await screen.findByRole('option', { name: 'Category 54' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 2');
    await screen.findByRole('row', { name: 'Skill Skill 21' });
    expect(screen.queryByRole('row', { name: 'Skill Git' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByRole('row', { name: 'Skill Git' });
    await user.selectOptions(screen.getByLabelText('Filter category'), 'category-54');
    await screen.findByText('No items found');
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
    expect(f.calls.some((c) => c.name === 'category_manage' && c.args.cursor === 'page:50')).toBe(true);
  });
});
