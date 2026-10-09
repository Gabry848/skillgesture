import { useEffect, useRef, useState } from 'react';
import { Download, FilePlus, Paperclip, Save, Trash2, Upload, X } from 'lucide-react';
import { ApiError, DashboardApi, errorMessage } from '../api';
import type { Entity, Resource, ResourceContent } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Empty, ErrorNotice } from './shared';

const MAX_RESOURCE = 5 * 1024 * 1024;
export const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
};
export const resourceBytes = (resource: ResourceContent['resource']) => resource.encoding === 'utf8'
  ? new TextEncoder().encode(resource.content) : Uint8Array.from(atob(resource.content), (char) => char.charCodeAt(0));
const textual = (mime: string) => /^text\//.test(mime) || /(?:json|javascript|xml|yaml|toml|svg)/i.test(mime);
interface ResourceDraft { path: string; mimeType: string; content: string; encoding: 'utf8' | 'base64'; text: boolean; originalPath?: string }

export function Resources({ api, entity, mainDirty, blocked, onDirty, onChanged, onConflict }: {
  api: DashboardApi; entity: Entity; mainDirty: boolean; blocked: boolean; onDirty: (dirty: boolean) => void;
  onChanged: (version: number) => Promise<void>; onConflict: (error: unknown) => void;
}) {
  const [draft, setDraft] = useState<ResourceDraft>();
  const [base, setBase] = useState<ResourceDraft>();
  const [dirtyUpload, setDirtyUpload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const dirty = !!draft && (dirtyUpload || JSON.stringify(draft) !== JSON.stringify(base));
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const canChange = () => !dirty || window.confirm('Discard the unsaved resource draft?');
  const clear = () => { setDraft(undefined); setBase(undefined); setDirtyUpload(false); };
  const report = (e: unknown) => { setError(errorMessage(e)); if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') onConflict(e); };
  const load = async (resource: Resource) => {
    if (!canChange()) return; setBusy(true); setError('');
    try {
      const result = await api.resource(entity.ref, resource.path);
      if (result.version !== entity.version) throw new ApiError('VERSION_CONFLICT');
      const value: ResourceDraft = { path: resource.path, originalPath: resource.path, mimeType: result.resource.mimeType,
        text: result.resource.encoding === 'utf8' || textual(result.resource.mimeType),
        encoding: result.resource.encoding, content: result.resource.encoding === 'utf8' || !textual(result.resource.mimeType)
          ? result.resource.content : new TextDecoder('utf-8', { fatal: true }).decode(resourceBytes(result.resource)) };
      setDraft(value); setBase(value); setDirtyUpload(false);
    } catch (e) { report(e); } finally { setBusy(false); }
  };
  const download = async (resource: Resource) => {
    setBusy(true); setError('');
    try {
      const result = await api.resource(entity.ref, resource.path);
      const bytes = resourceBytes(result.resource);
      // Download all types as attachments; preview never executes bundled HTML/SVG.
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
      const link = document.createElement('a'); link.href = url; link.download = resource.path.split('/').at(-1)!;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { report(e); } finally { setBusy(false); }
  };
  const remove = async (resource: Resource) => {
    if (!canChange() || !window.confirm(`Delete ${resource.path}? This removes it from the current skill version.`)) return;
    setBusy(true); setError('');
    try {
      const result = await api.tool<{ version: number }>('resource_manage', { action: 'delete', ref: entity.ref, path: resource.path, expectedVersion: entity.version });
      clear(); await onChanged(result.version);
    } catch (e) { report(e); } finally { setBusy(false); }
  };
  const selectedFile = async (file?: File) => {
    if (!file || !canChange()) return;
    if (file.size > MAX_RESOURCE) { setError('A resource cannot exceed 5 MiB.'); return; }
    setBusy(true); setError('');
    try {
      const mimeType = file.type || 'application/octet-stream';
      const text = textual(mimeType);
      const content = text ? await file.text() : bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      setDraft({ path: file.name, mimeType, content, encoding: text ? 'utf8' : 'base64', text }); setBase(undefined); setDirtyUpload(true);
    } catch { setError('Unable to read this file.'); } finally { setBusy(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!draft) return;
    setBusy(true); setError('');
    try {
      const isText = draft.text;
      const content = draft.encoding === 'base64' && isText ? bytesToBase64(new TextEncoder().encode(draft.content)) : draft.content;
      const bytes = resourceBytes({ ...draft, content, size: 0 });
      const resources = entity.resources ?? [];
      const old = resources.find((r) => r.path === draft.path);
      if (bytes.length > MAX_RESOURCE) throw new Error('size');
      if ((!old && resources.length >= 200) || resources.reduce((total, r) => total + r.size, 0) - (old?.size ?? 0) + bytes.length > 20 * 1024 * 1024) {
        setError('A skill may contain up to 200 resources and 20 MiB in total.'); return;
      }
      if (!draft.originalPath && old && !window.confirm(`Replace the existing resource ${draft.path}?`)) return;
      const result = await api.tool<{ version: number }>('resource_manage', { action: 'upsert', ref: entity.ref, path: draft.path,
        mimeType: draft.mimeType, encoding: draft.encoding, content, expectedVersion: entity.version });
      clear(); await onChanged(result.version);
    } catch (e) { if (e instanceof Error && e.message === 'size') setError('A resource cannot exceed 5 MiB.'); else report(e); } finally { setBusy(false); }
  };
  const readOnly = blocked || mainDirty;
  return <div className="resources"><ErrorNotice>{error}</ErrorNotice>{mainDirty && <p className="field-hint">Save the Markdown and metadata before changing resources.</p>}
    <div className="resource-actions"><Button variant="outline" size="sm" disabled={busy || readOnly} onClick={() => upload.current?.click()}><Upload size={14} />Upload</Button><Button variant="outline" size="sm" disabled={busy || readOnly} onClick={() => { if (canChange()) { setDraft({ path: '', mimeType: 'text/plain', content: '', encoding: 'utf8', text: true }); setBase(undefined); setDirtyUpload(true); } }}><FilePlus size={14} />New text resource</Button><input type="file" ref={upload} className="sr-only" aria-label="Upload resource" onChange={(e) => { void selectedFile(e.target.files?.[0]); e.target.value = ''; }} /></div>
    <div className="resource-list">{(entity.resources ?? []).map((resource) => <div className="resource-row" key={resource.path}><Paperclip size={15} /><div className="resource-info"><button className="entity-link mono" onClick={() => void load(resource)} disabled={busy}>{resource.path}</button><p>{resource.mimeType} · {(resource.size / 1024).toFixed(1)} KiB</p></div><Button variant="ghost" size="icon-sm" aria-label={`Download ${resource.path}`} disabled={busy} onClick={() => void download(resource)}><Download size={14} /></Button><Button variant="ghost" size="icon-sm" aria-label={`Delete ${resource.path}`} disabled={busy || readOnly} onClick={() => void remove(resource)}><Trash2 size={14} /></Button></div>)}</div>
    {!entity.resources?.length && !draft && <Empty title="No bundled resources">Upload scripts, reference documents or other files.</Empty>}
    {draft && <form className="form-stack resource-form" onSubmit={save}><div className="resource-form-heading"><h3>{draft.originalPath ? 'Resource content' : 'New resource'}</h3><Button type="button" variant="ghost" size="icon-sm" aria-label="Close resource draft" onClick={() => { if (canChange()) clear(); }}><X size={14} /></Button></div><fieldset disabled={busy || readOnly}>
      <label>Resource path<Input required value={draft.path} readOnly={!!draft.originalPath} maxLength={240} onChange={(e) => setDraft({ ...draft, path: e.target.value })} placeholder="references/guide.md" /></label>
      <label>Content type<Input required value={draft.mimeType} maxLength={120} onChange={(e) => setDraft({ ...draft, mimeType: e.target.value })} /></label>
      {draft.text ? <label>Text content<Textarea rows={12} className="mono" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} spellCheck={false} /></label> : <p className="field-hint">Binary resource. Download to inspect the file.</p>}
      </fieldset><Button type="submit" disabled={busy || readOnly || !dirty}><Save size={14} />Save resource</Button>
    </form>}
    <p className="field-hint">Up to 5 MiB per file · 200 files and 20 MiB per skill.</p>
  </div>;
}
