import { useEffect, useState } from 'react';
import { History, Search } from 'lucide-react';
import { DashboardApi, errorMessage } from '../api';
import type { Activity as ActivityData, AuditEvent } from '../types';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Empty, ErrorNotice, Pagination, Refresh } from './shared';

export function Activity({ api }: { api: DashboardApi }) {
  const [filters, setFilters] = useState({ agent: '', operation: '', ref: '' });
  const [query, setQuery] = useState(filters);
  const [data, setData] = useState<ActivityData>({ events: [], truncated: false });
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [index, setIndex] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [selected, setSelected] = useState<AuditEvent>();
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(filters); setCursors([undefined]); setIndex(0); }, 250);
    return () => clearTimeout(timer);
  }, [filters]);
  useEffect(() => {
    let active = true; setBusy(true); setError('');
    api.activity({ ...query, limit: '50', cursor: cursors[index] }).then((result) => { if (active) setData(result); })
      .catch((e) => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, query, cursors, index, refresh]);
  return <>
    <div className="page-heading"><div><div className="eyebrow">CATALOG HISTORY</div><h1>Activity</h1><p>Every catalog change, with its agent and version.</p></div><Refresh busy={busy} onClick={() => { setCursors([undefined]); setIndex(0); setRefresh((n) => n + 1); }} /></div>
    <section className="surface"><div className="table-toolbar activity-filters"><Search size={15} />{(['agent', 'operation', 'ref'] as const).map((key) => <Input key={key} aria-label={`Filter ${key}`} value={filters[key]} onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.value }))} placeholder={key === 'operation' ? 'Operation, e.g. skill.upsert' : key === 'ref' ? 'Exact reference' : 'Agent identity'} />)}</div>
      <ErrorNotice>{error}</ErrorNotice><div className="table-scroll" aria-busy={busy}><Table><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Agent</TableHead><TableHead>Operation</TableHead><TableHead>Reference</TableHead><TableHead>Version</TableHead></TableRow></TableHeader><TableBody>{data.events.map((event) => <TableRow key={event.id}>
        <TableCell><button className="entity-link timestamp" onClick={() => setSelected(event)}>{new Date(event.createdAt).toLocaleString()}</button></TableCell><TableCell>{event.agentId}</TableCell><TableCell><Badge variant="outline">{event.operation}</Badge></TableCell><TableCell className="mono">{event.ref ?? '—'}</TableCell><TableCell className="mono muted">{event.version ? `v${event.version}` : '—'}</TableCell>
      </TableRow>)}</TableBody></Table></div>
      {!data.events.length && <Empty title={busy ? 'Loading activity…' : 'No events found'}><History size={20} />Changes to the catalog appear here. Filters use exact matches.</Empty>}
      <Pagination busy={busy} index={index} hasNext={data.truncated && !!data.nextCursor} previous={() => setIndex((n) => n - 1)} next={() => { setCursors((values) => [...values.slice(0, index + 1), data.nextCursor]); setIndex((n) => n + 1); }} />
    </section>
    <Sheet open={!!selected} onOpenChange={(open) => { if (!open) setSelected(undefined); }}><SheetContent className="editor-sheet"><SheetHeader><SheetTitle>Activity event</SheetTitle><SheetDescription>Catalog audit record. Historical revisions are read only.</SheetDescription></SheetHeader>{selected && <dl className="event-details">{Object.entries({ 'Event ID': selected.id, Time: new Date(selected.createdAt).toLocaleString(), Agent: selected.agentId, Operation: selected.operation, Reference: selected.ref ?? '—', Version: selected.version ?? '—' }).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}</SheetContent></Sheet>
  </>;
}
