# Pikalog (Supply Tracker): Design and Handoff

## Purpose and principles

An open-source, expiry-aware inventory tracker for type 1 diabetes supplies (CGM sensors, pump sets, cartridges, strips), deployable in one step to a user's own free-tier Cloudflare account. The author's driving case: a large backlog of an older CGM sensor (Guardian 4, "G4") plus auto-shipped newer single-use sensors (Instinct) that carry an internal battery and must be used before they expire. The app tells him when a G4 can be worn without wasting an Instinct.

Guiding principles:

- **Derive, never store.** On-hand counts, run-out dates, wear durations and burn rates are computed from an immutable event ledger.
- **Scan first.** Barcodes identify product, expiry and lot. Manual entry is the fallback, not the main path.
- **Supplies only.** No glucose readings, no doses, no health data.
- **User owns the data.** Each deployment lives in the user's own account; the project never holds user data.
- **Build for one real user first.** Generalize through category and product, not through a plugin system.

## Goals and non-goals

v1 must answer three questions: when will I run out, when must I reorder, and what should I put on or open next.

Goals:

- Multi-device access with cloud durability, installable as a PWA.
- Scan a box to receive it or open it; auto-identify product, expiry and lot.
- Expiry-aware recommendation of which product to use next (the G4 versus Instinct decision across the whole stock, not just the next sensor).
- Measured average wear duration per product, feeding projections and shown as information.
- Over-supply forecast: warn when auto-ship or refills will outpace consumption.
- Community catalog of products and barcode formats that updates without an app upgrade.
- One-click deploy with minimal setup for non-developers.

Non-goals for v1:

- Dosing, glucose logging, insulin tracking or any medical advice.
- Insurance, pharmacy or manufacturer integrations.
- A hosted multi-tenant service operated by the project.
- A plugin or extension system for manufacturers.
- Native mobile apps and push notifications (reconsider after v1).

## Architecture and hosting

One Cloudflare Worker serves the Vue SPA as static assets and exposes the API, backed by D1. Users deploy it into their own account with a deploy button.

&#91;embedded content: architecture · 1 Worker, D1, cron sync\]

Scanners feed the browser, the Worker is the only component that touches D1, and a daily cron pulls the public catalog.

- **Stack.** TypeScript throughout: Worker with Hono, D1 (SQLite), Vue SPA built to static assets, Vitest for tests.
- **One-click deploy.** A "Deploy to Cloudflare" button in the README. Verify on a fresh account that it provisions D1 and runs migrations; if not, make migrations idempotent and run them on first request.
- **Configuration.** Secrets prompted at deploy (the app password). No other required setup.
- **PWA.** Installable with an offline shell; writes require connectivity in v1.
- **Free-tier limits.** Confirm current limits for Workers, D1 and Cron Triggers before committing; they have changed before.

## Domain model

Packages and events are the only stored facts. Everything else is derived. Dates are `YYYY-MM-DD` strings converted to integer day numbers for math, so timezones cannot shift an expiry. Target: D1 (SQLite).

