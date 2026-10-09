export interface Resource { path: string; mimeType: string; encoding: 'utf8' | 'base64'; size: number }
export interface Entity {
  ref: string; name?: string; description?: string; enabled?: boolean; default?: boolean;
  deleted?: boolean; version: number; resources?: Resource[];
  state?: 'active' | 'disabled' | 'archived'; categoryName?: string; skillCount?: number;
}
export interface Page<T> { indexVersion?: string; truncated: boolean; nextCursor?: string; categories?: T[]; skills?: T[] }
export interface CatalogPage { items: Entity[]; total: number; totalPages: number; page: number; limit: number }
export interface Counts { active: number; disabled: number; archived: number; total: number }
export interface Overview {
  identity: { accountId: string; agentId: string; admin: boolean };
  revision: string; updatedAt: string;
  counts: Record<'categories' | 'skills' | 'subskills' | 'resources', Counts>;
}
export interface Content { ref: string; version: number; markdown: string; resources: Resource[] }
export interface ResourceContent { ref: string; version: number; resource: Omit<Resource, 'path'> & { content: string } }
export interface AuditEvent { id: string; agentId: string; operation: string; ref: string | null; version: number | null; createdAt: string }
export interface Activity { events: AuditEvent[]; truncated: boolean; nextCursor?: string }
export const entityName = (entity: Entity) => entity.name || entity.ref.split('/').at(-1)!;
