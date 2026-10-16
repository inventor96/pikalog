# AGENTS.md

Expiry-aware inventory tracker for diabetes supplies. Each user deploys their own Cloudflare Worker (Hono API + Vue 3 SPA) backed by D1 (SQLite). There is no hosted backend; the Worker is the only component that touches D1.

## Commands

- `npm install` then `npm run db:migrate:local` then `npm run dev` — local setup order matters; the local D1 must be migrated before the Worker runs.
- Copy `.dev.vars.example` to `.dev.vars` and set `PIKALOG_PASSWORD` (>= 8 chars) before `npm run dev`. Auth fails closed until configured. `.dev.vars` is git-ignored.
- `npm test` (Vitest, one-shot) / `npm run test:watch`. Single file: `npx vitest run server/index.test.ts`.
- `npm run type-check` = `vue-tsc --build` across the 3 project refs. There is no linter configured.
- `npm run build` runs `type-check` and `vite build` in parallel (`run-p`). CI order is: `catalog:validate` -> `db:migrate:local` -> `test` -> `build`.
- `npm run cf-typegen` (`wrangler types`) regenerates `worker-configuration.d.ts`; rerun after changing `wrangler.jsonc` bindings.
- `npm run deploy` = remote D1 migrations, build, `wrangler deploy`. Do not run without explicit intent — it hits the user's Cloudflare account.

## Catalog

- `catalog/*.json` is public data published from `main` and bundled into the app; the daily cron pulls it via `CATALOG_BASE_URL`.
- After editing any of `categories.json`, `products.json`, `barcode_formats.json`: manually bump `manifest.json` `version`, run `npm run catalog:checksums` (rewrites only `files` hashes), then `npm run catalog:validate`.
- `catalog/validate.mjs` (Node/Ajv) is the source of truth for schema + checksums; `src/domain/catalog.ts` duplicates validation for runtime sync. Keep them consistent.
- `barcode_formats.json` rules are validated and synced but **not yet consumed** by the scanner.

## Architecture

- `server/index.ts` is the Worker entrypoint: all routes and every D1 query live here; it imports pure logic from `src/domain/*` and `src/barcode/*`. Keep domain logic pure and DB-free so it stays unit-testable.
- `src/domain/*.ts` are pure functions with co-located `*.test.ts`. `src/views/` and `src/components/` are the Vue SPA; `@/` aliases `src/`.
- `migrations/` is append-only; add a new numbered file, never edit applied ones.
- App code reads the SQL views `effective_products` / `effective_categories` (base tables merged with `*_overrides`), not the base tables, wherever user edits must apply. See `migrations/0005_catalog_management.sql`.
- `events` is an immutable append-only ledger enforced by SQL triggers; corrections are new `adjusted` events, never UPDATE/DELETE.
- Dates are `YYYY-MM-DD` strings converted to integer day numbers for math, so timezones cannot shift expiries.

## Testing / gotchas

- Worker route tests (`server/index.test.ts`) use a hand-rolled in-memory fake D1, not Miniflare/wrangler. Vitest runs in the `node` environment and no real D1 or network is involved.
- Passkeys are bound to the exact hostname and require HTTPS (`localhost` ok); switching `workers.dev` <-> custom domain requires re-enrollment.
- Store only supply inventory. Never add glucose readings, doses, or other health data.