```sql
CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,               -- cgm_sensor, infusion_set, cartridge
  name TEXT NOT NULL,
  overlap_allowed INTEGER NOT NULL DEFAULT 0  -- 1 if units may be worn at once (trialing two devices)
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  manufacturer TEXT NOT NULL,
  name TEXT NOT NULL,
  gtin TEXT UNIQUE,                       -- this product's own GTIN, null for custom products
  contains_product_id INTEGER REFERENCES products(id),  -- set on a pack: the unit product inside
  contains_qty INTEGER,                   -- units in the pack
  rated_wear_days INTEGER,                -- unit products only; manufacturer rating
  min_samples INTEGER NOT NULL DEFAULT 3, -- measured wear replaces rated at this many samples
  expiry_rule TEXT NOT NULL DEFAULT 'finish_by',   -- shown as use by; or start_by | none
  expiry_strictness TEXT NOT NULL DEFAULT 'hard',  -- hard | soft
  origin TEXT NOT NULL DEFAULT 'custom',  -- catalog | custom
  catalog_key TEXT,
  catalog_version INTEGER
);

CREATE TABLE packages (                   -- one received pack, or one received loose unit
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot TEXT, serial TEXT,
  expiry TEXT,                            -- YYYY-MM-DD
  raw_barcode TEXT,
  implicit INTEGER NOT NULL DEFAULT 0     -- 1 if created by a unit scan with no matching package
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  type TEXT NOT NULL,   -- received | opened | unit_started | unit_ended | discarded | adjusted
  qty INTEGER NOT NULL DEFAULT 1,         -- adjusted may be negative
  occurred_on TEXT NOT NULL,              -- user-local date; for received, the arrival date
  recorded_at TEXT NOT NULL,              -- UTC, audit only
  unit_serial TEXT,                       -- from the unit's own code, when present
  unit_expiry TEXT,                       -- from the unit's own code, when present
  inferred INTEGER NOT NULL DEFAULT 0,    -- 1 if created by gap-fill or mark as used
  end_reason TEXT,      -- unit_ended only: planned | extended | early_failure | other
  note TEXT
);
```

Rules the implementation must honor:

- **Events are immutable.** Corrections are new `adjusted` events, never edits.
- **Packs and units.** A pack product points at the unit product it contains (`contains_product_id`, `contains_qty`). Each has its own GTIN when the manufacturer prints one. Example: a G4 sensor pack contains 5 G4 sensors, each with its own DataMatrix. An Instinct sensor is sold in single-sensor boxes, so it is a plain unit product with no pack. Pump sets and cartridges follow the G4 pattern.
- **Expiry semantics.** `finish_by` (shown as use by, the default) means a unit should be started early enough to finish wearing by the expiry date. `start_by` is a per-product option meaning start by the expiry date. Neither is an automatic failure, since items can work past expiry with lower odds of success and possible loss of manufacturer support. `expiry_strictness = hard` makes a product a planner constraint and counts misses as waste; `soft` makes it a filler the planner may use freely and only warns.
- **One wear timeline per category.** Starting any unit ends the previous active unit in that category, whatever its product. The start form has an optional previous one ended on field, defaulting to today. Unit durations therefore stay accurate when products interleave. The `overlap_allowed` flag (default off) covers trialing two devices at once: when on, starting a unit does not end the previous one, only explicit ends count, and the rated duration is the fallback.
- **Opening a pack.** Remaining means units of the previous open pack of the same product that are not yet ended or discarded, including one currently active. The open confirmation shows a start the first unit now toggle, defaulted by the remaining count: 0 remaining is on (nothing to end, first unit starts today); 1 remaining is on (the new first unit starts today and ends the active last unit of the previous pack); more than 1 remaining is off (the pack is assumed to be opened proactively). The user can flip the toggle either way, for example to start tomorrow instead. The thresholds and defaults are settings.
- **Starting despite leftovers.** If the user turns the toggle on while more than 1 unit remains, show a warning that more of the previous pack was expected to be used first, with two options: keep them in stock for later use out of chronological order (they stay in the FIFO list, flagged skipped, so nothing is forgotten), or mark them as used (recorded as inferred usage, with dates filled from gaps in the timeline).
- **Unit scan matching.** Use every field a code provides and fall back in order: (1) lot and expiry match a received package of the parent pack; (2) same lot, oldest received package first; (3) expiry only; (4) GTIN only, attach to the oldest received package of the parent that has units remaining; (5) no eligible package, create an implicit one and tell the user. Store the unit's serial and expiry on the event when present, warn when a serial was already used, and let a unit expiry override the package expiry in planning. In Open mode, an item scan marks its matched unopened package as opened by default; the scanner toggle can leave it unopened. Opening and starting the scanned unit are recorded together.
- **Logging is optional at every level.** Opening a package or starting a unit is the only required action. Everything else is inferred.
- **Inference.** Logged intervals are fixed. Timeline time not covered by a logged interval is a gap. Gaps are filled with inferred units from open packs, `round(gap / expected duration)` of the product being filled, using the measured (else rated) duration. If gaps imply more units than open packs hold, the surplus is shown as an unexplained gap and no stock is invented. Inferred units are labelled inferred, drawn dashed on the timeline, and editable. Example: Instinct starts on Jan 10 and Jan 30 with a 10-day wear leave 10 uncovered days, so one inferred G4 unit starts on Jan 20.
- **Receiving.** Arrival date is an optional field defaulting to today. Shelf life per product is inferred from expiry minus arrival across the user's receipts, so no shelf-life field is needed.
- **Catalog versus user data.** Catalog-origin rows are replaced by sync; user edits live in overrides and custom products (see Catalog and sync).

