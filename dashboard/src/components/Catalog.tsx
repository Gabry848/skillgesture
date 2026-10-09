import { useEffect, useState } from 'react';
import { FileText, Folder, GitBranch, Plus, Search } from 'lucide-react';
import { DashboardApi, errorMessage } from '../api';
import type { Entity, Page } from '../types';
import { entityName } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Empty, ErrorNotice, Pagination, Refresh, Status } from './shared';
import { Editor } from './Editor';

export function Catalog({ api, onDirty }: { api: DashboardApi; onDirty: (dirty: boolean) => void }) {
  const [kind, setKind] = useState<'skill' | 'category'>('skill');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [archived, setArchived] = useState(false);
  const [categories, setCategories] = useState<Entity[]>([]);
  const [page, setPage] = useState<Page<Entity>>({ truncated: false });
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [index, setIndex] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<{ ref: string; isNew?: boolean; kind: 'skill' | 'category' }>();
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setCursors([undefined]); setIndex(0); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let active = true;
    (async () => {
      const all: Entity[] = [];
      let cursor: string | undefined;
      do {
        const result = await api.tool<Page<Entity>>('category_manage', { action: 'list', includeDeleted: true, limit: 50, ...(cursor ? { cursor } : {}) });
        all.push(...result.categories ?? []);
        cursor = result.truncated ? result.nextCursor : undefined;
        if (result.truncated && !cursor) throw new Error();
      } while (cursor && active);
      if (active) setCategories(all);
    })().catch((e) => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [api, refresh]);
  useEffect(() => {
    let active = true; setBusy(true); setError('');
    api.tool<Page<Entity>>(kind === 'category' ? 'category_manage' : 'skill_manage', {
      action: 'list', includeDeleted: archived, limit: 20, ...(query ? { query } : {}),
      ...(kind === 'skill' && category ? { categoryId: category } : {}), ...(cursors[index] ? { cursor: cursors[index] } : {}),
    }).then((result) => { if (active) setPage(result); })
      .catch((e) => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, kind, category, archived, query, cursors, index, refresh]);
  const reset = () => { setCursors([undefined]); setIndex(0); };
  const reload = () => { reset(); setRefresh((n) => n + 1); };
  const rows = (kind === 'category' ? page.categories : page.skills) ?? [];
  return <>
    <div className="page-heading"><div><div className="eyebrow">YOUR SHARED LIBRARY</div><h1>Catalog</h1><p>Instructions and resources, organized for every agent.</p></div><div className="actions"><Refresh busy={busy} onClick={reload} /><Button size="sm" onClick={() => setSelection({ kind, ref: kind === 'skill' && category ? `${category}/` : '', isNew: true })}><Plus size={14} />New {kind}</Button></div></div>
    <div className="catalog-tabs" role="tablist" aria-label="Catalog type">{(['skill', 'category'] as const).map((value) => <button key={value} role="tab" aria-selected={kind === value} onClick={() => { setKind(value); reset(); }} className={kind === value ? 'active' : ''}>{value === 'skill' ? <FileText size={14} /> : <Folder size={14} />}{value === 'skill' ? 'Skills' : 'Categories'}</button>)}</div>
    <section className="surface catalog-surface"><div className="table-toolbar"><div className="search-field"><Search size={15} /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${kind === 'skill' ? 'skills' : 'categories'}…`} aria-label="Search catalog" /></div>
      <div className="actions">{kind === 'skill' && <select className="native-select" aria-label="Filter category" value={category} onChange={(e) => { setCategory(e.target.value); reset(); }}><option value="">All categories</option>{categories.map((c) => <option key={c.ref} value={c.ref}>{entityName(c)}{c.deleted ? ' (archived)' : ''}</option>)}</select>}
        <label className="checkbox-label"><input type="checkbox" checked={archived} onChange={(e) => { setArchived(e.target.checked); reset(); }} />Show archived</label></div>
    </div><ErrorNotice>{error}</ErrorNotice>
      <div aria-busy={busy} className="table-scroll"><Table><TableHeader><TableRow><TableHead>{kind === 'skill' ? 'Skill / subskill' : 'Category'}</TableHead><TableHead>Reference</TableHead><TableHead>Status</TableHead><TableHead>Version</TableHead><TableHead className="sr-only">Actions</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((row) => {
          const child = kind === 'skill' && row.ref.split('/').length === 3;
          return <TableRow key={row.ref}><TableCell><div className={`entity-cell ${child ? 'child' : ''}`}>{child ? <GitBranch size={15} /> : kind === 'skill' ? <FileText size={15} /> : <Folder size={15} />}<div><button className="entity-link" onClick={() => setSelection({ kind, ref: row.ref })}>{entityName(row)}</button><p>{row.description || (child ? `Subskill of ${row.ref.split('/').slice(0, 2).join('/')}` : 'No description')}</p></div></div></TableCell>
            <TableCell className="mono ref-cell">{row.ref}</TableCell><TableCell><Status entity={row} />{kind === 'category' && row.default && <Badge variant="outline" className="default-badge">Default</Badge>}</TableCell><TableCell className="mono muted">v{row.version}</TableCell>
            <TableCell><Button variant="ghost" size="sm" onClick={() => setSelection({ kind, ref: row.ref })} aria-label={`Open ${row.ref}`}>Open</Button></TableCell></TableRow>;
        })}</TableBody></Table></div>
      {!rows.length && <Empty title={busy ? 'Loading catalog…' : 'No items found'}>{busy ? 'Fetching the current catalog.' : 'Try another search or create your first item.'}</Empty>}
      <Pagination index={index} busy={busy} hasNext={page.truncated && !!page.nextCursor} previous={() => setIndex((n) => n - 1)} next={() => { setCursors((values) => [...values.slice(0, index + 1), page.nextCursor]); setIndex((n) => n + 1); }} />
    </section>
    {selection && <Editor key={`${selection.kind}:${selection.ref}:${selection.isNew}`} api={api} kind={selection.kind} initialRef={selection.ref} isNew={selection.isNew ?? false}
      onClose={() => { setSelection(undefined); onDirty(false); }} onDirty={onDirty} onChanged={reload} />}
  </>;
}
