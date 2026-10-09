import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, DashboardApi, decodeToolResult, endpointOrigin } from './api';
import { bytesToBase64, resourceBytes } from './components/Resources';
afterEach(() => vi.unstubAllGlobals());

describe('connection boundary', () => {
  it('accepts canonical service URLs and rejects credentials, queries, paths and remote HTTP', () => {
    expect(endpointOrigin('https://skills.example.com/mcp/admin')).toBe('https://skills.example.com');
    expect(endpointOrigin('http://127.0.0.1:8080/mcp')).toBe('http://127.0.0.1:8080');
    for (const url of ['https://user:private@host/mcp', 'https://host/mcp?token=private', 'http://host/mcp', 'https://host/private', 'https://host/mcp#private']) {
      expect(() => endpointOrigin(url)).toThrow(ApiError);
      try { endpointOrigin(url); } catch (e) { expect((e as Error).message).not.toContain('private'); }
    }
  });
  it('decodes text and structured MCP results and retains conflict details', () => {
    expect(decodeToolResult({ structuredContent: { ok: true, version: 3 }, content: [] })).toEqual({ ok: true, version: 3 });
    expect(decodeToolResult({ content: [{ type: 'text', text: '{"ok":true,"version":2}' }] })).toEqual({ ok: true, version: 2 });
    expect(() => decodeToolResult({ isError: true, content: [{ type: 'text', text: '{"ok":false,"error":{"code":"VERSION_CONFLICT","details":{"currentVersion":7}}}' }] })).toThrow(ApiError);
  });
  it('expires the connection on 401 and sanitizes failures without leaking URL or token', async () => {
    const expired = vi.fn();
    const request = vi.fn().mockResolvedValue(new Response('{"error":"UNAUTHORIZED"}', { status: 401 }));
    vi.stubGlobal('fetch', request);
    const api = new DashboardApi('https://private.example.com/mcp', 'secret-token', expired);
    await expect(api.overview()).rejects.toThrow('Your credentials expired');
    expect(expired).toHaveBeenCalledOnce();
    await expect(api.overview()).rejects.toThrow('Unable to reach');
    expect(request).toHaveBeenCalledOnce();
    const failed = new DashboardApi('https://private.example.com/mcp', 'secret-token', vi.fn());
    request.mockRejectedValue(new Error('https://private.example.com token=secret-token'));
    await expect(failed.overview()).rejects.toThrow('Unable to reach the service');
    failed.dispose();
  });
  it('round trips UTF-8 and binary resource bytes without altering the download payload', () => {
    const bytes = new TextEncoder().encode('caffè ☕');
    expect([...resourceBytes({ encoding: 'base64', content: bytesToBase64(bytes), mimeType: 'text/plain', size: bytes.length })]).toEqual([...bytes]);
    expect([...resourceBytes({ encoding: 'base64', content: 'AAEC/w==', mimeType: 'application/octet-stream', size: 4 })]).toEqual([0, 1, 2, 255]);
  });
  it('discards a response that finishes after disconnecting', async () => {
    let complete!: (value: object) => void;
    const body = new Promise((resolve) => { complete = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true, json: () => body }));
    const api = new DashboardApi('https://skills.example.com', 'test-token', vi.fn());
    const pending = api.overview();
    await Promise.resolve(); await Promise.resolve();
    api.dispose(); complete({ identity: { accountId: 'old-account' } });
    await expect(pending).rejects.toThrow('Unable to reach');
  });
});