## Barcode ingestion

One function, `ingest(raw: string)`, fed by every input path. Most medical packaging is GS1, so one solid GS1 parser plus a GTIN-keyed catalog covers most manufacturers; custom rules are only for non-GS1 formats.

Input paths:

- USB or Bluetooth keyboard-wedge scanners, which deliver a raw string as typed input.
- Camera scanning via a WASM decoder such as zxing-wasm. Native BarcodeDetector support is uneven, so do not depend on it.

Pipeline:

1. Normalize: strip symbology identifiers, accept the GS1 group separator (ASCII 29) present, absent or replaced, since wedge scanners often drop it.
2. Parse GS1 application identifiers: 01 (GTIN), 17 (expiry, YYMMDD; day 00 means last day of that month), 10 (lot), 21 (serial). Without separators, rely on fixed-length AIs and parse variable-length fields last.
3. Look up the GTIN in the catalog. Pack and unit GTINs each map to their own product; a pack product points at the unit product it contains.
4. For non-GS1 codes, try the catalog's `barcode_formats` rules (regex plus a field map).
5. Return `Resolved`, `Ambiguous(candidates)` or `Unknown`. Prompt the user only for the last two.

Behavior:

- A persistent mode toggle (Receive or Open) decides what a resolved scan does. One scan is one action, with an undo toast.
- Warn on a duplicate serial or lot already received.
- Unknown flow: keep the raw string, ask for product details, save as a custom product, and offer a "contribute to catalog" link that opens a pre-filled GitHub issue.
- Store `raw_barcode` on every box so rules can be re-run when the catalog improves.

Scanning a pack and scanning a unit are both first-class. In Open mode a pack scan opens the package and applies the start-first-unit rule from the domain model; if more than one unit remains from the previous package, opening asks whether to start a unit now, and starting it asks whether to keep the leftovers or mark them used. An item scan starts that unit, matched to a package by the fallback chain above; if it opens an unopened package while more than one unit remains from the previous package, the same leftover choice is required before any events are recorded. In Receive mode the scan takes an optional arrival date, defaulting to today. The parser uses every field a code provides (GTIN, lot, expiry, serial) and degrades gracefully when fields are missing, since the contents of unit codes vary by product.

Testing: build fixtures from the author's real box barcodes, each in with-separator and without-separator form. Spike camera decoding of the small DataMatrix codes on real packaging before anything else; it is the highest technical risk.

## Catalog and sync

The catalog is public data in a `/catalog` subfolder of the main repo, so everything stays in one place and no extra service is needed. A deploy-button clone detaches from upstream, so catalog sync is the only automatic update channel users get.

Files:

- `categories.json`, `products.json` and `barcode_formats.json`.
- `manifest.json` with `version`, `schemaVersion` and a sha256 per file.
- JSON Schema validation in CI. Each product entry carries a source reference (instructions-for-use link or photo) and a `verified` flag.

Sync mechanism:

1. A Worker Cron Trigger (daily) fetches `manifest.json` from raw.githubusercontent.com on `main`. The base URL is a config variable, so a fork or a CDN such as jsDelivr can be swapped in without a code change. Use ETag or version to skip unchanged data. Protection against bad data comes from required PR review, CI schema validation, sanity bounds the app applies on every sync (for example, rejecting implausible wear durations), and revert as the rollback.
2. Validate every file against the bundled schema and checksums before touching the database.
3. Upsert into catalog tables in one transaction. On any failure keep the last good copy and record the error.
4. If `schemaVersion` is newer than the app supports, skip the update and show an "update the app" notice.
5. Show last sync time and status in settings, plus a manual "sync now".

