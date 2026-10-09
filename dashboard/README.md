# SkillGesture dashboard

A separate React console for managing a local or remote SkillGesture catalog. Connect with the service URL and an admin token, then browse categories, edit instructions and resources, or inspect the catalog audit. The interface uses official [Coss UI components and neutral theme](https://coss.com/ui/docs/get-started), React, TypeScript, Vite and Tailwind CSS 4.

## Start

From the repository root:

```sh
npm run dashboard:install
ALLOWED_ORIGINS=http://127.0.0.1:5173 ./start.sh
```

In a second terminal:

```sh
npm run dashboard:dev
```

Open `http://127.0.0.1:5173`. Use `http://127.0.0.1:8080/mcp` as the local service URL and paste an admin token created with the operator CLI described in the root README. The dashboard does not create tokens. If the service is already running, restart it with the allowed origin and the new backend code. The database does not need a migration.

Vite prints the selected port. To require the documented origin, use `npm run dashboard:dev -- --port 5173 --strictPort`. If a different port or hostname is used, add that exact origin to `ALLOWED_ORIGINS` before restarting SkillGesture. `localhost` and `127.0.0.1` are different origins.

## Build

```sh
npm run dashboard:typecheck
npm run dashboard:test
npm run dashboard:build
npm run dashboard:preview
```

The static build is in `dashboard/dist/`. Serve that directory with any static server; preview defaults to `http://127.0.0.1:4173`, which must also be allowed on the backend. The frontend has no database or backend proxy and uses no environment variables containing credentials. Dependencies have a separate lockfile; root `npm ci` installs the service only, and `dashboard:install` installs the frontend.

## Remote service

Allow the hosted dashboard’s exact origin on the service, for example:

```sh
ALLOWED_ORIGINS=https://console.example.com
PUBLIC_URL=https://skills.example.com/mcp
```

Connect with `https://skills.example.com/mcp` and an admin token for the intended account. The connection also accepts the service origin or `/mcp/admin` URL. URLs containing credentials, query strings or fragments are rejected. Remote services require HTTPS; HTTP is accepted only for explicit loopback development. A dashboard hosted on HTTPS should connect to an HTTPS service.

Tokens and connection settings stay in memory. Logging out, changing the connection or receiving an authentication/authorization failure clears the credentials, pending requests and loaded account data. Reloading the page requires connecting again. Tokens are never written to browser storage, query strings or error messages. Markdown preview skips raw HTML and executable link schemes, and displays image placeholders rather than loading external images. Resource downloads use attachments.

## Workflows

- **Overview** shows account identity, catalog revision and counts for categories, skills, subskills and current resources. Counts are split into active, disabled and archived, including category and parent availability. It refreshes every 30 seconds while the view is visible and when the tab becomes visible again.
- **Catalog** shows category names for skills and skill/subskill counts for categories. Click any row, or focus it and press Enter or Space, to open the item. Category details open a separate skill list; **Settings** contains category metadata. The X archives a skill with confirmation, including its descendants in discovery; restore it through **Show archived**. Counts follow the visibility filters. Both catalog views show **Page X of Y**, with exact filtered totals. Disabled items are hidden until **Show disabled** is selected. Skill details show the category name beneath the title. Choose **Category** and edit **Reference skill name** in the adjacent field to rename or move a skill, preserving its content, history, resources and subskills. The category picker also supports creating a category on save. For subskills, the reference name contains `parent/subskill`. Occupied destinations are rejected; old references stop resolving after a successful move. Category IDs stay fixed after creation; default categories preload metadata for agents.
- **New skill** accepts a Markdown file through **Import skill file**. YAML frontmatter fills the name and description; plain Markdown uses its first heading or filename as the name. The original Markdown is preserved. Select a category, or type its name and choose **New category** to create it on save. A skill ID is generated from the name when **Reference skill name** is left empty; enter an override in that field, including `parent/subskill`. New skills start disabled; enable them explicitly when ready. Importing does not write to the service; replacing a draft requires confirmation. Files must be UTF-8 text within the 256 KiB Markdown limit. Creating a category and saving the skill are separate versioned operations; a failed skill save can leave the new category available for retry.
- **Resources** can be uploaded, downloaded, edited as text or removed. Save outstanding Markdown/metadata changes first. Limits match the backend: 256 KiB of UTF-8 Markdown, 5 MiB per resource, 200 resources and 20 MiB per skill. Uploading over an existing path requires confirmation; deleting a resource requires confirmation.
- **Activity** is read only and supports exact agent, operation and reference filters. An event’s details include time, identity, operation, reference and version. Historical versions cannot be compared or restored here.

Every mutation sends `expectedVersion`. A conflict keeps the draft and disables saving. **Load latest version** displays the current server version without changing the draft. Explicitly choose **Replace draft with latest**, or **Keep draft on v…** after reviewing it, then save again. Unsaved Markdown, metadata and resource drafts trigger a warning before closing the editor or leaving the page.

The console handles one account/connection at a time. It does not manage other agents’ tokens or sessions, show MCP call telemetry, or publish itself to a hosting provider.

## Admin HTTP contract

All routes require the same bearer admin token, account isolation, canonical host, HTTPS policy and `ALLOWED_ORIGINS` checks as `/mcp/admin`. Responses use `Cache-Control: no-store`. Allowed browser origins can preflight GET on these routes and POST on MCP. Failures return a safe `{ "error": "CODE" }` payload.

| Route | Result |
| --- | --- |
| `GET /api/admin/overview` | `identity` (`accountId`, `agentId`, `admin`), string `revision`, `updatedAt`, and `counts` with `active`, `disabled`, `archived`, `total` for each kind |
| `GET /api/admin/catalog?kind=skill&page=1&limit=20` | `items`, `total`, `totalPages`, `page`, `limit`; rows include effective `state`, `categoryName` for skills or `skillCount` for categories. Optional `query`, `categoryId`, `includeDisabled=true`, `includeDeleted=true` |
| `GET /api/admin/activity?agent=…&operation=…&ref=…&limit=50&cursor=…` | `events` with string `id`, `agentId`, `operation`, `ref`, `version`, `createdAt`; `truncated` and optional `nextCursor` |
| `GET /api/admin/content?ref=category/skill` | `ref`, current `version`, `markdown`, and resources with `path`, `mimeType`, `encoding`, `size` |
| `GET /api/admin/content?ref=category/skill&resourcePath=references/guide.md` | `ref`, current `version`, and `resource` with `content`, `mimeType`, `encoding`, `size` |

Catalog pages default to 20 items, accept limits 1–50 and clamp an out-of-range page to the last page. Empty lists have one page. Counts include subskills and apply the same visibility filters as the list. Category choices and metadata/mutations use the existing MCP SDK and tools. Activity defaults to 50 events and rejects limits outside 1–50; its cursors are bound to the account, filters and page size. Keyset pagination excludes new events inserted above the current page; refresh to see them. The client accepts either JSON text content or `structuredContent`. Normal MCP readers retain their existing restrictions for disabled and archived contents.
