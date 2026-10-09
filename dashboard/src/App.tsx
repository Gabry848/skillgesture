import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Activity as ActivityIcon, ArrowUpRight, Boxes, Cable, LayoutDashboard, LogOut, ShieldCheck, Zap } from 'lucide-react';
import { DashboardApi, errorMessage } from './api';
import type { Overview as OverviewData } from './types';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Badge } from './components/ui/badge';
import { ErrorNotice } from './components/shared';
import { Overview } from './components/Overview';
const Catalog = lazy(() => import('./components/Catalog').then((module) => ({ default: module.Catalog })));
const Activity = lazy(() => import('./components/Activity').then((module) => ({ default: module.Activity })));

const navigation = [
  { name: 'Overview', icon: LayoutDashboard }, { name: 'Catalog', icon: Boxes },
  { name: 'Activity', icon: ActivityIcon }, { name: 'Connection', icon: Cable },
] as const;
type View = typeof navigation[number]['name'];
type ApiFactory = (endpoint: string, token: string, expired: () => void) => DashboardApi;
const defaultFactory: ApiFactory = (endpoint, token, expired) => new DashboardApi(endpoint, token, expired);

export function App({ createApi = defaultFactory }: { createApi?: ApiFactory }) {
  const [view, setView] = useState<View>('Connection');
  const [api, setApi] = useState<DashboardApi>();
  const [overview, setOverview] = useState<OverviewData>();
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:8080/mcp');
  const [token, setToken] = useState('');
  const current = useRef<DashboardApi | undefined>(undefined);
  const dirty = useRef(false);
  const updateOverview = useCallback((data: OverviewData) => {
    if (api && current.current === api) setOverview(data);
  }, [api]);
  const clear = useCallback(() => {
    current.current?.dispose(); current.current = undefined;
    setApi(undefined); setOverview(undefined); setToken(''); setEndpoint('');
    setView('Connection'); setConnecting(false); dirty.current = false;
  }, []);
  useEffect(() => () => current.current?.dispose(), []);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
  const canLeave = () => !dirty.current || window.confirm('Discard unsaved changes? Your draft will be lost.');
  const logout = () => { if (canLeave()) { clear(); setError(''); } };
  const navigate = (next: View) => {
    if (next === view || !canLeave()) return;
    dirty.current = false; setView(next); setError('');
  };
  const connect = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setConnecting(true);
    current.current?.dispose(); setApi(undefined); setOverview(undefined);
    let candidate: DashboardApi | undefined;
    try {
      candidate = createApi(endpoint, token, () => {
        if (current.current === candidate) { clear(); setError('Your connection ended. Connect again with an admin token.'); }
      });
      current.current = candidate; setToken('');
      const data = await candidate.verify();
      if (current.current !== candidate) return;
      setOverview(data); setApi(candidate); setView('Overview');
    } catch (failure) {
      candidate?.dispose();
      if (current.current === candidate || !candidate) { current.current = undefined; setError(errorMessage(failure)); setConnecting(false); }
    } finally { if (current.current === candidate || !candidate) { setToken(''); setConnecting(false); } }
  };
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Zap size={18} fill="currentColor" /></div><div>SkillGesture<small>ADMIN CONSOLE</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{navigation.map(({ name, icon: Icon }) => <button key={name}
        className={`nav-item ${view === name ? 'selected' : ''}`} onClick={() => navigate(name)}
        disabled={!api && name !== 'Connection'} aria-current={view === name ? 'page' : undefined}>
        <Icon size={16} />{name}{view === name && <span className="nav-dot" />}
      </button>)}</nav>
      <div className="sidebar-bottom"><div className="service-indicator"><span className={`dot ${api ? 'online' : ''}`} />{api ? 'Service connected' : 'No connection'}</div>
        <p>One catalog. Every agent.</p><a href="https://github.com/Gabry848/skillgesture" target="_blank" rel="noreferrer">Documentation <ArrowUpRight size={13} /></a>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div><span className="muted">Console</span><span className="slash">/</span><span>{view}</span></div>
        <div className="actions">{overview && <span className="agent-label"><ShieldCheck size={14} /> {overview.identity.agentId}</span>}
          <Badge variant={api ? 'success' : 'outline'}>{api ? 'Connected' : 'Offline'}</Badge>
          {api && <Button variant="ghost" size="icon-sm" aria-label="Log out" onClick={logout}><LogOut size={15} /></Button>}
        </div>
      </header>
      <div className="page">
        <ErrorNotice>{error}</ErrorNotice>
        {api && overview && view === 'Overview' && <Overview api={api} data={overview} onUpdate={updateOverview} onCatalog={() => navigate('Catalog')} />}
        <Suspense fallback={<p role="status" className="muted">Loading view…</p>}>
          {api && view === 'Catalog' && <Catalog api={api} onDirty={(value) => { dirty.current = value; }} />}
          {api && view === 'Activity' && <Activity api={api} />}
        </Suspense>
        {view === 'Connection' && <>
          <div className="page-heading"><div><div className="eyebrow">YOUR SERVICE</div><h1>Connection</h1><p>Connect your local or remote SkillGesture instance.</p></div></div>
          <div className="connection-grid"><section className="surface connection-card">
            <div className="card-icon"><Cable size={22} /></div><h2>{api ? 'Connection established' : 'Open your workspace'}</h2>
            {api && overview ? <><p className="muted">Administrative access is active.</p><dl className="connection-details"><dt>Account</dt><dd>{overview.identity.accountId}</dd><dt>Agent</dt><dd>{overview.identity.agentId}</dd><dt>Service</dt><dd>{api.origin}</dd></dl>
              <Button variant="outline" onClick={logout}>Change connection</Button></> :
              <form onSubmit={connect} className="form-stack"><label>Service URL<Input required type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://skills.example.com/mcp" autoComplete="off" disabled={connecting} /></label>
                <label>Admin token<Input required type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="sg_…" autoComplete="off" disabled={connecting} /></label>
                <p className="field-hint">Your token stays in memory and is cleared when you disconnect.</p>
                <Button type="submit" disabled={connecting}>{connecting ? 'Connecting…' : 'Connect to service'}<ArrowUpRight size={15} /></Button>
                {connecting && <Button variant="ghost" onClick={() => { clear(); setError(''); }}>Cancel connection</Button>}
              </form>}
          </section><section className="connection-note"><Badge variant="outline">DIRECT CONNECTION</Badge><h2>Your catalog, wherever it runs.</h2><p>Browse categories, maintain skills and inspect catalog activity from one console.</p>
            <div className="note-item"><ShieldCheck size={18} /><div><strong>Admin access</strong><p>Use a token issued for your account with administrative access.</p></div></div>
            <div className="note-item"><Cable size={18} /><div><strong>Local or remote</strong><p>Remote services require HTTPS. Allow this dashboard’s origin on your server.</p></div></div>
          </section></div>
        </>}
      </div>
    </main>
  </div>;
}
