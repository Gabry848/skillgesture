import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Activity, Content, Overview, ResourceContent } from './types';

const messages: Record<string, string> = {
  UNAUTHORIZED: 'Your credentials expired or were revoked. Connect again.',
  FORBIDDEN: 'An admin token is required.',
  VERSION_CONFLICT: 'This item changed on the server. Your draft has been kept.',
  INVALID_CURSOR: 'The catalog changed. Refresh this list to start a new page.',
  INVALID_INPUT: 'Check the fields and the content limits, then try again.',
  NODE_DELETED: 'Restore this item before editing it.',
  CATEGORY_NOT_FOUND: 'The category is unavailable. Restore it before editing its skills.',
  SKILL_NOT_FOUND: 'The skill or its parent is unavailable.',
  RESOURCE_NOT_FOUND: 'This resource is no longer available.',
  INVALID_ORIGIN: 'Allow this dashboard origin in the server ALLOWED_ORIGINS setting.',
  CONNECTION_FAILED: 'Unable to reach the service. Check the address, HTTPS and allowed origins.',
  RESPONSE_TOO_LARGE: 'The content exceeds the server limit.',
};
export class ApiError extends Error {
  constructor(public code: string, public currentVersion?: number) { super(messages[code] ?? 'The operation failed. Please retry.'); }
}
export function endpointOrigin(endpoint: string): string {
  try {
    const url = new URL(endpoint.trim());
    if (url.username || url.password || url.search || url.hash || !['/', '/mcp', '/mcp/admin'].includes(url.pathname)) throw new Error();
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error();
    return url.origin;
  } catch { throw new ApiError('CONNECTION_FAILED'); }
}

export function decodeToolResult(result: unknown): unknown {
  try {
    const r = result as { structuredContent?: unknown; content?: { type: string; text?: string }[]; isError?: boolean };
    const payload = (r.structuredContent ?? JSON.parse(r.content?.find((c) => c.type === 'text')?.text ?? '')) as
      { ok?: boolean; error?: { code?: string; details?: { currentVersion?: number } } };
    if (r.isError || payload.ok === false) throw new ApiError(payload.error?.code ?? 'OPERATION_FAILED', payload.error?.details?.currentVersion);
    return payload;
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('OPERATION_FAILED'); }
}

export class DashboardApi {
  readonly origin: string;
  #token: string;
  #client?: Client;
  #ready?: Promise<Client>;
  #disposed = false;
  #abort = new AbortController();
  constructor(endpoint: string, token: string, private onExpired: () => void) {
    this.origin = endpointOrigin(endpoint);
    this.#token = token.trim();
  }
  private fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    if (this.#disposed) throw new ApiError('CONNECTION_FAILED');
    try {
      const response = await fetch(input, { ...init, credentials: 'omit', redirect: 'error',
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(30_000), ...(init.signal ? [init.signal] : [])]),
        headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${this.#token}` } });
      if (response.status === 401 || response.status === 403) {
        const code = response.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN';
        this.onExpired(); this.dispose(); throw new ApiError(code);
      }
      return response;
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('CONNECTION_FAILED'); }
  };
  async connect() {
    this.#ready ??= (async () => {
      const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      ]);
      if (this.#disposed) throw new ApiError('CONNECTION_FAILED');
      const client = new Client({ name: 'skillgesture-dashboard', version: '1.0.0' });
      this.#client = client;
      await client.connect(new StreamableHTTPClientTransport(new URL(`${this.origin}/mcp/admin`), { fetch: this.fetch }));
      if (this.#disposed) throw new ApiError('CONNECTION_FAILED');
      return client;
    })();
    try { return await this.#ready; } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('CONNECTION_FAILED'); }
  }
  async verify() {
    const overview = await this.overview();
    const client = await this.connect();
    try {
      const listed = await client.listTools();
      if (!['category_manage', 'skill_manage', 'resource_manage'].every((name) => listed.tools.some((tool) => tool.name === name))) {
        throw new ApiError('FORBIDDEN');
      }
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('CONNECTION_FAILED'); }
    if (this.#disposed) throw new ApiError('CONNECTION_FAILED');
    return overview;
  }
  async tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.connect();
    try {
      const result = await client.callTool({ name, arguments: args });
      if (this.#disposed) throw new ApiError('CONNECTION_FAILED');
      return decodeToolResult(result) as T;
    }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('CONNECTION_FAILED'); }
  }
  private async get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const url = new URL(`${this.origin}/api/admin/${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, value);
    const res = await this.fetch(url);
    try {
      const payload = await res.json();
      if (this.#disposed) throw new ApiError('CONNECTION_FAILED');
      if (!res.ok) throw new ApiError(typeof payload.error === 'string' ? payload.error : 'OPERATION_FAILED');
      return payload as T;
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('OPERATION_FAILED'); }
  }
  overview() { return this.get<Overview>('overview'); }
  activity(params: Record<string, string | undefined>) { return this.get<Activity>('activity', params); }
  content(ref: string) { return this.get<Content>('content', { ref }); }
  resource(ref: string, resourcePath: string) { return this.get<ResourceContent>('content', { ref, resourcePath }); }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true; this.#token = ''; this.#abort.abort(); void this.#client?.close().catch(() => {});
  }
}
export const errorMessage = (error: unknown) => error instanceof ApiError ? error.message : 'The operation failed. Please retry.';
