import type { ReactNode } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Entity } from '../types';

export function Status({ entity }: { entity: Entity }) {
  const state = entity.state ?? (entity.deleted ? 'archived' : entity.enabled === false ? 'disabled' : 'active');
  return <Badge variant={state === 'archived' ? 'outline' : state === 'disabled' ? 'warning' : 'success'}>
    {state === 'archived' ? 'Archived' : state === 'disabled' ? 'Disabled' : 'Active'}
  </Badge>;
}
export function ErrorNotice({ children }: { children?: ReactNode }) {
  return children ? <div role="alert" className="error-notice">{children}</div> : null;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3><p>{children}</p></div>;
}
export function Refresh({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return <Button variant="outline" size="sm" onClick={onClick} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''} /> Refresh</Button>;
}
export function Pagination({ index, next, previous, hasNext, busy, totalPages }: {
  index: number; next: () => void; previous: () => void; hasNext: boolean; busy: boolean; totalPages?: number;
}) {
  return <div className="pagination"><span>Page {index + 1}{totalPages !== undefined && ` of ${totalPages}`}</span><div className="actions">
    <Button variant="outline" size="sm" onClick={previous} disabled={!index || busy}><ChevronLeft size={14} /> Previous</Button>
    <Button variant="outline" size="sm" onClick={next} disabled={!hasNext || busy}>Next <ChevronRight size={14} /></Button>
  </div></div>;
}
