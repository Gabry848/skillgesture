import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Activity as ActivityIcon, ArrowUpRight, Boxes, Cable, LayoutDashboard, LogOut, PanelLeftClose, PanelLeftOpen, Zap } from 'lucide-react';
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [endpoint, setEndpoint] = useState(import.meta.env.VITE_SKILLGESTURE_URL || 'http://127.0.0.1:8080/mcp');
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
  return <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
    <aside className="sidebar">
      <div className="sidebar-header"><div className="brand"><div className="brand-mark" title="SkillGesture"><Zap size={18} fill="currentColor" /></div><span className="sidebar-label">SkillGesture</span></div>
        <Button variant="ghost" size="icon-sm" className="sidebar-toggle" aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'} aria-expanded={sidebarOpen} aria-controls="main-navigation" onClick={() => setSidebarOpen((open) => !open)}>
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </Button>
      </div>
      <nav id="main-navigation" aria-label="Main navigation">{navigation.map(({ name, icon: Icon }) => <button key={name}
        className={`nav-item ${view === name ? 'selected' : ''}`} onClick={() => navigate(name)}
        disabled={!api && name !== 'Connection'} aria-label={name} title={sidebarOpen ? undefined : name} aria-current={view === name ? 'page' : undefined}>
        <Icon size={16} /><span className="sidebar-label">{name}</span>{view === name && <span className="nav-dot" />}
      </button>)}</nav>
      <div className="sidebar-bottom"><a className="sidebar-documentation" href="https://github.com/Gabry848/skillgesture" target="_blank" rel="noreferrer" aria-label="Documentation" title={sidebarOpen ? undefined : 'Documentation'}><span className="sidebar-label">Documentation</span><ArrowUpRight size={14} /></a>
        <div className="sidebar-connection"><Badge variant={api ? 'success' : 'outline'} aria-label={api ? 'Connected' : 'Offline'} title={api ? 'Connected' : 'Offline'}><span className={`dot ${api ? 'online' : ''}`} /><span className="sidebar-label">{api ? 'Connected' : 'Offline'}</span></Badge>
          {api && <Button variant="ghost" size="icon-sm" aria-label="Log out" title="Log out" onClick={logout}><LogOut size={15} /></Button>}
        </div>
      </div>
    </aside>
    <main className="main-area">
      <div className="page">
        <ErrorNotice>{error}</ErrorNotice>
        {api && overview && view === 'Overview' && <Overview api={api} data={overview} onUpdate={updateOverview} onCatalog={() => navigate('Catalog')} />}
        <Suspense fallback={<p role="status" className="muted">Loading view…</p>}>
          {api && view === 'Catalog' && <Catalog api={api} onDirty={(value) => { dirty.current = value; }} />}
          {api && view === 'Activity' && <Activity api={api} />}
        </Suspense>
        {view === 'Connection' && <>
          <div className="page-heading"><h1>Connection</h1></div>
          <div className="connection-grid"><section className="surface connection-card">
            <div className="card-icon"><Cable size={22} /></div><h2>{api ? 'Connection established' : 'Open your workspace'}</h2>
            {api && overview ? <><dl className="connection-details"><dt>Account</dt><dd>{overview.identity.accountId}</dd><dt>Agent</dt><dd>{overview.identity.agentId}</dd><dt>Service</dt><dd>{api.origin}</dd></dl>
              <Button variant="outline" onClick={logout}>Change connection</Button></> :
              <form onSubmit={connect} className="form-stack"><label>Service URL<Input required type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://skills.example.com/mcp" autoComplete="off" disabled={connecting} /></label>
                <label>Admin token<Input required type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="sg_…" autoComplete="off" disabled={connecting} /></label>
                <p className="field-hint">Your token stays in memory and is cleared when you disconnect.</p>
                <Button type="submit" disabled={connecting}>{connecting ? 'Connecting…' : 'Connect to service'}<ArrowUpRight size={15} /></Button>
                {connecting && <Button variant="ghost" onClick={() => { clear(); setError(''); }}>Cancel connection</Button>}
              </form>}
          </section></div>
        </>}
      </div>
    </main>
  </div>;
}
