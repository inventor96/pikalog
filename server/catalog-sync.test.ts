import { describe, expect, it } from 'vitest'
import { syncCatalog } from './catalog-sync'

const categoryFile = JSON.stringify([{ key: 'cgm_sensor', name: 'CGM sensor', overlapAllowed: false }])
const productFile = JSON.stringify([{
	key: 'acme.sensor',
	categoryKey: 'cgm_sensor',
	manufacturer: 'Acme',
	name: 'Sensor',
	gtin: '00036000291452',
	containsProductKey: null,
	containsQty: 1,
	ratedWearDays: 10,
	minSamples: 3,
	expiryRule: 'finish_by',
	expiryStrictness: 'hard',
	sourceUrl: 'https://example.com/instructions',
	verified: false,
}])
const barcodeFile = '[]'
const fileContents = new Map([
	['categories.json', categoryFile],
	['products.json', productFile],
	['barcode_formats.json', barcodeFile],
])

async function hash(content: string): Promise<string> {
	const bytes = new TextEncoder().encode(content)
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function fakeDatabase(state: { version: string | null; last_status: string | null; last_synced_at: string | null } | null = null) {
	const batches: string[][] = []
	const runQueries: string[] = []
	const db = {
		batches,
		runQueries,
		prepare(query: string) {
			let values: unknown[] = []
			const statement = {
				query,
				bind(...parameters: unknown[]) {
					values = parameters
					return statement
				},
				async first<T>() {
					return query.includes('FROM catalog_sync_state') ? state as T | null : null
				},
				async run() {
					runQueries.push(query)
					return { success: true }
				},
				getValues() {
					return values
				},
			}
			return statement
		},
		async batch(statements: Array<{ query: string }>) {
			batches.push(statements.map((statement) => statement.query))
			return statements.map(() => ({ success: true, results: [], meta: {} }))
		},
	} as unknown as D1Database & { batches: string[][]; runQueries: string[] }
	return db
}

	async function remoteCatalog(options: { corruptProducts?: boolean; schemaVersion?: number; version?: string } = {}) {
	const manifest = {
		version: options.version ?? '2026.10.14.2',
		schemaVersion: options.schemaVersion ?? 1,
		files: Object.fromEntries(await Promise.all([...fileContents.entries()].map(async ([filename, content]) => [filename, await hash(content)]))),
	}
	const requests: string[] = []
	const fetcher = async (input: RequestInfo | URL) => {
		const url = String(input)
		requests.push(url)
		const filename = url.split('/').at(-1)!
		const content = filename === 'manifest.json'
			? JSON.stringify(manifest)
			: filename === 'products.json' && options.corruptProducts
				? '[]'
				: fileContents.get(filename) ?? ''
		return new Response(content, { status: 200, headers: { 'Content-Type': 'application/json' } })
	}
	return { fetcher: fetcher as typeof fetch, requests }
}

describe('syncCatalog', () => {
	it('validates and applies a catalog bundle after seeding defaults', async () => {
		const db = fakeDatabase()
		const remote = await remoteCatalog()
		const result = await syncCatalog(db, 'https://catalog.example/v1', remote.fetcher)

		expect(result).toMatchObject({ status: 'success', version: '2026.10.14.2' })
		expect(db.batches).toHaveLength(2)
		expect(db.batches[0]).toEqual(expect.arrayContaining([
			expect.stringContaining('INSERT INTO categories'),
			expect.stringContaining("'seeded'"),
		]))
		expect(db.batches[1]).toEqual(expect.arrayContaining([
			expect.stringContaining('INSERT INTO categories'),
			expect.stringContaining('INSERT INTO products'),
			expect.stringContaining('catalog_sync_state'),
		]))
		expect(db.batches[1]?.some((query) => query.includes("origin = 'custom'"))).toBe(false)
		expect(remote.requests).toHaveLength(4)
	})

	it('keeps bundled catalog data when the upstream is unavailable on first sync', async () => {
		const db = fakeDatabase()
		const fetcher = async () => { throw new Error('upstream unavailable') }

		await expect(syncCatalog(db, 'https://catalog.example/v1', fetcher as typeof fetch))
			.rejects.toThrow('upstream unavailable')
		expect(db.batches).toHaveLength(1)
		expect(db.batches[0]).toEqual(expect.arrayContaining([
			expect.stringContaining('INSERT INTO categories'),
			expect.stringContaining("'seeded'"),
		]))
		expect(db.runQueries[0]).toContain("last_status = 'error'")
	})

	it('skips data downloads when the current successful version matches', async () => {
		const db = fakeDatabase({
			version: '2026.10.14.2',
			last_status: 'success',
			last_synced_at: '2026-10-14T00:00:00.000Z',
		})
		const remote = await remoteCatalog()
		const result = await syncCatalog(db, 'https://catalog.example/v1', remote.fetcher)

		expect(result).toEqual({
			status: 'unchanged',
			version: '2026.10.14.2',
			lastSyncedAt: '2026-10-14T00:00:00.000Z',
		})
		expect(remote.requests).toHaveLength(1)
		expect(db.batches).toHaveLength(0)
	})

	it('accepts a date-only version in the remote manifest', async () => {
		const db = fakeDatabase({ version: '2026.10.14', last_status: 'success', last_synced_at: 'old' })
		const remote = await remoteCatalog({ version: '2026.10.15' })
		const result = await syncCatalog(db, 'https://catalog.example/v1', remote.fetcher)

		expect(result).toMatchObject({ status: 'success', version: '2026.10.15' })
	})

	it('does not mutate catalog data when a file checksum is invalid', async () => {
		const db = fakeDatabase({ version: '2026.10.14.1', last_status: 'success', last_synced_at: 'old' })
		const remote = await remoteCatalog({ corruptProducts: true })

		await expect(syncCatalog(db, 'https://catalog.example/v1', remote.fetcher))
			.rejects.toThrow('catalog_checksum_mismatch_products.json')
		expect(db.batches).toHaveLength(0)
		expect(db.runQueries[0]).toContain("last_status = 'error'")
	})

	it('rejects newer schema versions without downloading catalog files', async () => {
		const db = fakeDatabase({ version: '2026.10.14.1', last_status: 'success', last_synced_at: 'old' })
		const remote = await remoteCatalog({ schemaVersion: 2 })

		await expect(syncCatalog(db, 'https://catalog.example/v1', remote.fetcher))
			.rejects.toThrow('catalog_schema_unsupported')
		expect(remote.requests).toHaveLength(1)
		expect(db.batches).toHaveLength(0)
	})
})