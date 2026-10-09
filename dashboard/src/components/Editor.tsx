import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, FileText, GitBranch, Paperclip, Save } from 'lucide-react';
import { ApiError, DashboardApi, errorMessage } from '../api';
import type { Content, Entity, Resource } from '../types';
import { entityName } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Badge } from './ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet';
import { ErrorNotice, Status } from './shared';
import { Resources } from './Resources';

interface Draft { ref: string; name: string; description: string; enabled: boolean; default: boolean; markdown: string; version: number; deleted: boolean; resources: Resource[] }
const blank = (ref: string): Draft => ({ ref, name: '', description: '', enabled: true, default: false, markdown: '', version: 0, deleted: false, resources: [] });
const toDraft = (entity: Entity, content?: Content): Draft => ({
  ...blank(entity.ref), name: entityName(entity), description: entity.description ?? '', enabled: entity.enabled !== false,
  default: entity.default ?? false, deleted: entity.deleted ?? false, markdown: content?.markdown ?? '',
  version: entity.version, resources: content?.resources ?? entity.resources ?? [],
});
const editable = (draft: Draft) => JSON.stringify([draft.ref, draft.name, draft.description, draft.enabled, draft.default, draft.markdown]);

export function Editor({ api, kind, initialRef, isNew, onClose, onChanged, onDirty }: {
  api: DashboardApi; kind: 'skill' | 'category'; initialRef: string; isNew: boolean;
  onClose: () => void; onChanged: () => void; onDirty: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => blank(initialRef));
  const [base, setBase] = useState(() => blank(initialRef));
  const [creating, setCreating] = useState(isNew);
  const [busy, setBusy] = useState(!isNew);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'edit' | 'preview' | 'resources'>('edit');
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Draft>();
  const [resourceDirty, setResourceDirty] = useState(false);
  const [resourceEpoch, setResourceEpoch] = useState(0);
  const mainDirty = editable(draft) !== editable(base);
  const dirty = mainDirty || resourceDirty;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const read = useCallback(async (ref: string): Promise<Draft> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const metadata = await api.tool<{ category?: Entity; skill?: Entity }>(kind === 'category' ? 'category_manage' : 'skill_manage', {
        action: 'get', ...(kind === 'category' ? { id: ref } : { ref }), includeDeleted: true,
      });
      const entity = (kind === 'category' ? metadata.category : metadata.skill)!;
      const content = kind === 'skill' ? await api.content(ref) : undefined;
      if (!content || content.version === entity.version) return toDraft(entity, content);
    }
    throw new ApiError('VERSION_CONFLICT');
  }, [api, kind]);
  useEffect(() => {
    if (isNew) return;
    let active = true;
    read(initialRef).then((value) => { if (active) { setDraft(value); setBase(value); } })
      .catch((e) => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [initialRef, isNew, read]);
  const close = () => { if (!busy && (!dirty || window.confirm('Discard unsaved changes? Your draft will be lost.'))) onClose(); };
  const failure = (e: unknown) => {
    setNotice(''); setError(errorMessage(e));
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { setConflict(true); setLatest(undefined); }
  };
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => { setDraft((d) => ({ ...d, [key]: value })); setNotice(''); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    if (kind === 'skill' && (new TextEncoder().encode(draft.markdown).length > 256 * 1024 || draft.markdown.includes('\0'))) {
      setError('Markdown must be text no larger than 256 KiB.'); setBusy(false); return;
    }
    try {
      const result = await api.tool<{ version: number }>(kind === 'category' ? 'category_manage' : 'skill_manage', {
        action: 'upsert', ...(kind === 'category' ? { id: draft.ref, default: draft.default } : { ref: draft.ref, markdown: draft.markdown }),
        name: draft.name, description: draft.description, enabled: draft.enabled, expectedVersion: draft.version,
      });
      const saved = { ...draft, version: result.version };
      setDraft(saved); setBase(saved); setCreating(false); setNotice('Changes saved.'); onChanged();
    } catch (e) { failure(e); } finally { setBusy(false); }
  };
  const lifecycle = async () => {
    if (dirty && !window.confirm('Discard unsaved changes before changing archive state?')) return;
    if (!draft.deleted && !window.confirm(`Archive ${draft.ref}? This can be restored later.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.tool(kind === 'category' ? 'category_manage' : 'skill_manage', { action: draft.deleted ? 'restore' : 'delete',
        ...(kind === 'category' ? { id: draft.ref } : { ref: draft.ref }), expectedVersion: draft.version });
      const value = await read(draft.ref); setDraft(value); setBase(value); setConflict(false); setLatest(undefined);
      setResourceEpoch((n) => n + 1); setResourceDirty(false); onChanged();
    } catch (e) { failure(e); } finally { setBusy(false); }
  };
  const loadLatest = async () => {
    setBusy(true);
    try { setLatest(await read(draft.ref)); } catch (e) { failure(e); } finally { setBusy(false); }
  };
  const adopt = (keepDraft: boolean) => {
    if (!latest) return;
    if (!keepDraft && dirty && !window.confirm('Replace your draft with the current server version?')) return;
    setBase(latest); setDraft(keepDraft && mainDirty ? { ...draft, version: latest.version, deleted: latest.deleted, resources: latest.resources } : latest);
    if (!keepDraft) { setResourceDirty(false); setResourceEpoch((n) => n + 1); }
    setConflict(false); setLatest(undefined); setError('');
  };
  const resourcesChanged = async (version: number) => {
    onChanged();
    try {
      const value = await read(draft.ref);
      if (value.version !== version) throw new ApiError('VERSION_CONFLICT');
      setDraft(value); setBase(value); setNotice('Resources updated.');
    } catch (e) { failure(e); }
  };
  const navigateTab = (next: typeof tab) => {
    if (next !== 'resources' && resourceDirty) return;
    setTab(next);
  };
  return <Sheet open onOpenChange={(open) => { if (!open) close(); }}><SheetContent className="editor-sheet">
    <SheetHeader><div className="eyebrow">{kind === 'category' ? 'CATEGORY' : initialRef.split('/').length === 3 ? 'SUBSKILL' : 'SKILL'} DETAILS</div><SheetTitle>{creating ? `New ${kind}` : draft.name || initialRef}</SheetTitle><SheetDescription>{creating ? 'Create an item in your shared catalog.' : draft.ref}</SheetDescription></SheetHeader>
    <div className="editor-body">
      {!creating && <div className="editor-status"><Status entity={draft} /><Badge variant="outline">v{draft.version}</Badge>{dirty && <span className="muted">Unsaved changes</span>}</div>}
      <ErrorNotice>{error}</ErrorNotice>{notice && <div role="status" className="success-notice"><Check size={14} />{notice}</div>}
      {conflict && <div className="conflict-panel"><strong>Your draft is safe.</strong><p>Load the current version to review the changes before choosing an editing base.</p><Button size="sm" variant="outline" disabled={busy} onClick={() => void loadLatest()}>Load latest version</Button>
        {latest && <div className="latest-version"><h3>Server version v{latest.version}</h3><p><strong>{latest.name}</strong> · {latest.deleted ? 'Archived' : latest.enabled ? 'Active' : 'Disabled'}</p><p>{latest.description}</p>{kind === 'category' && <p>Default: {latest.default ? 'yes' : 'no'}</p>}{kind === 'skill' && <pre>{latest.markdown}</pre>}<div className="actions"><Button variant="outline" size="sm" onClick={() => adopt(false)}>Replace draft with latest</Button><Button size="sm" disabled={latest.deleted} onClick={() => adopt(true)}>Keep draft on v{latest.version}</Button></div><p className="field-hint">Keeping the draft uses this version as the base. Save again to apply your changes.</p></div>}
      </div>}
      {kind === 'skill' && <div className="catalog-tabs editor-tabs" role="tablist" aria-label="Skill details">{([{ value: 'edit', label: 'Edit', icon: FileText }, { value: 'preview', label: 'Preview', icon: GitBranch }, { value: 'resources', label: 'Resources', icon: Paperclip }] as const).map(({ value, label, icon: Icon }) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => navigateTab(value)} disabled={value === 'resources' && creating || value !== 'resources' && resourceDirty}><Icon size={14} />{label}{value === 'resources' && <span>{draft.resources.length}</span>}</button>)}</div>}
      {tab === 'edit' && <form onSubmit={save} className="form-stack" aria-label={`${kind} editor`}><fieldset disabled={busy || draft.deleted}>
        <label>{kind === 'category' ? 'Category ID' : 'Reference'}<Input value={draft.ref} onChange={(e) => change('ref', e.target.value)} required readOnly={!creating} pattern={kind === 'category' ? '[a-z0-9][a-z0-9-]{0,63}' : '[a-z0-9][a-z0-9-]{0,63}/[a-z0-9][a-z0-9-]{0,63}(/[a-z0-9][a-z0-9-]{0,63})?'} placeholder={kind === 'category' ? 'development' : 'development/code-review'} /></label>
        {creating && <p className="field-hint">{kind === 'skill' ? 'Use category/skill or category/skill/subskill. Create the parent first.' : 'Lowercase letters, digits and hyphens. The ID stays fixed after creation.'}</p>}
        <label>Name<Input value={draft.name} onChange={(e) => change('name', e.target.value)} required maxLength={120} /></label>
        <label>Description<Textarea value={draft.description} onChange={(e) => change('description', e.target.value)} maxLength={1000} rows={3} /></label>
        <div className="settings-row"><label className="checkbox-label"><input type="checkbox" checked={draft.enabled} onChange={(e) => change('enabled', e.target.checked)} />Enabled</label>{kind === 'category' && <label className="checkbox-label"><input type="checkbox" checked={draft.default} onChange={(e) => change('default', e.target.checked)} />Default category</label>}</div>
        {kind === 'skill' && <label>Markdown<Textarea className="markdown-input mono" rows={14} value={draft.markdown} onChange={(e) => change('markdown', e.target.value)} spellCheck={false} /><span className="field-hint">{new TextEncoder().encode(draft.markdown).length.toLocaleString()} / 262,144 bytes</span></label>}
        </fieldset><Button type="submit" disabled={busy || draft.deleted || conflict || resourceDirty}><Save size={14} />{busy ? 'Working…' : 'Save changes'}</Button>
      </form>}
      {tab === 'preview' && <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span className="muted">[Image: {alt ?? 'image'}]</span>, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{draft.markdown || '*No Markdown yet.*'}</ReactMarkdown></div>}
      {tab === 'resources' && !creating && <Resources key={resourceEpoch} api={api} entity={draft} mainDirty={mainDirty} blocked={draft.deleted || conflict || busy} onDirty={setResourceDirty} onChanged={resourcesChanged} onConflict={failure} />}
      {!creating && <div className="archive-zone"><div><strong>{draft.deleted ? 'Restore this item' : 'Archive this item'}</strong><p>{draft.deleted ? 'Make it available to the catalog again.' : 'Remove it from agent discovery. Restore it at any time.'}</p></div><Button variant="outline" size="sm" disabled={busy || conflict} onClick={() => void lifecycle()}>{draft.deleted ? 'Restore' : 'Archive'}</Button></div>}
    </div>
  </SheetContent></Sheet>;
}
