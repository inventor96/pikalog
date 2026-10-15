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

## Privacy and intended use

The Worker is the only app component that accesses D1. Catalog sync downloads public catalog files; it does not send inventory data upstream. Do not enter glucose, insulin, dose, or other health data. Pikalog is not a medical device and does not provide medical advice. Use supplies according to the manufacturer's instructions for use.
