# Pikalog

![Pikalog Logo](public/web-app-manifest-192x192.png)

Expiry-aware inventory tracking for diabetes supplies. Pikalog stores supply inventory only. It does not collect glucose readings, doses, or other health data, and it is not a medical device. Projections are estimates; manufacturer instructions for use take precedence.

## Why the Pika?

Pika is a small mammal that spends the summer stockpiling hay for winter, which is FIFO (First In, First Out) rotation in animal form. Similarly, Pikalog helps you manage your diabetes supplies using the same principle.

## How to use this project

This project is intended to be set up per-person, meaning each individual user should deploy their own instance to manage their inventory. It's built around deploying to Cloudflare Workers (thanks to their generous free tier), but it can be adapted to other hosting environments if you choose. Click the button below to set up your own instance.

**PASSWORD NOTE:** The absolute **minimum** password length is 8 characters, but 12 to 15 or more characters is strongly recommended for security. Since this project doesn't store sensitive information, nor does it provide mission-critical functionality, the worst that could happen is someone affecting your inventory numbers. It's up to you how much you want to protect those numbers.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/inventor96/pikalog)

Each deployment runs in its owner's Cloudflare account. Pikalog is an early-stage project; the deploy flow and fresh-account setup still need end-to-end verification before the button is considered release-ready.

## Local development

Requirements: Node.js 22.18 or newer and npm.

```sh
npm install
npm run db:migrate:local
npm run dev
```

Create a git-ignored `.dev.vars` file in the repository root before starting the local Worker. Set a private password of at least 8 characters; 12 to 15 or more characters is strongly recommended:

```ini
PIKALOG_PASSWORD=
```

Fill in the password locally; do not commit it or reuse another service's credentials.

The local Worker uses a local D1 database. Run `npm test` for the domain tests and `npm run build` for type-checking and a production build.

Catalog data is validated against the bundled JSON schemas and manifest checksums with `npm run catalog:validate`. The Worker starts with the bundled catalog and checks the configured public catalog source daily; manual sync is available from the run-out outlook.

## Cloudflare deployment

The Deploy to Cloudflare button creates a Git copy in your account, prompts for a household password, and provisions the configured D1 binding. Use at least 8 characters; 12 to 15 or more is strongly recommended. The deploy command applies D1 migrations before publishing the Worker and Vue assets. The repository must be public for the button to work.

For an existing deployment, set or update `PIKALOG_PASSWORD` with `npx wrangler secret put PIKALOG_PASSWORD`. Keep it private. The Worker fails closed until a password of at least 8 characters is configured.

## Back up and restore

Export the complete remote D1 database, including schema and data, with Wrangler. The output is plain SQL and contains your inventory and supply history; store it securely outside the repository and never commit it.

```sh
npx wrangler d1 export pikalog-db --remote --output="$HOME/pikalog-backup-$(date +%F).sql"
```

To restore an export, use a new or intentionally prepared database and review the SQL before executing it. Do not replay a full export blindly against a live database.

```sh
npx wrangler d1 execute pikalog-db --remote --file="$HOME/pikalog-backup.sql"
```

See Cloudflare's [D1 import and export guide](https://developers.cloudflare.com/d1/best-practices/import-export-data/) for options and limitations. Keep backups current and test restoration separately; Pikalog does not create or retain backups for you.

## Update your deployment

The catalog sync updates public catalog data only. It does not update the app code or database schema. To bring upstream app changes into your GitHub copy, review and merge them rather than replacing your repository; then test and deploy from your copy:

```sh
git remote add upstream https://github.com/inventor96/pikalog.git
git fetch upstream
git merge upstream/main
npm ci
npm test
npm run build
npm run deploy
```

Skip `git remote add` if you already have an `upstream` remote. Resolve and review merge conflicts before deploying. `npm run deploy` applies remote D1 migrations, builds the app, and deploys the Worker; it requires Wrangler access to your Cloudflare account and your `PIKALOG_PASSWORD` secret to be configured. Back up D1 before deploying schema changes.

## Privacy and intended use

The Worker is the only app component that accesses D1. Catalog sync downloads public catalog files; it does not send inventory data upstream. Do not enter glucose, insulin, dose, or other health data. Pikalog is not a medical device and does not provide medical advice. Use supplies according to the manufacturer's instructions for use.

The optional **Report catalog gap** action opens a prefilled GitHub issue with manufacturer, product name, and GTIN or unrecognized barcode text. It excludes receipt dates and inventory history. Review unrecognized barcode text for lot, serial, or expiry details before submitting.
