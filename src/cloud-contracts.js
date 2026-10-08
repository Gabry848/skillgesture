import * as z from 'zod/v4';
import { IdSchema, SessionIdSchema } from './contracts.js';

const Version = z.number().int().nonnegative();
const Ref = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63})?$/);
export const ResourcePath = z.string().min(1).max(240).refine((value) =>
  !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every((part) => part && part !== '.' && part !== '..'),
'Resource paths must be safe relative POSIX paths');
const Categories = z.array(IdSchema).max(100);
const Name = z.string().trim().min(1).max(120);
const Description = z.string().trim().max(1000);
export const PageShape = {
  query: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(50).default(12),
  cursor: z.string().min(1).max(2048).optional(),
  knownIndexVersion: z.string().regex(/^[a-f0-9]{24}$/).optional(),
};
export const CategoryListInput = z.strictObject(PageShape);
export const CloudTreeInput = z.strictObject({
  sessionId: SessionIdSchema.optional(),
  categoryIds: Categories.optional().describe('Additional categories for this request'),
  categoryId: IdSchema.optional().describe('Filter active categories'),
  ...PageShape,
});
const ReadItem = z.strictObject({ ref: Ref, resourcePath: ResourcePath.optional() });
export const CloudReadInput = z.strictObject({
  sessionId: SessionIdSchema.optional(),
  categoryIds: Categories.optional(),
  ref: Ref.optional(),
  resourcePath: ResourcePath.optional(),
  items: z.array(ReadItem).min(1).max(8).optional(),
}).superRefine((input, ctx) => {
  if (input.items !== undefined ? input.ref !== undefined || input.resourcePath !== undefined : input.ref === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Supply ref (with optional resourcePath), or items, exclusively' });
  }
});
export const ContextInput = z.strictObject({
  action: z.enum(['open', 'configure', 'list', 'close']),
  sessionId: SessionIdSchema.optional(),
  categories: Categories.optional(),
  label: z.string().max(120).optional(),
  mode: z.enum(['replace', 'add', 'remove']).default('replace'),
  expectedVersion: Version.optional(),
  discovery: z.strictObject({ categoryId: IdSchema.optional(), ...PageShape }).optional(),
  ...PageShape,
});
export const CategoryManageInput = z.strictObject({
  action: z.enum(['list', 'get', 'upsert', 'delete', 'restore']),
  id: IdSchema.optional(),
  name: Name.optional(),
  description: Description.optional(),
  enabled: z.boolean().optional(),
  default: z.boolean().optional(),
  expectedVersion: Version.optional(),
  includeDeleted: z.boolean().default(false),
  ...PageShape,
});
export const SkillManageInput = z.strictObject({
  action: z.enum(['list', 'get', 'upsert', 'delete', 'restore']),
  ref: Ref.optional(),
  categoryId: IdSchema.optional(),
  name: Name.optional(),
  description: Description.optional(),
  enabled: z.boolean().optional(),
  markdown: z.string().max(256 * 1024).optional(),
  expectedVersion: Version.optional(),
  includeDeleted: z.boolean().default(false),
  ...PageShape,
});
export const ResourceManageInput = z.strictObject({
  action: z.enum(['upsert', 'delete']),
  ref: Ref,
  path: ResourcePath,
  content: z.string().max(8 * 1024 * 1024).optional(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  mimeType: z.string().min(1).max(120).default('text/plain'),
  expectedVersion: Version,
});
