# SkillGesture

SkillGesture gives agents a shared cloud catalog of skills without loading the whole catalog into their context. Skills belong to **categories**, Markdown is read on demand, and each agent can keep independent durable sessions.

For example, an agent starts with the default development skills, selects the optional `fentaris` category for a coordination task, and reads only the relevant instructions:

```json
{"action":"open","categories":["fentaris"],"discovery":{"query":"coordination","limit":5}}
```

Call this through `skill_context`, save the returned `sessionId` and `version`, then use `skill_read` with that ID and a discovered `ref`. Opening a session and discovering skills takes one round trip.

## Cloud endpoints

| Endpoint | Tools | Access |
| --- | --- | --- |
| `/mcp` | `skill_categories`, `skill_tree`, `skill_read`, `skill_context` | Any valid agent token |
| `/mcp/admin` | The four runtime tools plus `category_manage`, `skill_manage`, `resource_manage` | Admin token |

Each request requires `Authorization: Bearer <agent-token>`. Tokens expire, can be revoked, and are stored only as hashes. Each token identifies an account and an agent. Different accounts have separate catalogs; sessions belong to their account and agent. Rotating a token with the same identity preserves access to that agent’s sessions.

Register the runtime endpoint for agents that consume skills. Register the admin endpoint for agents that also manage the catalog; it includes the runtime tools, so registering both duplicates them.

## Run

Requirements: Node.js 24+, npm, and Postgres. Install dependencies with `npm ci`.

For a local development setup with Docker, run:

```sh
./start.sh
```

The launcher opens Docker Desktop on macOS if needed, creates or restarts
`skillgesture-postgres`, waits for database readiness, installs missing Node
dependencies, and starts the cloud MCP at `http://127.0.0.1:8080/mcp`. Both
services bind to loopback. Postgres data persists in `skillgesture-postgres-data`.
On macOS, the launcher generates a password and saves it in Keychain; it can also
adopt the password of the container created by the manual setup. On other systems,
supply `PGPASSWORD`. An existing container's mapped database port is reused;
new containers use port 5433. HTTP uses port 8080.

Leave the terminal open. `Ctrl+C` stops SkillGesture while Postgres remains
available. To stop the database too, run `docker stop skillgesture-postgres`.
Check readiness with `curl -f http://127.0.0.1:8080/health`.
The launcher starts the service; agent token creation and catalog import remain
the separate steps described below. It does not load `.env` or use production
database/TLS settings. `./start.sh --help` shows the prerequisites.

The default command starts the cloud server:

```sh
npm start
```

Supply settings through the environment or a secret manager; `.env.example` documents them. Node does not load `.env` automatically with this command.

- `PUBLIC_URL`: canonical HTTPS URL ending in `/mcp`.
- Database: `DATABASE_URL`, or `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` with `DATABASE_PASSWORD_FILE` or `PGPASSWORD`.
- Native HTTPS: set both `TLS_CERT` and `TLS_KEY` to certificate/key files.
- HTTPS proxy: set `TRUST_PROXY=1` only when the app is reachable exclusively through a trusted proxy that supplies `X-Forwarded-Proto: https`.
- `HOST` defaults to `127.0.0.1`; `PORT` defaults to `8080`.
- Browser clients: explicitly allow their origins with comma-separated `ALLOWED_ORIGINS`.

For local development only, `PUBLIC_URL=http://127.0.0.1:8080/mcp` with `ALLOW_INSECURE_LOCALHOST=1` enables HTTP on loopback. Production MCP requests require HTTPS. `/health` reports database readiness without returning deployment details.

The MCP HTTP transport is request-local and returns JSON. Durable **agent sessions are stored in Postgres**, independent of transport connections and server restarts.

## Create agent tokens

The operator CLI uses database credentials and is not exposed through MCP:

```sh
npm run --silent admin -- token create --agent catalog-admin --admin
npm run --silent admin -- token create --account <account-uuid> --agent codex
npm run --silent admin -- token revoke --id <token-uuid>
```

The first command creates an account if `--account` is omitted. Token creation returns `accountId`, token `id`, `agentId`, access level and the secret **once**. Send that output directly to a secret manager or macOS Keychain. Keep agent tokens out of repository files and chat logs. `--days` sets expiry from 1 to 365 days; the default is 30.

Use a distinct `--agent` identity for each agent. One agent can create multiple independent sessions, each with its own UUID. Agents cannot resume, configure, list or close another agent’s sessions, including when their token has admin access.

## Categories and discovery

A category’s `default` flag controls preloading. Its `enabled` flag controls availability. Preloading includes **metadata**, never every skill body.

`skill_categories` lists all enabled available categories, including optional ones:

```json
{"query":"fentaris","limit":5}
```

`skill_tree` searches default categories and any explicitly selected categories:

```json
{"categoryIds":["fentaris"],"query":"coordination","limit":5}
```

For an occasional request, pass `categoryIds` directly to discovery and reads. For a continuing task, open a session with `categories` and reuse its ID. `categoryId` on `skill_tree` filters the active set; it does not activate a category by itself.

Discovery returns compact refs and descriptions, with optional names and subskills. It accepts `query`, `limit` (1–50, default 12), `cursor` and `knownIndexVersion`. When `truncated` is true, pass `nextCursor` back as `cursor` using the same request context. When `notModified` is true, reuse the cached index. Cursors and versions are bound to identity, scope, query, page size, session version and catalog revision.

## Read only what is needed

Single read:

```json
{"sessionId":"<uuid>","ref":"fentaris/coordination"}
```

Batch read, preserving order and independent item errors:

