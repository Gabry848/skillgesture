import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, FileText, GitBranch, Paperclip, Save, Upload } from 'lucide-react';
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
import { MAX_MARKDOWN, readSkillFile } from '../lib/skill-file';
import { CategoryPicker, catalogId } from './CategoryPicker';
import type { CategoryChoice } from './CategoryPicker';
import { CategorySkills } from './CategorySkills';

interface Draft { ref: string; name: string; description: string; enabled: boolean; default: boolean; markdown: string; version: number; deleted: boolean; resources: Resource[] }
const blank = (ref: string, enabled = true): Draft => ({ ref, name: '', description: '', enabled, default: false, markdown: '', version: 0, deleted: false, resources: [] });
const toDraft = (entity: Entity, content?: Content): Draft => ({
  ...blank(entity.ref), name: entityName(entity), description: entity.description ?? '', enabled: entity.enabled !== false,
  default: entity.default ?? false, deleted: entity.deleted ?? false, markdown: content?.markdown ?? '',
  version: entity.version, resources: content?.resources ?? entity.resources ?? [],
});
const editable = (draft: Draft) => JSON.stringify([draft.ref, draft.name, draft.description, draft.enabled, draft.default, draft.markdown]);

export function Editor({ api, kind, initialRef, isNew, onClose, onChanged, onDirty, categories, showDisabled = false, showArchived = false }: {
  api: DashboardApi; kind: 'skill' | 'category'; initialRef: string; isNew: boolean;
  onClose: () => void; onChanged: () => void; onDirty: (value: boolean) => void;
  categories: Entity[]; showDisabled?: boolean; showArchived?: boolean;
}) {
  const [draft, setDraft] = useState(() => blank(initialRef, kind !== 'skill'));
  const [base, setBase] = useState(() => blank(initialRef, kind !== 'skill'));
  const [creating, setCreating] = useState(isNew);
  const [busy, setBusy] = useState(!isNew);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'edit' | 'preview' | 'resources' | 'skills'>(kind === 'category' && !isNew ? 'skills' : 'edit');
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Draft>();
  const [resourceDirty, setResourceDirty] = useState(false);
  const [resourceEpoch, setResourceEpoch] = useState(0);
  const upload = useRef<HTMLInputElement>(null);
  const [categoryChoice, setCategoryChoice] = useState<CategoryChoice | undefined>(() => {
    const category = categories.find((value) => value.ref === initialRef.split('/')[0]);
    return category ? { id: category.ref, name: entityName(category) } : undefined;
  });
  const [categoryEdited, setCategoryEdited] = useState(false);
  const [customId, setCustomId] = useState(initialRef.split('/').slice(1).join('/'));
  const skillId = customId || catalogId(draft.name) || 'skill';
  const newRef = categoryChoice ? `${categoryChoice.id}/${skillId}` : '';
  const [selectedSkill, setSelectedSkill] = useState<string>();
  const [childDirty, setChildDirty] = useState(false);
  const [childrenRevision, setChildrenRevision] = useState(0);
  const childrenChanged = () => { setChildrenRevision((value) => value + 1); onChanged(); };
  const mainDirty = editable(draft) !== editable(base) || kind === 'skill' && (categoryEdited || creating && customId !== initialRef.split('/').slice(1).join('/'));
  const dirty = mainDirty || resourceDirty || childDirty;
  const resetReference = (value: Draft) => {
    const id = value.ref.split('/')[0];
    const category = categories.find((item) => item.ref === id);
    setCategoryChoice(category ? { id, name: entityName(category), archived: category.deleted }
      : categoryChoice?.id === id ? { ...categoryChoice, isNew: false } : { id, name: id });
    setCustomId(value.ref.split('/').slice(1).join('/')); setCategoryEdited(false);
  };
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
    read(initialRef).then((value) => { if (active) { setDraft(value); setBase(value); resetReference(value); } })
      .catch((e) => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [initialRef, isNew, read]);
  const close = () => { if (!busy && (!dirty || window.confirm('Discard unsaved changes? Your draft will be lost.'))) onClose(); };
  const failure = (e: unknown) => {
    setNotice(''); setError(errorMessage(e));
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { setConflict(true); setLatest(undefined); }
  };
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => { setDraft((d) => ({ ...d, [key]: value })); setNotice(''); };
  const importFile = async (file?: File) => {
    if (!file || busy) return;
    if ((draft.name !== base.name || draft.description !== base.description || draft.markdown !== base.markdown)
      && !window.confirm('Replace the current name, description and Markdown with this file? The reference will be kept.')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const imported = await readSkillFile(file);
      setDraft((value) => ({ ...value, ...imported }));
      setNotice(`Imported ${file.name}.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to import this skill file.'); }
    finally { setBusy(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    if (kind === 'skill' && !categoryChoice) {
      setError('Choose a category or select New category before saving.'); setBusy(false); return;
    }
    if (kind === 'skill' && !creating && !customId) {
      setError('Enter the reference skill name before saving.'); setBusy(false); return;
    }
    if (kind === 'skill' && (new TextEncoder().encode(draft.markdown).length > MAX_MARKDOWN || draft.markdown.includes('\0'))) {
      setError('Markdown must be text no larger than 256 KiB.'); setBusy(false); return;
    }
    try {
      if (kind === 'skill' && categoryChoice?.isNew) {
        try {
          await api.tool('category_manage', { action: 'upsert', id: categoryChoice.id, name: categoryChoice.name, enabled: true, default: false, expectedVersion: 0 });
        } catch (e) {
          if (!(e instanceof ApiError && e.code === 'VERSION_CONFLICT')) throw e;
          const { category } = await api.tool<{ category: Entity }>('category_manage', { action: 'get', id: categoryChoice.id, includeDeleted: true });
          if (category.deleted) throw new ApiError('NODE_DELETED');
        }
        setCategoryChoice({ ...categoryChoice, isNew: false }); onChanged();
      }
      const ref = kind === 'skill' ? newRef : draft.ref;
      setDraft((value) => ({ ...value, ref }));
      const result = await api.tool<{ version: number }>(kind === 'category' ? 'category_manage' : 'skill_manage', {
        action: 'upsert', ...(kind === 'category' ? { id: ref, default: draft.default } : { ref, markdown: draft.markdown,
          ...(!creating && ref !== base.ref ? { previousRef: base.ref } : {}) }),
        name: draft.name, description: draft.description, enabled: draft.enabled, expectedVersion: draft.version,
      });
      const saved = { ...draft, ref, version: result.version };
      setDraft(saved); setBase(saved); resetReference(saved); setCreating(false); setNotice('Changes saved.'); onChanged();
    } catch (e) { failure(e); } finally { setBusy(false); }
  };
  const lifecycle = async () => {
    if (dirty && !window.confirm('Discard unsaved changes before changing archive state?')) return;
    if (!base.deleted && !window.confirm(`Archive ${base.ref}? This can be restored later.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.tool(kind === 'category' ? 'category_manage' : 'skill_manage', { action: base.deleted ? 'restore' : 'delete',
        ...(kind === 'category' ? { id: base.ref } : { ref: base.ref }), expectedVersion: base.version });
      const value = await read(base.ref); setDraft(value); setBase(value); resetReference(value); setConflict(false); setLatest(undefined);
      setResourceEpoch((n) => n + 1); setResourceDirty(false); onChanged();
    } catch (e) { failure(e); } finally { setBusy(false); }
  };
  const loadLatest = async () => {
    setBusy(true);
    try { setLatest(await read(creating ? draft.ref : base.ref)); } catch (e) { failure(e); } finally { setBusy(false); }
  };
  const adopt = (keepDraft: boolean) => {
    if (!latest) return;
    if (!keepDraft && dirty && !window.confirm('Replace your draft with the current server version?')) return;
    setBase(latest); setDraft(keepDraft && mainDirty ? { ...draft, version: latest.version, deleted: latest.deleted, resources: latest.resources } : latest);
    if (!keepDraft || !mainDirty) resetReference(latest);
    else if (creating) resetReference(draft);
    setCreating(false);
    if (!keepDraft) { setResourceDirty(false); setResourceEpoch((n) => n + 1); }
    setConflict(false); setLatest(undefined); setError('');
  };
  const resourcesChanged = async (version: number) => {
    onChanged();
    try {
      const value = await read(base.ref);
      if (value.version !== version) throw new ApiError('VERSION_CONFLICT');
      setDraft(value); setBase(value); resetReference(value); setNotice('Resources updated.');
    } catch (e) { failure(e); }
  };
  const navigateTab = (next: typeof tab) => {
    if (next !== 'resources' && resourceDirty) return;
    setTab(next);
  };
  const categoryId = draft.ref.split('/')[0];
  const category = categories.find((value) => value.ref === categoryId);
  return <Sheet open onOpenChange={(open) => { if (!open) close(); }}><SheetContent className="editor-sheet">
    <SheetHeader><SheetTitle>{creating ? `New ${kind}` : draft.name || (kind === 'skill' ? 'Skill' : 'Category')}</SheetTitle>{!creating && <SheetDescription>{kind === 'skill' ? category ? entityName(category) : categoryId : draft.ref}</SheetDescription>}</SheetHeader>
    <div className="editor-body">
      {!creating && <div className="editor-status"><Status entity={draft} /><Badge variant="outline">v{draft.version}</Badge>{dirty && <span className="muted">Unsaved changes</span>}</div>}
      <ErrorNotice>{error}</ErrorNotice>{notice && <div role="status" className="success-notice"><Check size={14} />{notice}</div>}
      {conflict && <div className="conflict-panel"><strong>Your draft is safe.</strong><p>Load the current version to review the changes before choosing an editing base.</p><Button size="sm" variant="outline" disabled={busy} onClick={() => void loadLatest()}>Load latest version</Button>
        {latest && <div className="latest-version"><h3>Server version v{latest.version}</h3><p><strong>{latest.name}</strong> · {latest.deleted ? 'Archived' : latest.enabled ? 'Active' : 'Disabled'}</p><p>{latest.description}</p>{kind === 'category' && <p>Default: {latest.default ? 'yes' : 'no'}</p>}{kind === 'skill' && <pre>{latest.markdown}</pre>}<div className="actions"><Button variant="outline" size="sm" onClick={() => adopt(false)}>Replace draft with latest</Button><Button size="sm" disabled={latest.deleted} onClick={() => adopt(true)}>Keep draft on v{latest.version}</Button></div><p className="field-hint">Keeping the draft uses this version as the base. Save again to apply your changes.</p></div>}
      </div>}
      {kind === 'skill' && <div className="catalog-tabs editor-tabs" role="tablist" aria-label="Skill details">{([{ value: 'edit', label: 'Edit', icon: FileText }, { value: 'preview', label: 'Preview', icon: GitBranch }, { value: 'resources', label: 'Resources', icon: Paperclip }] as const).map(({ value, label, icon: Icon }) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => navigateTab(value)} disabled={value === 'resources' && creating || value !== 'resources' && resourceDirty}><Icon size={14} />{label}{value === 'resources' && <span>{draft.resources.length}</span>}</button>)}</div>}
      {kind === 'category' && !creating && <div className="catalog-tabs editor-tabs" role="tablist" aria-label="Category details"><button role="tab" aria-selected={tab === 'skills'} className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>Skills</button><button role="tab" aria-selected={tab === 'edit'} className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>Settings</button></div>}
      {kind === 'category' && tab === 'skills' && !busy && <CategorySkills api={api} category={draft} showDisabled={showDisabled} showArchived={showArchived} revision={childrenRevision} onOpen={setSelectedSkill} onChanged={childrenChanged} />}
      {tab === 'edit' && <form onSubmit={save} className="form-stack" aria-label={`${kind} editor`}><fieldset disabled={busy || draft.deleted}>
        {kind === 'skill' && creating && <div className="skill-upload"><Button type="button" variant="outline" onClick={() => upload.current?.click()}><Upload size={14} />Import skill file</Button>
          <input type="file" accept=".md,.markdown,text/markdown" ref={upload} className="sr-only" aria-label="Import skill file" disabled={busy} onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
        </div>}
        {kind === 'skill' ? <><div className="skill-reference-fields"><CategoryPicker categories={categories} value={categoryChoice} disabled={busy || draft.deleted} onChange={(value) => {
          setCategoryChoice(value); setCategoryEdited(true); setNotice('');
          if (!creating && value) change('ref', `${value.id}/${customId}`);
        }} />
          <label>Reference skill name<Input value={customId} placeholder={catalogId(draft.name) || 'From skill name'} required={!creating} maxLength={129}
            pattern="[a-z0-9][a-z0-9-]{0,63}(/[a-z0-9][a-z0-9-]{0,63})?" onChange={(e) => {
              setCustomId(e.target.value); setNotice('');
              if (!creating) change('ref', `${categoryChoice?.id ?? draft.ref.split('/')[0]}/${e.target.value}`);
            }} /></label></div>
          {categoryChoice?.isNew && <p className="field-hint">{categoryChoice.name} will be created when you save.</p>}
        </> : <label>Category ID<Input value={draft.ref} onChange={(e) => change('ref', e.target.value)} required readOnly={!creating} pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="development" /></label>}
        <label>Name<Input value={draft.name} onChange={(e) => change('name', e.target.value)} required maxLength={120} /></label>
        <label>Description<Textarea value={draft.description} onChange={(e) => change('description', e.target.value)} maxLength={1000} rows={3} /></label>
        <div className="settings-row"><label className="checkbox-label"><input type="checkbox" checked={draft.enabled} onChange={(e) => change('enabled', e.target.checked)} />Enabled</label>{kind === 'category' && <label className="checkbox-label"><input type="checkbox" checked={draft.default} onChange={(e) => change('default', e.target.checked)} />Default category</label>}</div>
        {kind === 'skill' && <label>Markdown<Textarea className="markdown-input mono" rows={14} value={draft.markdown} onChange={(e) => change('markdown', e.target.value)} spellCheck={false} /><span className="field-hint">{new TextEncoder().encode(draft.markdown).length.toLocaleString()} / 262,144 bytes</span></label>}
        </fieldset><Button type="submit" disabled={busy || draft.deleted || conflict || resourceDirty}><Save size={14} />{busy ? 'Working…' : 'Save changes'}</Button>
      </form>}
      {tab === 'preview' && <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span className="muted">[Image: {alt ?? 'image'}]</span>, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{draft.markdown || '*No Markdown yet.*'}</ReactMarkdown></div>}
      {tab === 'resources' && !creating && <Resources key={resourceEpoch} api={api} entity={{ ...draft, ref: base.ref }} mainDirty={mainDirty} blocked={draft.deleted || conflict || busy} onDirty={setResourceDirty} onChanged={resourcesChanged} onConflict={failure} />}
      {!creating && (kind === 'skill' || tab === 'edit') && <div className="archive-zone"><div><strong>{draft.deleted ? 'Restore this item' : 'Archive this item'}</strong><p>{draft.deleted ? 'Make it available to the catalog again.' : 'Remove it from agent discovery. Restore it at any time.'}</p></div><Button variant="outline" size="sm" disabled={busy || conflict} onClick={() => void lifecycle()}>{draft.deleted ? 'Restore' : 'Archive'}</Button></div>}
    </div>
    {selectedSkill && <Editor key={selectedSkill} api={api} kind="skill" initialRef={selectedSkill} isNew={false} categories={categories} onClose={() => { setSelectedSkill(undefined); setChildDirty(false); }} onChanged={childrenChanged} onDirty={setChildDirty} />}
  </SheetContent></Sheet>;
}
