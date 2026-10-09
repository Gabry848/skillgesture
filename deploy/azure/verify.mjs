import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: { api: { type: 'string' }, dashboard: { type: 'string' }, 'backend-only': { type: 'boolean' } } });
const api = new URL(values.api);
const dashboard = new URL(values.dashboard);
if (api.protocol !== 'https:' || api.pathname !== '/mcp' || dashboard.protocol !== 'https:') throw new Error('Use the prepared HTTPS endpoints');
let health;
for (let attempt = 0; attempt < 18; attempt++) {
  health = await fetch(new URL('/health', api), { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (health?.ok) break;
  await delay(5000);
}
if (!health?.ok || (await health.json()).ok !== true) throw new Error('Backend database readiness failed');
const unauthorized = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) });
if (unauthorized.status !== 401) throw new Error('MCP must require an agent token');
const preflight = await fetch(api, { method: 'OPTIONS', headers: { Origin: dashboard.origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }, signal: AbortSignal.timeout(10_000) });
if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== dashboard.origin) throw new Error('Dashboard CORS failed');
if (!values['backend-only']) {
  const consoleResponse = await fetch(dashboard, { signal: AbortSignal.timeout(10_000) });
  if (!consoleResponse.ok || !(await consoleResponse.text()).includes('id="root"')) throw new Error('Dashboard static build is unavailable');
}
console.log(JSON.stringify({ verified: true, databaseReady: true, tokenRequired: true, dashboardCors: true, dashboardChecked: !values['backend-only'] }));
