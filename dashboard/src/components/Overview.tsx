import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Folder, FileText, GitBranch, Paperclip, CheckCircle2 } from 'lucide-react';
import type { DashboardApi } from '../api';
import { errorMessage } from '../api';
import type { Overview as OverviewData } from '../types';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ErrorNotice, Refresh } from './shared';

const metrics = [{ key: 'categories', title: 'Categories', icon: Folder }, { key: 'skills', title: 'Skills', icon: FileText },
  { key: 'subskills', title: 'Subskills', icon: GitBranch }, { key: 'resources', title: 'Resources', icon: Paperclip }] as const;
export function Overview({ api, data, onUpdate, onCatalog }: { api: DashboardApi; data: OverviewData; onUpdate: (data: OverviewData) => void; onCatalog: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setBusy(true); setError('');
    try { onUpdate(await api.overview()); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }, [api, onUpdate]);
  useEffect(() => {
    let inFlight = false;
    const update = async () => { if (document.visibilityState !== 'visible' || inFlight) return; inFlight = true; await refresh(); inFlight = false; };
    void update();
    const interval = window.setInterval(() => void update(), 30_000);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', update); };
  }, [refresh]);
  return <>
    <div className="page-heading"><div><div className="eyebrow">CATALOG AT A GLANCE</div><h1>Overview</h1><p>A shared library, ready for your agents.</p></div><Refresh onClick={() => void refresh()} busy={busy} /></div>
    <ErrorNotice>{error}</ErrorNotice>
    <div className="metrics">{metrics.map(({ key, title, icon: Icon }) => <section className="surface metric" key={key}>
      <div className="metric-label">{title}<Icon size={16} /></div><div className="metric-value">{data.counts[key].total.toLocaleString()}</div>
      <div className="metric-states"><span><i className="dot online" />{data.counts[key].active} active</span><span>{data.counts[key].disabled} disabled</span><span>{data.counts[key].archived} archived</span></div>
    </section>)}</div>
    <section className="surface service-card"><div><div className="service-title"><CheckCircle2 size={18} className="success-text" /><h2>Service status</h2><Badge variant={error ? 'warning' : 'success'}>{error ? 'Update failed' : 'Operational'}</Badge></div>
      <p className="muted">Connected with administrative access.</p></div><div className="service-meta"><span>Catalog revision<strong className="mono">{data.revision}</strong></span><span>Last updated<strong>{new Date(data.updatedAt).toLocaleTimeString()}</strong></span></div></section>
    <section className="surface overview-catalog"><div><div className="eyebrow">YOUR LIBRARY</div><h2>Keep your agents equipped.</h2><p>Organize categories, refine instructions and bundle the resources your skills need.</p></div><Button variant="outline" onClick={onCatalog}>Browse catalog <ArrowRight size={14} /></Button></section>
    <div className="page-footnote"><span className="dot online" /> Updates every 30 seconds while this page is visible. Counts include ancestor availability.</div>
  </>;
}