```json
{"items":[{"ref":"general/git"},{"ref":"general/git","resourcePath":"references/rebase.md"}]}
```

A batch accepts 1–8 items and has a 1 MiB response budget. Oversized items receive `RESPONSE_TOO_LARGE` and can be requested separately. Single reads return unchanged Markdown and a resource-path index when resources exist. Resource reads return `content`, `encoding` and `mimeType`; binary data uses Base64. Resource paths are logical bundle paths, not server filesystem paths.

Single-read fields and `items` are mutually exclusive. The MCP tool publishes their actual object schema in `tools/list`.

Responses have one JSON text payload by default. `SKILLGESTURE_STRUCTURED_OUTPUT=1` advertises output schemas and uses only `structuredContent` for success, with empty `content`. Errors retain one readable text payload. Clients can parse `result.structuredContent ?? JSON.parse(result.content[0].text)`.

## Durable sessions

Open a fresh session with `action: "open"`, optional `label`, `categories` and `discovery`. Resume with `action: "open"` and `sessionId`; an unknown ID never creates a replacement. Configure and close require the current `expectedVersion`.

```json
{"action":"configure","sessionId":"<uuid>","mode":"add","categories":["fentaris"],"expectedVersion":1}
```

`mode` supports `replace`, `add` and `remove`. Default categories always remain available; configuration changes the selected optional categories. `action: "list"` returns only the authenticated agent’s sessions and supports bounded pagination/search. `action: "close"` removes that session, not catalog content.

## Manage the catalog

Use these tools through `/mcp/admin`:

| Tool | Actions |
| --- | --- |
| `category_manage` | `list`, `get`, `upsert`, `delete`, `restore` |
| `skill_manage` | `list`, `get`, `upsert`, `delete`, `restore` |
| `resource_manage` | `upsert`, `delete` on one bundled path |

Create an optional category:

```json
{"action":"upsert","id":"fentaris","name":"Fentaris","description":"Agent coordination","default":false}
```

Create a skill, or use a three-part ref for a subskill:

```json
{"action":"upsert","ref":"fentaris/coordination","name":"Coordination","description":"Coordinate agent work","markdown":"# Coordination\n\nInstructions."}
```

Update a skill after `get` returns its current version:

```json
{"action":"upsert","ref":"fentaris/coordination","markdown":"# Updated instructions","expectedVersion":1}
```

Attach one resource through `resource_manage`:

```json
{"action":"upsert","ref":"fentaris/coordination","path":"references/protocol.md","content":"Protocol details","expectedVersion":2}
```

Existing nodes require `expectedVersion`; stale writes return `VERSION_CONFLICT`. Mutations return only the new `version`. A resource edit advances its parent node’s version and retains unchanged resources. Resources are limited to 5 MiB each, 20 MiB and 200 paths per node. Markdown is limited to 256 KiB; HTTP request bodies are limited to 8 MiB.

Delete operations archive categories or nodes; `restore` reverses deletion. Archived/disabled parents hide descendants. Administrative `list` and `get` expose metadata and versions; `includeDeleted: true` makes archived nodes inspectable. Immutable content/resource revisions and an audit record remain in SQL. Skill bodies are still fetched through `skill_read` when active and selected.

## Import the local catalog

The operator CLI imports the existing store into an **empty account**, in one transaction:

```sh
npm run --silent admin -- import --root /absolute/path/to/.skillgesture --account <account-uuid>
```

Groups become categories. Entirely global groups become default categories; entirely folder-scoped groups become optional. Mixed groups require an explicit `--defaults coding,general` selection (use `--defaults ''` for no defaults), preventing accidental scope broadening.

The import preserves active versions, Markdown, resources and subskills without changing the source. Historical Markdown and original resource artifacts are retained; `sg_import_metadata` and `sg_import_files` preserve the original catalog/associations and bundle artifacts for recovery. The old format did not retain complete historical metadata/resource manifests, so those cannot be reconstructed as complete revision snapshots. Folder associations are archived rather than used as cloud authorization.

Local sessions do not carry authenticated agent identities and are not automatically assigned to cloud agents. Create cloud sessions using each agent’s token. The local compatibility server remains available through `npm run start:local` or `skillgesture-local`; new cloud tools accept categories, not filesystem folders.

## Container deployment

`compose.yaml` supplies Postgres, the Node service and Caddy HTTPS termination. Set `SKILLGESTURE_DOMAIN` to a domain pointing to the host and `SKILLGESTURE_DB_PASSWORD_FILE` to an external password file readable by the containers, then run:

```sh
docker compose up -d --build
docker compose exec skillgesture node src/admin.js token create --agent catalog-admin --admin
```

Only Caddy publishes ports. The app/database remain on the internal network; Postgres data and HTTPS state use persistent volumes. Manage backups with the usual Postgres backup tools. A managed Postgres service and another HTTPS proxy can use the same application entry point.

## Verification

```sh
npm test
npm run bench:cloud -- --smoke
npm run bench -- --smoke
```

Cloud tests run the production SQL against embedded Postgres by default, including persistence after restart, account/agent isolation, version conflicts, reversible deletion, import rollback and real MCP HTTP/HTTPS calls. Set `SKILLGESTURE_TEST_DATABASE_URL` to a dedicated Postgres test database to exercise the `pg` wire driver; tests create and remove isolated schemas. Loopback listening is required for HTTP tests.

The cloud benchmark compares discovery against a local compact-v2 control with identical entries, measures tool definitions and read/batch envelopes, and reports `ceil(bytes/4)` estimated tokens. Timings are informational. The original local benchmark remains available for comparison.

## License

ISC
