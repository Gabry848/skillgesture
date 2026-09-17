# Skillgesture

Skillgesture is a local MCP server for organizing and providing skills to AI agents. Skills are stored in a central repository, organized as **group → skill → subskill**, and loaded in full only when an agent requests them.

## MVP Features

- central repository in `~/.skillgesture`;
- skill content stored as Markdown;
- catalog, associations, and sessions persisted as JSON;
- global skills or skills associated with exact paths;
- simultaneous loading of multiple folders;
- lightweight index without Markdown content;
- on-demand reading;
- creation and modification of groups, skills, and subskills;
- enabling and disabling nodes;
- durable, independent sessions for multiple agents;
- atomic writes and a shared cross-process lock.

## Requirements

- Node.js 24 or later
- npm 12 or later

## Installation

```bash
npm install
```

To make the `skillgesture` command globally available during development:

```bash
npm link
```

## Running

```bash
npm start
```

The server uses the MCP `stdio` transport. Diagnostic messages are written to `stderr`, while `stdout` is reserved for the MCP protocol.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "skillgesture": {
      "command": "node",
      "args": ["/absolute/path/to/skillgesture/src/index.js"]
    }
  }
}
```

To use a different storage directory:

```bash
SKILLGESTURE_HOME=/alternative/path npm start
```

## The Three MCP Tools

### `skill_manage`

Manages sessions, the catalog, and associations through `session.open`, `session.configure`, `session.list`, `group.upsert`, `skill.upsert`, `subskill.upsert`, `node.setEnabled`, and `association.set`. `session.open` can include a `discovery` object and return compact discovery in the same round trip.

### `skill_tree`

Returns metadata only; Markdown bodies are never included. `sessionId` is optional:

- without it, only enabled global skills and their enabled subskills are visible;
- with it, global skills are unioned with skills associated with the session's exact canonical folders;
- `format: "legacy"` is the default and preserves the original fields and hierarchy;
- `format: "compact-v1"` removes administrative fields and adds bounded search, pagination, byte-budget truncation, and change detection.

Compact discovery accepts `query`, `groupId`, `limit` (1–50), `cursor`, and `knownIndexVersion`. Ranking is deterministic: exact ID/ref, name prefix, ref prefix, name tokens, description tokens, then stable skill ref. Compact responses are limited to 32 KiB of serialized JSON and expose counts plus explicit completeness. A response with `truncated: true` always includes `nextCursor` and structured continuation guidance. Reusing the same valid `indexVersion` as `knownIndexVersion` returns a small `notModified` response. Cursors are opaque and valid only for the same session/catalog/association revisions and request mode.

### `skill_read`

Reads one active skill, subskill, or bundled resource, or accepts an `items` array of 1–8 reads. Batch results preserve input order and contain independent `ok`/`error` statuses, so one failure does not discard successful reads. Batch output has a deterministic 1 MiB safety cap; an item that would exceed it receives `RESPONSE_TOO_LARGE` and can be requested separately.

Without `sessionId`, only enabled global content is readable. A folder-scoped parent returns `SESSION_REQUIRED`; subskills inherit the parent's scope. Reading Markdown returns a resource index. Supplying `resourcePath` loads only that safe relative resource. Text resources are UTF-8 and binary resources are Base64.

## Recommended Agent Workflow

### 1. Discover Globals Without a Session

Agents that only need global instructions can skip session creation:

```json
{ "format": "compact-v1", "query": "version control", "limit": 10 }
```

The response context is `{ "scope": "global-only", "session": null }`.

### 2. Open a Scoped Session and Discover in One Turn

```json
{
  "action": "session.open",
  "data": {
    "label": "coding-agent",
    "folders": ["/Users/example/projects/api"],
    "discovery": {
      "format": "compact-v1",
      "query": "testing",
      "limit": 10
    }
  }
}
```

Persist the returned `session.sessionId`. To resume, call `session.open` with that `sessionId`; an unknown ID never creates a replacement session implicitly. The same optional `discovery` object works when resuming.

### 3. Keep Session Folders Current

```json
{
  "action": "session.configure",
  "data": {
    "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac",
    "mode": "add",
    "folders": ["/Users/example/projects/another-project"]
  }
}
```

`mode` can be `replace`, `add`, or `remove`.

### 4. Continue or Revalidate Compact Discovery

Pass `nextCursor` back as `cursor` until `complete` is true. On a later turn, pass the previous `indexVersion` as `knownIndexVersion`; if the effective index is unchanged, the server returns `notModified: true` without repeating the tree. Do not send search, cursor, or version fields with legacy format.

Legacy clients can continue using:

```json
{
  "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac",
  "includeDisabled": false
}
```

### 5. Read One or Several Results

Single read:

```json
{
  "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac",
  "groupId": "coding",
  "skillId": "nodejs",
  "subskillId": "testing"
}
```

Batch read:

```json
{
  "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac",
  "items": [
    { "groupId": "coding", "skillId": "nodejs" },
    { "groupId": "coding", "skillId": "git", "resourcePath": "references/rebase.md" }
  ]
}
```

The single-item fields and `items` are mutually exclusive.

## Creating the Catalog

### Group

```json
{
  "action": "group.upsert",
  "data": {
    "id": "coding",
    "name": "Coding",
    "description": "Development skills"
  }
}
```

### Global Skill

```json
{
  "action": "skill.upsert",
  "data": {
    "groupId": "coding",
    "id": "git",
    "name": "Git",
    "description": "Version control management",
    "global": true,
    "markdown": "# Git\n\nSkill instructions."
  }
}
```

### Folder-Scoped Skill

```json
{
  "action": "skill.upsert",
  "data": {
    "groupId": "coding",
    "id": "nodejs",
    "name": "Node.js",
    "global": false,
    "markdown": "# Node.js\n\nSkill instructions."
  }
}
```

### Subskill

```json
{
  "action": "subskill.upsert",
  "data": {
    "groupId": "coding",
    "skillId": "nodejs",
    "id": "testing",
    "name": "Node testing",
    "markdown": "# Node testing\n\nUse node:test."
  }
}
```

Subskills inherit the scope of their parent skill.

## Associating a Skill with a Folder

```json
{
  "action": "association.set",
  "data": {
    "folder": "/Users/example/projects/api",
    "skills": [
      {
        "groupId": "coding",
        "skillId": "nodejs"
      }
    ]
  }
}
```

`association.set` replaces the folder's entire set of skills. An empty array removes the association.

Associations are based on the exact canonical path:

- an association with `/projects/api` does not automatically apply to `/projects/api/packages/web`;
- folders must exist when they are loaded or associated;
- a session can contain multiple folders and receives the deduplicated union of their skills.

## Enabling and Disabling Nodes

```json
{
  "action": "node.setEnabled",
  "data": {
    "ref": {
      "groupId": "coding",
      "skillId": "nodejs"
    },
    "enabled": false
  }
}
```

Disabling a group disables all its descendant skills. Disabling a skill also makes its subskills unreadable. `skill_tree` can show disabled nodes when called with `includeDisabled: true`.

## Concurrency and Versions

Multiple MCP processes can use the same repository. Sessions are stored separately, mutations are serialized through a cross-process lock, and JSON replacement is atomic.

Validated catalogs, associations, and sessions use a read-through cache. Every cache hit first compares filesystem identity and high-resolution stat metadata, so another process's atomic replacement is observed. Same-process writes invalidate immediately, callers receive isolated clones, and metadata/cache failures fall back to authoritative disk reads instead of stale authorization data.

Update operations accept `expectedVersion`; `association.set` accepts `expectedRevision`. If another agent has already changed the data, Skillgesture returns `VERSION_CONFLICT` instead of silently overwriting the change.

## Central Repository

```text
~/.skillgesture/
├── catalog.json
├── associations.json
├── sessions/
│   └── <session-id>.json
└── skills/
    └── <group-id>/
        └── <skill-id>/
            ├── versions/
            │   └── <version>/
            │       ├── SKILL.md
            │       └── resources/
            └── subskills/
                └── <subskill-id>/
                    └── versions/
                        └── <version>/
                            ├── SKILL.md
                            └── resources/
```

Markdown versions are immutable. The catalog points to the active version, preventing reads from observing partially updated content.

## Tests and Benchmarks

```bash
npm test
npm run benchmark
```

The benchmark deterministically generates temporary catalogs with 10, 100, 1,000, and 10,000 skills. It reports legacy/compact/search/not-modified serialized bytes, `ceil(bytes / 4)` estimated tokens, cold/warm discovery/search/read latency, heap deltas, and measured MCP/registry call counts for loading 1, 3, and 8 skills. Timings and heap figures are informational, never CI assertions.

For a quick smoke run:

```bash
npm run benchmark -- --sizes=10,100
```

Tests and benchmarks use temporary directories and do not modify `~/.skillgesture`.

### Benchmark commands

Run the deterministic benchmark across 10, 100, 1,000, and 10,000 generated skills:

```bash
npm run bench
```

For a quick 10/100-skill smoke run:

```bash
npm run bench -- --smoke
```

The benchmark reports serialized bytes, estimated tokens, compact-versus-legacy reduction, discovery/search/read latency, and individual-versus-batch call counts. Latency measurements are informational and are not used as flaky CI assertions.

## License

ISC
