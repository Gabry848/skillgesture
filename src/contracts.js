import * as z from 'zod/v4';

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const IdSchema = z.string().regex(ID_PATTERN, 'Must be a lowercase slug of up to 64 characters');
export const SessionIdSchema = z.string().regex(UUID_V4_PATTERN, 'Must be a UUID v4');
const VersionSchema = z.number().int().nonnegative();
const NameSchema = z.string().trim().min(1).max(120);
const DescriptionSchema = z.string().trim().max(1000);
const FolderSchema = z.string().min(1);

const StoredResourceSchema = z.strictObject({
  path: z.string().min(1),
  storagePath: z.string().min(1),
  mimeType: z.string().min(1),
  encoding: z.enum(['utf8', 'base64']),
  size: VersionSchema,
});

const SubskillSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  description: DescriptionSchema,
  enabled: z.boolean(),
  version: VersionSchema,
  markdownPath: z.string().min(1),
  resources: z.array(StoredResourceSchema).default([]),
});

const SkillSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  description: DescriptionSchema,
  enabled: z.boolean(),
  global: z.boolean(),
  version: VersionSchema,
  markdownPath: z.string().min(1),
  resources: z.array(StoredResourceSchema).default([]),
  subskills: z.array(SubskillSchema),
});

const GroupSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  description: DescriptionSchema,
  enabled: z.boolean(),
  version: VersionSchema,
  skills: z.array(SkillSchema),
});

export const CatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: VersionSchema,
  groups: z.array(GroupSchema),
});

export const AssociationsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: VersionSchema,
  folders: z.record(z.string(), z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/))),
});

export const SessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: SessionIdSchema,
  label: z.string().max(120),
  version: z.number().int().positive(),
  folders: z.array(z.string().min(1)),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const OptionalVersion = VersionSchema.optional();
const GroupRefSchema = z.strictObject({ groupId: IdSchema });
const SkillRefSchema = z.strictObject({ groupId: IdSchema, skillId: IdSchema });
const SubskillRefSchema = z.strictObject({ groupId: IdSchema, skillId: IdSchema, subskillId: IdSchema });
export const NodeRefSchema = z.union([SubskillRefSchema, SkillRefSchema, GroupRefSchema]);

const DiscoveryInputShape = {
  format: z.enum(['legacy', 'compact-v1', 'compact-v2']).optional().default('compact-v2'),
  includeDisabled: z.boolean().optional().default(false),
  query: z.string().trim().min(1).max(200).optional(),
  groupId: IdSchema.optional(),
  limit: z.number().int().min(1).max(50).optional().default(50),
  cursor: z.string().min(1).max(2048).optional(),
  knownIndexVersion: z.string().regex(/^[a-f0-9]{24}$/).optional(),
};

export const TreeInputSchema = z.strictObject({
  sessionId: SessionIdSchema.optional().describe('Optional durable session UUID; omit for enabled global skills only'),
  ...DiscoveryInputShape,
});

const ReadItemSchema = z.strictObject({
  groupId: IdSchema,
  skillId: IdSchema,
  subskillId: IdSchema.optional(),
  resourcePath: z.string().min(1).optional().describe('Optional bundled resource path returned by an earlier skill_read call'),
});

// MCP requires an object at the top level. A top-level Zod union is advertised
// as an empty object by SDK v1, even though runtime validation still works.
export const ReadInputSchema = z.strictObject({
  sessionId: SessionIdSchema.optional().describe('Optional durable session UUID'),
  format: z.enum(['minimal', 'legacy']).optional().default('minimal'),
  groupId: IdSchema.optional(),
  skillId: IdSchema.optional(),
  subskillId: IdSchema.optional(),
  resourcePath: ReadItemSchema.shape.resourcePath,
  items: z.array(ReadItemSchema).min(1).max(8).optional(),
}).superRefine((input, ctx) => {
  const singleFields = ['groupId', 'skillId', 'subskillId', 'resourcePath'];
  if (input.items !== undefined) {
    if (singleFields.some((key) => input[key] !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'items and single-read fields are mutually exclusive' });
    }
  } else if (input.groupId === undefined || input.skillId === undefined) {
    ctx.addIssue({ code: 'custom', message: 'A single read requires groupId and skillId' });
  }
});

const InputResourceSchema = z.strictObject({
  path: z.string().min(1).max(240),
  content: z.string().max(8 * 1024 * 1024),
  encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
  mimeType: z.string().min(1).max(120).optional().default('text/plain'),
});

export const ManageToolInputSchema = z.strictObject({
  format: z.enum(['minimal', 'legacy']).optional().default('minimal'),
  action: z.enum([
    'session.open',
    'session.configure',
    'session.list',
    'group.upsert',
    'skill.upsert',
    'subskill.upsert',
    'node.setEnabled',
    'association.set',
  ]).describe('Management action to perform'),
  data: z.record(z.string(), z.unknown()).optional().default({})
    .describe('Action-specific payload; see the tool description or Skillgesture README'),
});

export const ManageInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('session.open'),
    data: z.strictObject({
      sessionId: SessionIdSchema.optional(),
      label: z.string().max(120).optional(),
      folders: z.array(FolderSchema).optional(),
      discovery: z.strictObject(DiscoveryInputShape).optional(),
    }).optional().default({}),
  }),
  z.strictObject({
    action: z.literal('session.configure'),
    data: z.strictObject({
      sessionId: SessionIdSchema,
      mode: z.enum(['replace', 'add', 'remove']).optional(),
      folders: z.array(FolderSchema),
      label: z.string().max(120).optional(),
      expectedVersion: OptionalVersion,
    }),
  }),
  z.strictObject({ action: z.literal('session.list'), data: z.strictObject({}).optional().default({}) }),
  z.strictObject({
    action: z.literal('group.upsert'),
    data: z.strictObject({
      id: IdSchema,
      name: NameSchema.optional(),
      description: DescriptionSchema.optional(),
      enabled: z.boolean().optional(),
      expectedVersion: OptionalVersion,
    }),
  }),
  z.strictObject({
    action: z.literal('skill.upsert'),
    data: z.strictObject({
      groupId: IdSchema,
      id: IdSchema,
      name: NameSchema.optional(),
      description: DescriptionSchema.optional(),
      markdown: z.string().max(256 * 1024).optional(),
      resources: z.array(InputResourceSchema).max(200).optional(),
      global: z.boolean().optional(),
      enabled: z.boolean().optional(),
      expectedVersion: OptionalVersion,
    }),
  }),
  z.strictObject({
    action: z.literal('subskill.upsert'),
    data: z.strictObject({
      groupId: IdSchema,
      skillId: IdSchema,
      id: IdSchema,
      name: NameSchema.optional(),
      description: DescriptionSchema.optional(),
      markdown: z.string().max(256 * 1024).optional(),
      resources: z.array(InputResourceSchema).max(200).optional(),
      enabled: z.boolean().optional(),
      expectedVersion: OptionalVersion,
    }),
  }),
  z.strictObject({
    action: z.literal('node.setEnabled'),
    data: z.strictObject({
      ref: NodeRefSchema,
      enabled: z.boolean(),
      expectedVersion: OptionalVersion,
    }),
  }),
  z.strictObject({
    action: z.literal('association.set'),
    data: z.strictObject({
      folder: FolderSchema,
      skills: z.array(SkillRefSchema),
      expectedRevision: OptionalVersion,
    }),
  }),
]);

export const LooseOutputSchema = z.looseObject({ ok: z.boolean() });