Safeguards:

- Ship a seed catalog inside the app so it works from first deploy with no network.
- Keep user edits in `product_overrides(product_id, field, value)` and `origin = custom` products. Sync never touches them.
- Wrong pack sizes or wear durations silently skew projections, so catalog PRs need review and a source reference.
- The sync only pulls public data and sends nothing about the user.

## Planner

The planner answers one question: how many filler (soft-expiry) slots can be inserted now without causing additional waste of hard-expiry units? A result above zero means wear the filler next. It is a pure function of integer days with no database access, so it is trivially testable.

Inputs:

- Hard-expiry units with `availableOn` and `deadline`. For `finish_by` the deadline is `expiry - W`; for `start_by` it is `expiry`.
- `W`, the effective wear duration: measured median once the product's `min_samples` is met, else `rated_wear_days`.
- Count of filler units on hand.
- Expected arrivals, inferred rather than entered: per product, projected from the user's own receipt history (median interval and quantity). Projected expiry is arrival plus the median observed shelf life (expiry minus arrival on past receipts). They are shown as estimates, need history to exist, and can be switched off.

Reference implementation sketch (day-by-day simulation, because arrivals break a closed-form slack formula):

```ts
type Unit = { availableOn: number; deadline: number };

function simulate(today: number, W: number, hard: Unit[], fillersFirst: number): Unit[] {
  let t = today + fillersFirst * W;
  const pending = [...hard].sort((a, b) => a.deadline - b.deadline);
  const waste: Unit[] = [];
  while (pending.length) {
    const i = pending.findIndex(u => u.availableOn <= t);
    if (i === -1) { t += W; continue; }          // nothing arrived yet: filler slot
    const [u] = pending.splice(i, 1);
    if (t > u.deadline) waste.push(u); else t += W;
  }
  return waste;
}

function plan(today: number, W: number, hard: Unit[], fillerStock: number) {
  const baseline = simulate(today, W, hard, 0).length;
  let k = 0;
  while (k < fillerStock && simulate(today, W, hard, k + 1).length <= baseline) k++;
  return { fillerSlotsSafe: k, wasteForecast: baseline, nextIsFiller: k > 0 };
}
```

Required behavior beyond the sketch:

- **Two forecasts.** Report waste against the preferred deadline (`finish_by`) and the tolerated deadline (`start_by`). A setting picks which one constrains filler decisions; default preferred.
- **Over-supply.** If `wasteForecast` is above zero with zero fillers, the supply is outpacing use. Report the surplus per quarter (arrival rate minus consumption rate) and say so plainly, since no scheduling can fix it.
- **Output.** `{ fillerSlotsSafe, nextPick, wasteForecast: { preferred, tolerated }, surplusPerQuarter, assumptions[] }`.
- **Generality.** Nothing manufacturer-specific. Behavior comes from `expiry_rule` and `expiry_strictness` on products.

## Duration and burn-rate statistics

Rated duration is a default, not the truth. Real durations differ by product and by user, so the app measures them and uses the measurement once the product's \`min\_samples\` setting is met (default 3, set per product).

How a duration is measured:

- **Logged:** a unit's duration runs from its start to the next start in the category, or to an explicit end (including the previous one ended on date). Interleaving products does not distort unit durations.
- **Inferred:** gap-filled units and units marked as used, using the rules in the domain model. Their duration is the gap they fill divided by the units placed in it.
- **Per pack:** open date to last unit end. It runs longer than units times unit duration when products interleave, so burn rate always uses unit durations, never pack duration.
- Every sample is labelled logged or inferred. Show both, and let the user choose which feed projections (default: both).

Design inputs from the author's real usage, which the model must accommodate:

