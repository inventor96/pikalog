import { validateCatalogBundle, type CatalogManifest } from '../src/domain/catalog'
import bundledBarcodeFormats from '../catalog/barcode_formats.json'
import bundledCategories from '../catalog/categories.json'
import bundledManifest from '../catalog/manifest.json'
import bundledProducts from '../catalog/products.json'

const catalogFiles = ['categories.json', 'products.json', 'barcode_formats.json'] as const
const defaultCatalogBaseUrl = 'https://raw.githubusercontent.com/inventor96/pikalog/main/catalog'

type SyncState = {
	version: string | null
	last_status: string | null
	last_synced_at: string | null
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function fetchJson(fetcher: typeof fetch, url: string): Promise<{ data: unknown; bytes: ArrayBuffer }> {
	const response = await fetcher(url, { headers: { Accept: 'application/json' } })
	if (!response.ok) throw new Error(`catalog_fetch_failed_${response.status}`)
	const bytes = await response.arrayBuffer()
	try {
		return { data: JSON.parse(new TextDecoder().decode(bytes)), bytes }
	} catch {
		throw new Error('catalog_invalid_json')
	}
}

function validateManifestShape(value: unknown): CatalogManifest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid_catalog_manifest')
	const manifest = value as Record<string, unknown>
	const files = manifest.files
	if (typeof manifest.version !== 'string'
		|| !/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(manifest.version)
		|| !Number.isSafeInteger(manifest.schemaVersion)
		|| typeof files !== 'object' || files === null || Array.isArray(files)) {
		throw new Error('invalid_catalog_manifest')
	}
	for (const filename of catalogFiles) {
		const hash = (files as Record<string, unknown>)[filename]
		if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid_catalog_manifest')
	}
	return manifest as unknown as CatalogManifest
}

function bindProductStatements(
	db: D1Database,
	product: ReturnType<typeof validateCatalogBundle>['products'][number],
	catalogVersion: number,
	): D1PreparedStatement[] {
	return [db.prepare(`
		UPDATE products SET
			category_id = (SELECT id FROM categories WHERE key = ?),
			manufacturer = ?, name = ?, gtin = ?,
			contains_product_id = (SELECT id FROM products WHERE catalog_key = ?),
			contains_qty = ?, rated_wear_days = ?, min_samples = ?,
			expiry_rule = ?, expiry_strictness = ?, origin = 'catalog',
			catalog_key = ?, catalog_version = ?
		WHERE catalog_key = ? OR (origin = 'custom' AND gtin = ?
			AND NOT EXISTS (SELECT 1 FROM products AS existing WHERE existing.catalog_key = ?))
	`).bind(
		product.categoryKey,
		product.manufacturer,
		product.name,
		product.gtin,
		product.containsProductKey,
		product.containsQty,
		product.ratedWearDays,
		product.minSamples,
		product.expiryRule,
		product.expiryStrictness,
		product.key,
		catalogVersion,
		product.key,
		product.gtin,
		product.key,
	), db.prepare(`
		INSERT INTO products (
			category_id, manufacturer, name, gtin, contains_product_id, contains_qty,
			rated_wear_days, min_samples, expiry_rule, expiry_strictness, origin,
			catalog_key, catalog_version
		)
		SELECT
			(SELECT id FROM categories WHERE key = ?), ?, ?, ?,
			(SELECT id FROM products WHERE catalog_key = ?), ?, ?, ?, ?, ?, 'catalog', ?, ?
		WHERE NOT EXISTS (SELECT 1 FROM products WHERE catalog_key = ? OR gtin = ?)
	`).bind(
		product.categoryKey,
		product.manufacturer,
		product.name,
		product.gtin,
		product.containsProductKey,
		product.containsQty,
		product.ratedWearDays,
		product.minSamples,
		product.expiryRule,
		product.expiryStrictness,
		product.key,
		catalogVersion,
		product.key,
		product.gtin,
	)]
}

