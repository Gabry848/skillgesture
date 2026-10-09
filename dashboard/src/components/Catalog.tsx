import { useEffect, useState } from 'react';
import { FileText, Folder, GitBranch, Plus, Search } from 'lucide-react';
import { DashboardApi, errorMessage } from '../api';
import type { CatalogPage, Entity, Page } from '../types';
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
  const [disabled, setDisabled] = useState(false);
  const [categories, setCategories] = useState<Entity[]>([]);
  const [categoriesBusy, setCategoriesBusy] = useState(true);
  const [page, setPage] = useState<CatalogPage>({ items: [], total: 0, totalPages: 1, page: 1, limit: 20 });
  const [index, setIndex] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [categoryError, setCategoryError] = useState('');
  const [selection, setSelection] = useState<{ ref: string; isNew?: boolean; kind: 'skill' | 'category' }>();
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setIndex(0); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let active = true; setCategoriesBusy(true); setCategoryError('');
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
    })().catch((e) => { if (active) setCategoryError(errorMessage(e)); }).finally(() => { if (active) setCategoriesBusy(false); });
    return () => { active = false; };
  }, [api, refresh]);
  useEffect(() => {
    let active = true; setBusy(true); setError('');
    api.catalog({ kind, includeDeleted: String(archived), includeDisabled: String(disabled), limit: '20', page: String(index + 1),
      query: query || undefined, categoryId: kind === 'skill' ? category || undefined : undefined,
    }).then((result) => { if (active) { setPage(result); if (result.page !== index + 1) setIndex(result.page - 1); } })
      .catch((e) => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, kind, category, archived, disabled, query, index, refresh]);
  const reload = () => { setIndex(0); setRefresh((n) => n + 1); };
  const open = (row: Entity) => setSelection({ kind, ref: row.ref });
  return <>
    <div className="page-heading"><h1>Catalog</h1><div className="actions"><Refresh busy={busy || categoriesBusy} onClick={reload} /><Button size="sm" disabled={categoriesBusy || !!categoryError} onClick={() => setSelection({ kind, ref: kind === 'skill' && category ? `${category}/` : '', isNew: true })}><Plus size={14} />New {kind}</Button></div></div>
    <div className="catalog-tabs" role="tablist" aria-label="Catalog type">{(['skill', 'category'] as const).map((value) => <button key={value} role="tab" aria-selected={kind === value} onClick={() => { setKind(value); setIndex(0); }} className={kind === value ? 'active' : ''}>{value === 'skill' ? <FileText size={14} /> : <Folder size={14} />}{value === 'skill' ? 'Skills' : 'Categories'}</button>)}</div>
    <section className="surface catalog-surface"><div className="table-toolbar"><div className="search-field"><Search size={15} /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${kind === 'skill' ? 'skills' : 'categories'}…`} aria-label="Search catalog" /></div>
      <div className="actions catalog-filters">{kind === 'skill' && <select className="native-select" aria-label="Filter category" value={category} onChange={(e) => { setCategory(e.target.value); setIndex(0); }}><option value="">All categories</option>{categories.map((c) => <option key={c.ref} value={c.ref}>{entityName(c)}{c.deleted ? ' (archived)' : ''}</option>)}</select>}
        <label className="checkbox-label"><input type="checkbox" checked={disabled} onChange={(e) => { setDisabled(e.target.checked); setIndex(0); }} />Show disabled</label>
        <label className="checkbox-label"><input type="checkbox" checked={archived} onChange={(e) => { setArchived(e.target.checked); setIndex(0); }} />Show archived</label></div>
    </div><ErrorNotice>{error || categoryError}</ErrorNotice>
      <div aria-busy={busy} className="table-scroll"><Table><TableHeader><TableRow><TableHead>{kind === 'skill' ? 'Skill / subskill' : 'Category'}</TableHead><TableHead>{kind === 'skill' ? 'Category' : 'Skills'}</TableHead><TableHead>Status</TableHead><TableHead>Version</TableHead></TableRow></TableHeader>
        <TableBody>{page.items.map((row) => {
          const child = kind === 'skill' && row.ref.split('/').length === 3;
          return <TableRow key={`${kind}:${row.ref}`} className="catalog-row" tabIndex={busy ? -1 : 0} aria-label={`${kind === 'skill' ? 'Skill' : 'Category'} ${entityName(row)}`} onClick={() => { if (!busy) open(row); }}
            onKeyDown={(event) => { if (!busy && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(row); } }}>
            <TableCell><div className={`entity-cell ${child ? 'child' : ''}`}>{child ? <GitBranch size={15} /> : kind === 'skill' ? <FileText size={15} /> : <Folder size={15} />}<div><span className="entity-link">{entityName(row)}</span>{row.description && <p>{row.description}</p>}</div></div></TableCell>
            <TableCell>{kind === 'skill' ? row.categoryName : <span className="category-count">{row.skillCount ?? 0}</span>}</TableCell><TableCell><Status entity={row} />{kind === 'category' && row.default && <Badge variant="outline" className="default-badge">Default</Badge>}</TableCell><TableCell className="mono muted">v{row.version}</TableCell>
          </TableRow>;
        })}</TableBody></Table></div>
      {!page.items.length && <Empty title={busy ? 'Loading catalog…' : 'No items found'}>{busy ? 'Fetching the current catalog.' : 'Try another search or show disabled items.'}</Empty>}
      <Pagination index={index} totalPages={page.totalPages} busy={busy} hasNext={index + 1 < page.totalPages} previous={() => setIndex((n) => n - 1)} next={() => setIndex((n) => n + 1)} />
    </section>
    {selection && <Editor key={`${selection.kind}:${selection.ref}:${selection.isNew}`} api={api} kind={selection.kind} initialRef={selection.ref} isNew={selection.isNew ?? false} categories={categories} showDisabled={disabled} showArchived={archived}
      onClose={() => { setSelection(undefined); onDirty(false); }} onDirty={onDirty} onChanged={reload} />}
  </>;
}