| Item | Rated | Real behavior | Modeling consequence |
| --- | --- | --- | --- |
| Instinct CGM sensor | 10 days | Fixed 10 days unless it fails early | Hard expiry, duration constant |
| G4 CGM sensor | 7 days | Transmitter restart yields 1 to 3 extra sessions per sensor | Measured duration exceeds rated; log restarts via `unit_ended` reason `extended` |
| Pump infusion set plus cartridge | 7 days | About 5 days, because the cartridge empties first | Measured duration below rated; set and cartridge changed together |

Statistics to compute and show:

- Per product: median and mean duration, sample count, last-10 window, and early-failure rate. Early failures are excluded from the typical duration by default and shown separately.
- Per pack: open date to last unit end, shown as information.
- Burn rate: units per day, `1 / median duration`, per product and per category.
- Stock in days: on-hand units times median duration, plus the expiry-aware portion that will actually be usable before expiry.
- Reorder date: run-out date minus supplier lead time minus the insurer's refill eligibility window (both optional per-product settings).
- Pairs: set and cartridge are changed together, but v1 derives them independently. A later `pairs_with` link can tie their events.

## Privacy, auth and safety

The app stores only supply inventory. No glucose, dose or personal health data is collected, and none should ever be added.

- **Data location.** Each user deploys into their own Cloudflare account. No telemetry, no central server. Catalog sync pulls public files and sends nothing about the user.
- **Auth.** A deploy-time secret (password, or a passkey bootstrapped from it) with a session cookie and rate limiting. One shared household login in v1. Do not depend on Cloudflare Access: its Zero Trust setup happens outside the deploy button and breaks the one-step goal.
- **Disclaimer.** The UI and README state that this is not a medical device, projections are estimates, and manufacturer instructions for use always take precedence.
- **Catalog content.** Entries record facts (pack size, rated wear, shelf life) with sources. They never recommend using items past expiry.
- **Naming.** Manufacturer and product names appear factually for identification, with no implied endorsement.

## Testing, risks and milestones

Testing:

- Planner unit tests (Vitest) for: empty stock, single sensor, ample slack, zero slack, over-supply, arrival mid-queue, unit expiring before its arrival, `finish_by` versus `start_by`.
- GS1 parser tests against real box and unit barcode strings, with and without separators, including expiry day 00 and codes missing lot, expiry or serial.
- Domain rule tests: the start-first-unit toggle at 0, 1 and more than 1 remaining; the leftover warning and both of its options; the unit-scan matching fallbacks; overlap\_allowed on and off.
- Derivation tests: wear duration from logged and inferred paths, gap-fill including the surplus case, early-failure exclusion, interleaved products.
- Catalog CI: JSON Schema, checksums, manifest consistency.
- End to end: deploy-button flow on a fresh Cloudflare account before any feature work is called done.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Camera cannot decode small DataMatrix on real boxes | Scan-first workflow fails | Spike first; support wedge scanners and manual entry |
| Deploy button cannot provision D1 or run migrations | One-step deploy fails | Self-migrate on first request; verify on a fresh account early |
| Free-tier limits or terms change | Hosting breaks | D1 is SQLite, so data stays portable; document an export |
| Bad catalog data | Wrong projections | Source references, review, `verified` flag, local overrides |
| Over-generalized schema | Project stalls | Category and product only; no plugin system |
| Users drift from upstream code | Stale apps | Document manual update path; catalog sync is automatic |

Suggested milestones, each gated on the previous:

1. Scanner spike: decode real boxes by camera and wedge, GS1 parse only. Gate: author's boxes all resolve.
2. Schema, event ledger and planner as tested pure functions. Gate: all planner tests pass.
3. Worker, D1 and Vue SPA skeleton with password auth, serving static assets from the same Worker.
4. Deploy button proven on a fresh account with migrations. Gate: a second person deploys it unaided.
5. Scan flows (Receive, Open, per-unit start) and the stats views.
6. Catalog repo, schema CI and cron sync with overrides.
7. Contribution flow for unknown barcodes, README and disclaimer, public release.

Decisions made in review:

- Expiry defaults to use by (`finish_by`), with `start_by` as a per-product option.
- The `pairs_with` link waits until after v1.
- First-run setup is the auth secret only. Custom domain instructions go in the README or link to existing guides.

