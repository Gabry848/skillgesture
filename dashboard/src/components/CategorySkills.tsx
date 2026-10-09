import { useEffect, useState } from 'react';
import { FileText, GitBranch, Search, X } from 'lucide-react';
import { DashboardApi, errorMessage } from '../api';
import type { CatalogPage, Entity } from '../types';
import { entityName } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Empty, ErrorNotice, Pagination, Refresh, Status } from './shared';

export function CategorySkills({ api, category, showDisabled, showArchived, revision, onOpen, onChanged }: {
  api: DashboardApi; category: Entity; showDisabled: boolean; showArchived: boolean;
  onOpen: (ref: string) => void; onChanged: () => void;
  revision: number;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [disabled, setDisabled] = useState(showDisabled);
  const [archived, setArchived] = useState(showArchived);
  const [index, setIndex] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<CatalogPage>({ items: [], total: 0, totalPages: 1, page: 1, limit: 20 });
  const [busy, setBusy] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const timer = setTimeout(() => { setQuery(search.trim()); setIndex(0); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    let active = true; setBusy(true); setError('');
    api.catalog({ kind: 'skill', categoryId: category.ref, query: query || undefined, includeDisabled: String(disabled),
      includeDeleted: String(archived), page: String(index + 1), limit: '20',
    }).then((result) => { if (active) { setPage(result); if (result.page !== index + 1) setIndex(result.page - 1); } })
      .catch((e) => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, category.ref, category.version, disabled, archived, query, index, refresh, revision]);
  const remove = async (skill: Entity) => {
    if (!window.confirm(`Archive ${entityName(skill)}? It will be removed from this category’s list and agent discovery. You can restore it later.`)) return;
    setRemoving(true); setError('');
    try {
      await api.tool('skill_manage', { action: 'delete', ref: skill.ref, expectedVersion: skill.version });
      setRefresh((n) => n + 1); onChanged();
    } catch (e) { setError(errorMessage(e)); } finally { setRemoving(false); }
  };
  return <section className="category-skills" aria-label="Category skills">
    <div className="category-skills-heading"><h3>Skills <span className="category-count">{page.total}</span></h3><Refresh busy={busy || removing} onClick={() => setRefresh((n) => n + 1)} /></div>
    <div className="category-skills-filters"><div className="search-field"><Search size={14} /><Input aria-label="Search category skills" placeholder="Search skills…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <div className="actions"><label className="checkbox-label"><input type="checkbox" checked={disabled} onChange={(e) => { setDisabled(e.target.checked); setIndex(0); }} />Show disabled</label>
        <label className="checkbox-label"><input type="checkbox" checked={archived} onChange={(e) => { setArchived(e.target.checked); setIndex(0); }} />Show archived</label></div>
    </div><ErrorNotice>{error}</ErrorNotice>
    <div aria-busy={busy} className="category-skill-list">{page.items.map((skill) => <div key={skill.ref} className="category-skill-row">
      <button className="category-skill-open" disabled={busy || removing} onClick={() => onOpen(skill.ref)} aria-label={`Edit ${entityName(skill)}`}>
        {skill.ref.split('/').length === 3 ? <GitBranch size={16} /> : <FileText size={16} />}<span><strong>{entityName(skill)}</strong>{skill.description && <small>{skill.description}</small>}</span><Status entity={skill} />
      </button><Button variant="ghost" size="icon-sm" title="Archive skill" aria-label={`Remove ${entityName(skill)} from category`} disabled={busy || removing || category.deleted || skill.state === 'archived'} onClick={() => void remove(skill)}><X size={15} /></Button>
    </div>)}</div>
    {!page.items.length && <Empty title={busy ? 'Loading skills…' : 'No skills found'} />}
    <Pagination index={index} totalPages={page.totalPages} busy={busy || removing} hasNext={index + 1 < page.totalPages} previous={() => setIndex((n) => n - 1)} next={() => setIndex((n) => n + 1)} />
  </section>;
}
