# Airboost API – Copilot Instructions

## What This Is

Airboost is a **high-performance Airtable cache service**: it mirrors an Airtable base into local SQLite databases and exposes a REST API so clients read from SQLite instead of hitting Airtable directly. All API responses include `backend: "sqlite"`.

## Architecture

### Dual-Database Strategy (critical concept)
Two SQLite databases (`data/airboost-v1.sqlite`, `data/airboost-v2.sqlite`) plus a metadata DB enable **zero-downtime atomic refreshes**. The active DB serves live traffic while the inactive one is fully rebuilt, then roles swap. Managed by `SQLiteService` in `src/lib/sqlite/index.ts`.

### Sync Modes (set via `SYNC_MODE` env var)
- **`polling`** – worker refreshes on a timer (`REFRESH_INTERVAL`)
- **`webhook`** – Airtable posts change events to `POST /webhooks/airtable/refresh`; incremental per-record refresh via `SQLiteBackend.incrementalRefresh()`; failsafe polling via `FAILSAFE_REFRESH_INTERVAL`
- **`manual`** – refresh only via `POST /api/refresh`

### Request Flow
```
HTTP Request → Elysia app (src/api/app.ts)
  → bearerAuth middleware (src/api/middleware/auth.ts)
  → endpoint plugin (src/api/endpoints/*.ts)
  → sqliteService singleton (src/lib/sqlite/index.ts)
```

The background `Worker` (`src/worker/index.ts`) owns refresh logic via `SQLiteBackend` (`src/worker/backends/sqlite-backend.ts`) and communicates with the main process via typed `postMessage` using `WorkerMessage` / `WorkerResponse` discriminated unions.

### Table Name Normalization
All table names are stored and queried using `normalizeKey()` (`src/lib/utils/index.ts`): lowercase, stripped of spaces and non-alphanumeric chars. Always decode URL params and normalize before SQLite lookups. Missing this causes silent 404s.

```typescript
const normalizedTableName = normalizeKey(decodeURIComponent(tableName));
```

## Runtime: Bun (not Node)

| Use | Instead of |
|---|---|
| `bun:sqlite` | `better-sqlite3` |
| `Bun.file()` | `node:fs` read/write |
| `Bun.$\`cmd\`` | execa |
| `Bun.serve()` + Elysia | Express / Hono |
| `.env` auto-loaded | dotenv |

## Key Commands

```bash
bun index.ts                          # Start
bun --hot index.ts                    # Start with hot reload
bun test                              # All tests
bun test tests/api.test.ts -t "name"  # Single test
bun run check                         # Biome lint + format (auto-fix)
bun run types                         # Regenerate schema.ts + mappings.json from Airtable
```

> **When to run `bun run types`**: after adding/renaming Airtable tables or fields. A stale `schema.ts` causes `incrementalRefresh` to skip tables with a `"Table ID not found in mappings"` warning.

## TypeScript Patterns

This project uses **strict TypeScript** (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`).

- `interface` for exported public API shapes (`Config`, `RefreshStats`, `WorkerMessage`)
- `type` for union literals (`SyncMode = "polling" | "webhook" | "manual"`)
- `import type` for type-only imports
- **Never use `any` for external data** — use `unknown` and narrow, or cast via `as unknown as T` only when the Airtable SDK type is imprecise (existing pattern in `sqlite-backend.ts`)
- Discriminated unions for Worker communication — always add a `default: never` exhaustiveness check when extending `WorkerMessage.type`

## Input Validation (Elysia TypeBox — not Zod)

Use Elysia's built-in `t` (TypeBox) for request validation, not Zod:

```typescript
import { Elysia, t } from "elysia";

new Elysia({ prefix: "/api/example" }).get(
  "/:tableName",
  async ({ params: { tableName }, query }) => { /* ... */ },
  {
    params: t.Object({ tableName: t.String() }),
    query: t.Object({
      page: t.Optional(t.String()),
      filter: t.Optional(t.String()),
    }),
  },
);
```

## API Conventions

### Response envelope
All responses include `backend: "sqlite"`. Paginated list endpoints return:
```json
{ "backend": "sqlite", "records": [], "pagination": { "page": 1, "pageSize": 100, "total": 0 } }
```

### Pagination
Offset-based via `?page=1&pageSize=100` (not cursor-based). Parse with `Number.parseInt`, default page=1, pageSize=100.

### HTTP status codes
- `401` — missing/invalid Bearer token or HMAC signature
- `404` — table or record not found (always check `tableExists()` before `getRecords()`)
- `500` — internal error (log server-side, return `{ error: "message", backend: "sqlite" }`)

### Code conventions
- **Tabs** for indentation, **double quotes** for strings (Biome-enforced)
- Dynamic imports in handlers to optimize startup: `const { sqliteService } = await import("../../lib/sqlite/index")`
- `SCREAMING_SNAKE_CASE` for constants, `PascalCase` for classes/types, `camelCase` for functions, `lowercase-hyphenated` for filenames

## Adding a New Endpoint

1. Create `src/api/endpoints/<name>.ts` — export an `Elysia` plugin with a `prefix`
2. Validate all params/query with `t.Object({ ... })` in the route options
3. Use `sqliteService` singleton; `bearerAuth` is applied globally in `app.ts`
4. Always include `backend: "sqlite"` in every response object

## Webhook Security

`POST /webhooks/airtable/refresh` validates an HMAC-SHA256 signature from `x-airtable-content-mac`. The HMAC secret (`macSecretBase64`) lives in the **metadata SQLite DB**, not in env vars. Ping payloads (`{}`) are accepted without signature verification. See `src/api/endpoints/webhooks.ts` and `src/lib/airtable/webhook-hmac.ts`.

## Testing Patterns

Tests spin up isolated server instances on port **3001** (check `tests/test-config.ts`). Auth is bypassed via `AUTH_DISABLED=true`. **Never hardcode Airtable table names** — always fetch dynamically:

```typescript
const tablesResult = await apiRequest("/api/tables");
const firstTable = tablesResult.data.tables[0];
```

## Security Rules

- Never expose real Airtable table names in code, docs, or commits
- All `/api/*` routes require Bearer token authentication (`/health` is public)
- Use `timingSafeEqual` for all token/signature comparisons — pad inputs to equal length first (see `auth.ts`)
- Never commit `.env`, `data/`, `src/lib/airtable/schema.ts`
- **Never perform git commits autonomously**