function categoryStatements(
	db: D1Database,
	categories: ReturnType<typeof validateCatalogBundle>['categories'],
	catalogVersion: number,
): D1PreparedStatement[] {
	return categories.flatMap((category) => [
		db.prepare(`
			INSERT INTO category_overrides (category_id, field, value)
			SELECT id, 'name', name FROM categories
			WHERE key = ? AND origin = 'custom' AND name <> ?
			ON CONFLICT(category_id, field) DO NOTHING
		`).bind(category.key, category.name),
		db.prepare(`
			INSERT INTO category_overrides (category_id, field, value)
			SELECT id, 'overlap_allowed', CAST(overlap_allowed AS TEXT) FROM categories
			WHERE key = ? AND origin = 'custom' AND overlap_allowed <> ?
			ON CONFLICT(category_id, field) DO NOTHING
		`).bind(category.key, Number(category.overlapAllowed)),
		db.prepare(`
			INSERT INTO categories (key, name, overlap_allowed, origin, catalog_version)
			VALUES (?, ?, ?, 'catalog', ?)
			ON CONFLICT(key) DO UPDATE SET
				name = excluded.name,
				overlap_allowed = excluded.overlap_allowed,
				origin = 'catalog',
				catalog_version = excluded.catalog_version
		`).bind(category.key, category.name, Number(category.overlapAllowed), catalogVersion),
	])
}

function productStatements(
	db: D1Database,
	products: ReturnType<typeof validateCatalogBundle>['products'],
	catalogVersion: number,
): D1PreparedStatement[] {
	const orderedProducts = [...products].sort(
		(first, second) => Number(first.containsProductKey !== null) - Number(second.containsProductKey !== null),
	)
	return orderedProducts.flatMap((product) => {
		const promotion = product.gtin ? [
			...([
				{ field: 'category_id', localSql: 'category_id', officialSql: '(SELECT id FROM categories WHERE key = ?)', value: product.categoryKey },
				{ field: 'manufacturer', localSql: 'manufacturer', officialSql: '?', value: product.manufacturer },
				{ field: 'name', localSql: 'name', officialSql: '?', value: product.name },
				{ field: 'min_samples', localSql: 'min_samples', officialSql: '?', value: product.minSamples },
				{ field: 'expiry_rule', localSql: 'expiry_rule', officialSql: '?', value: product.expiryRule },
				{ field: 'expiry_strictness', localSql: 'expiry_strictness', officialSql: '?', value: product.expiryStrictness },
			] as const).map(({ field, localSql, officialSql, value }) => db.prepare(`
					INSERT INTO product_overrides (product_id, field, value)
					SELECT id, ?, CAST(${localSql} AS TEXT) FROM products
					WHERE origin = 'custom' AND gtin = ?
						AND ${localSql} <> ${officialSql}
					ON CONFLICT(product_id, field) DO NOTHING
				`).bind(field, product.gtin, value)),
		] : []
			return [...promotion, ...bindProductStatements(db, product, catalogVersion)]
	})
}

function notInClause(values: readonly string[], column: string): { sql: string; values: string[] } {
	if (!values.length) return { sql: `${column} IS NOT NULL`, values: [] }
	return { sql: `${column} NOT IN (${values.map(() => '?').join(', ')})`, values: [...values] }
}

async function seedBundledCatalog(db: D1Database): Promise<void> {
	const currentState = await db.prepare('SELECT version FROM catalog_sync_state WHERE id = 1')
		.first<{ version: string | null }>()
	if (currentState) return
	const bundle = validateCatalogBundle({
		manifest: bundledManifest,
		categories: bundledCategories,
		products: bundledProducts,
		barcodeFormats: bundledBarcodeFormats,
	})
	const catalogVersion = Number.parseInt(bundle.manifest.version.replaceAll('.', ''), 10)
	const statements = categoryStatements(db, bundle.categories, catalogVersion)
	statements.push(...productStatements(db, bundle.products, catalogVersion))
	statements.push(...bundle.barcodeFormats.map((format) => db.prepare(`
		INSERT INTO catalog_barcode_formats (catalog_key, product_id, pattern, fields_json, source_url, verified)
		VALUES (?, (SELECT id FROM products WHERE catalog_key = ?), ?, ?, ?, ?)
		ON CONFLICT(catalog_key) DO UPDATE SET
			product_id = excluded.product_id,
			pattern = excluded.pattern,
			fields_json = excluded.fields_json,
			source_url = excluded.source_url,
			verified = excluded.verified
	`).bind(format.key, format.productKey, format.pattern, JSON.stringify(format.fields), format.sourceUrl, Number(format.verified))))
	statements.push(db.prepare(`
		INSERT INTO catalog_sync_state (id, version, last_status)
		VALUES (1, ?, 'seeded')
		ON CONFLICT(id) DO NOTHING
	`).bind(bundle.manifest.version))
	await db.batch(statements)
}

