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

Manages sessions, the catalog, and associations. The available actions are:

- `session.open`
- `session.configure`
- `session.list`
- `group.upsert`
- `skill.upsert`
- `subskill.upsert`
- `node.setEnabled`
- `association.set`

### `skill_tree`

Returns the lightweight tree of skills applicable to a session. It includes metadata and provenance, but not Markdown content.

### `skill_read`

Reads the Markdown of a single active skill or subskill on demand. If the skill contains imported supporting files, the first read also returns their `resources` index. Passing one of those paths as `resourcePath` reads only that resource without loading the entire bundle into the context.

## Recommended Agent Workflow

### 1. Create a Session

Each agent creates a session once:

```json
{
  "action": "session.open",
  "data": {
    "label": "coding-agent",
    "folders": [
      "/Users/example/projects/api",
      "/Users/example/projects/shared"
    ]
  }
}
```

The response contains a UUID:

```json
{
  "ok": true,
  "session": {
    "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac"
  },
  "resumed": false
}
```

The agent must retain and reuse this `sessionId`.

### 2. Resume a Session

After restarting the server:

```json
{
  "action": "session.open",
  "data": {
    "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac"
  }
}
```

An unknown ID does not implicitly create a new session.

### 3. Update the Session Folders

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

### 4. View the Index

```json
{
  "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac",
  "includeDisabled": false
}
```

### 5. Read a Skill on Demand

```json
{
  "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac",
  "groupId": "coding",
  "skillId": "nodejs",
  "subskillId": "testing"
}
```

`subskillId` is optional.

To read a resource listed in the previous response:

```json
{
  "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac",
  "groupId": "coding",
  "skillId": "nodejs",
  "resourcePath": "references/testing.md"
}
```

Text resources are returned as UTF-8; binary resources are returned as Base64.

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

Multiple MCP processes can use the same repository. Sessions are stored separately, and mutations are serialized through a cross-process lock.

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

## Tests

```bash
npm test
```

Tests use temporary directories and do not modify `~/.skillgesture`.

## License

ISC
