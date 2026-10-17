# Pikalog

![Pikalog Logo](public/web-app-manifest-192x192.png)

Expiry-aware inventory tracking for diabetes supplies. Pikalog stores supply inventory only. It does not collect glucose readings, doses, or other health data, and it is not a medical device. Projections are estimates; manufacturer instructions for use take precedence.

## Why the Pika?

Pika is a small mammal that spends the summer stockpiling hay for winter, which is FIFO (First In, First Out) rotation in animal form. Similarly, Pikalog helps you manage your diabetes supplies using the same principle.

## How to use this project

This project is intended to be set up per-person, meaning each individual user should deploy their own instance to manage their inventory. It's built around deploying to Cloudflare Workers (thanks to their generous free tier), but it can be adapted to other hosting environments if you choose. Click the button below to set up your own instance.

**PASSWORD NOTE:** The absolute **minimum** password length is 8 characters, but 12 to 15 or more characters is strongly recommended for security. Since this project doesn't store sensitive information, nor does it provide mission-critical functionality, the worst that could happen is someone affecting your inventory numbers. It's up to you how much you want to protect those numbers.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/inventor96/pikalog)

### Passkeys

After signing in, you can add passkeys on the Configuration page. Enrollment requires the household password again.

**Technical Notes for Advanced Usage:** Each passkey belongs to the exact hostname where it was added and requires HTTPS. So changing between a `workers.dev` address and a custom domain requires enrolling again on the new hostname. The household password must remain configured as a recovery method.

## Update your app

The catalog sync updates public catalog data only. It does not update the app code or database schema. To update your app with upstream changes, you'll need to do a one-time set up of a GitHub Actions workflow that you can use repeatedly thereafter. If you've already done the setup, [jump to `Doing the update`](#doing-the-update) below.

**Warning:** The update workflow replaces your repository's contents with the upstream code. Any local modifications to tracked files will be lost (your `.github/workflows` directory is preserved as-is, so upstream changes to CI workflows will not reach you). Back up your D1 data first if you are unsure.

### Setup

Ensure you're viewing your own repository on GitHub (the one Cloudflare created for you). Copy the workflow file contents below and then click "Add file" > "Create new file" above. Set the file name to `.github/workflows/sync.yml`, and then paste the workflow contents. Click the "Commit changes..." button to save the workflow.

```yaml
name: Update Pikalog app with upstream changes

permissions:
  contents: write

on:
  workflow_dispatch:

jobs:
  sync_latest_from_upstream:
    name: Update Pikalog app with upstream changes
    runs-on: ubuntu-latest

    steps:
      - name: Checkout target repo
        uses: actions/checkout@v3

      - name: Sync upstream changes
        id: sync
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

          # Fetch latest code
          git clone https://github.com/inventor96/pikalog /tmp/latest
          rm -rf /tmp/latest/.git

          # Copy workflow files to keep them the same
          rm -rf /tmp/latest/.github/workflows
          cp -r .github/workflows /tmp/latest/.github/workflows

          # Replace everything except .git with the upstream contents;
          # the copy above already carries this repo's workflow files,
          # so they come back in this step
          find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
          cp -r /tmp/latest/. .

          # Update the repository
          git add .
          git diff --cached --quiet || git commit -m "Sync latest code from upstream"
          git push
```

### Doing the update

Once the workflow is set up, you can trigger it manually from the "Actions" tab in your repository. Select the workflow you created ("Update Pikalog app with upstream changes") and click the "Run workflow" button. The workflow will fetch the latest changes from the upstream repository and apply them to your instance. Cloudflare Workers will then deploy the updated app automatically.

### Back up and restore

If you wish to back up your data before updating your app, export the complete remote D1 database, including schema and data, with Wrangler. The output is plain SQL and contains your inventory, supply history, and registered passkey public credentials; it does not contain authenticator private keys. Store it securely outside the repository and never commit it.

```sh
npx wrangler d1 export pikalog-db --remote --output="$HOME/pikalog-backup-$(date +%F).sql"
```

To restore an export, use a new or intentionally prepared database and review the SQL before executing it. Do not replay a full export blindly against a live database.

```sh
npx wrangler d1 execute pikalog-db --remote --file="$HOME/pikalog-backup.sql"
```

See Cloudflare's [D1 import and export guide](https://developers.cloudflare.com/d1/best-practices/import-export-data/) for options and limitations. Keep backups current and test restoration separately; Pikalog does not create or retain backups for you.

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

The local Worker uses a local D1 database. Run `npm test` for the domain tests and `npm run build` for type-checking and a production build. Passkeys work over `localhost` without HTTPS during local development; on a deployed hostname, HTTPS is required.

Catalog data is validated against the bundled JSON schemas and manifest checksums with `npm run catalog:validate`. The Worker starts with the bundled catalog and checks the configured public catalog source daily; manual sync is available from the Configuration page.

## Privacy and intended use

The Worker is the only app component that accesses D1. Catalog sync downloads public catalog files; it does not send inventory data upstream. Do not enter glucose, insulin, dose, or other health data. Pikalog is not a medical device and does not provide medical advice. Use supplies according to the manufacturer's instructions for use.

The optional **Report catalog gap** action opens a prefilled GitHub issue with manufacturer, product name, and GTIN or unrecognized barcode text. It excludes receipt dates and inventory history. Review unrecognized barcode text for lot, serial, or expiry details before submitting.