async function recordFailure(db: D1Database, message: string): Promise<void> {
	await db.prepare(`
		INSERT INTO catalog_sync_state (id, last_status, last_error)
		VALUES (1, 'error', ?)
		ON CONFLICT(id) DO UPDATE SET last_status = 'error', last_error = excluded.last_error
	`).bind(message.slice(0, 500)).run()
}

export async function syncCatalog(
	db: D1Database,
	configuredBaseUrl?: string,
	fetcher: typeof fetch = fetch,
): Promise<{ status: 'success' | 'unchanged'; version: string; lastSyncedAt: string | null }> {
	try {
		await seedBundledCatalog(db)
		const baseUrl = (configuredBaseUrl || defaultCatalogBaseUrl).replace(/\/+$/, '')
		const parsedBase = new URL(baseUrl)
		if (!['https:', 'http:'].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password) {
			throw new Error('invalid_catalog_base_url')
		}
		const currentState = await db.prepare(`
			SELECT version, last_status, last_synced_at FROM catalog_sync_state WHERE id = 1
		`).first<SyncState>()
		const manifestResult = await fetchJson(fetcher, `${baseUrl}/manifest.json`)
		const manifest = validateManifestShape(manifestResult.data)
		if (Number(manifest.schemaVersion) > 1) throw new Error('catalog_schema_unsupported')
		if (currentState?.version === manifest.version && currentState.last_status === 'success') {
			return { status: 'unchanged', version: manifest.version, lastSyncedAt: currentState.last_synced_at }
		}

		const fileResults = await Promise.all(catalogFiles.map((filename) => fetchJson(fetcher, `${baseUrl}/${filename}`)))
		for (const [index, filename] of catalogFiles.entries()) {
			if (await sha256(fileResults[index]!.bytes) !== manifest.files[filename]) {
				throw new Error(`catalog_checksum_mismatch_${filename}`)
			}
		}
		const bundle = validateCatalogBundle({
			manifest,
			categories: fileResults[0]!.data,
			products: fileResults[1]!.data,
			barcodeFormats: fileResults[2]!.data,
		})
		const catalogVersion = Number.parseInt(bundle.manifest.version.replaceAll('.', ''), 10)
		const statements = categoryStatements(db, bundle.categories, catalogVersion)
		statements.push(...productStatements(db, bundle.products, catalogVersion))
		statements.push(...bundle.barcodeFormats.map((format) => db.prepare(`
			INSERT INTO catalog_barcode_formats (catalog_key, product_id, pattern, fields_json, source_url, verified)
			VALUES (?, (SELECT id FROM products WHERE catalog_key = ?), ?, ?, ?, ?)
			ON CONFLICT(catalog_key) DO UPDATE SET
				product_id = excluded.product_id,
				pattern = excluded.pattern,
				fields_json = excluded.fields_json,
				source_url = excluded.source_url,
				verified = excluded.verified
		`).bind(format.key, format.productKey, format.pattern, JSON.stringify(format.fields), format.sourceUrl, Number(format.verified))))
		const staleFormats = notInClause(bundle.barcodeFormats.map((format) => format.key), 'catalog_key')
		statements.push(db.prepare(`DELETE FROM catalog_barcode_formats WHERE ${staleFormats.sql}`).bind(...staleFormats.values))
		const syncedAt = new Date().toISOString()
		statements.push(db.prepare(`
			INSERT INTO catalog_sync_state (id, version, last_synced_at, last_status, last_error)
			VALUES (1, ?, ?, 'success', NULL)
			ON CONFLICT(id) DO UPDATE SET
				version = excluded.version,
				last_synced_at = excluded.last_synced_at,
				last_status = 'success',
				last_error = NULL
		`).bind(bundle.manifest.version, syncedAt))
		await db.batch(statements)
		return { status: 'success', version: bundle.manifest.version, lastSyncedAt: syncedAt }
	} catch (error) {
		const message = error instanceof Error ? error.message : 'catalog_sync_failed'
		try {
			await recordFailure(db, message)
		} catch {
			// Keep the original sync error if recording status also fails.
		}
		throw error
	}
}