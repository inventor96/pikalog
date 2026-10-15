import { describe, expect, it } from 'vitest'
import app from './index'

type FakeProduct = {
	id: number
	category_id: number
	manufacturer: string
	name: string
	gtin: string | null
	contains_qty: number | null
}

type FakePackage = {
	id: number
	product_id: number
	lot: string | null
	serial: string | null
	expiry: string | null
	raw_barcode: string | null
}

type FakeEvent = {
	id: number
	package_id: number
	type: string
	qty: number
	occurred_on: string
	unit_serial?: string | null
	unit_expiry?: string | null
	end_reason?: string | null
}

function createDatabase() {
	let attempts = 0
	let windowStartedAt = 0
	let lockLevel = 0
	let lockedUntil = 0
	let nextProductId = 1
	let nextPackageId = 1
	const categories = [
		{ id: 1, key: 'cgm_sensor', name: 'CGM sensor', overlap_allowed: 0 },
	]
	const products: FakeProduct[] = []
	const packages: FakePackage[] = []
	const events: FakeEvent[] = []
	const sessions = new Map<string, { last_seen_at: number; expires_at: number }>()
	return {
		sessions,
		products,
		packages,
		events,
		prepare(query: string) {
			let values: unknown[] = []
			const statement = {
				query,
				bind(...parameters: unknown[]) {
					values = parameters
					return statement
				},
				getValues() {
					return values
				},
				async run() {
					if (query.includes('DELETE FROM auth_login_attempts WHERE client_key')) {
						attempts = 0
						lockLevel = 0
						lockedUntil = 0
					}
					if (query.includes('UPDATE auth_login_attempts') && query.includes('attempts = 0')) {
						attempts = 0
						windowStartedAt = Number(values[0])
						lockedUntil = 0
					}
					if (query.includes('UPDATE auth_login_attempts') && query.includes('lock_level = lock_level + 1')) {
						lockLevel += 1
						lockedUntil = Number(values[0])
					}
					if (query.includes('INSERT INTO auth_sessions')) {
						sessions.set(String(values[0]), {
							last_seen_at: Number(values[2]),
							expires_at: Number(values[3]),
						})
					}
					if (query.includes('UPDATE auth_sessions SET last_seen_at')) {
						const session = sessions.get(String(values[1]))
						if (session) session.last_seen_at = Number(values[0])
					}
					if (query.includes('DELETE FROM auth_sessions WHERE token_hash')) {
						sessions.delete(String(values[0]))
					}
					if (query.includes('DELETE FROM auth_sessions WHERE expires_at')) {
						for (const [hash, session] of sessions) {
							if (session.expires_at <= Number(values[0]) || session.last_seen_at <= Number(values[1])) sessions.delete(hash)
						}
					}
					return { success: true }
				},
				async first<T>() {
					if (query.includes('FROM events AS started') && query.includes('active_package')) {
						const product = products.find((item) => item.id === Number(values[0]))
						const active = [...events].reverse().find((event) => {
							const pkg = packages.find((item) => item.id === event.package_id)
							const activeProduct = products.find((item) => item.id === pkg?.product_id)
							return event.type === 'unit_started'
								&& activeProduct?.category_id === product?.category_id
								&& !events.some((ended) => ended.package_id === event.package_id
									&& ended.type === 'unit_ended' && ended.id > event.id)
						})
						return active ? {
							package_id: active.package_id,
							unit_serial: active.unit_serial ?? null,
							unit_expiry: active.unit_expiry ?? null,
						} as T : null
					}
					if (query.includes('FROM packages') && query.includes('previous_units_remaining')) {
						const pkg = packages.find((item) => item.id === Number(values[0]))
						const product = products.find((item) => item.id === pkg?.product_id)
						if (!pkg || !product) return null
						const previous = packages
							.filter((item) => item.product_id === pkg.product_id
								&& events.some((event) => event.package_id === item.id && event.type === 'opened'))
							.sort((first, second) => {
								const firstOpened = Math.max(...events.filter((event) => event.package_id === first.id && event.type === 'opened').map((event) => event.id))
								const secondOpened = Math.max(...events.filter((event) => event.package_id === second.id && event.type === 'opened').map((event) => event.id))
								return secondOpened - firstOpened
							})[0]
						const previousProduct = products.find((item) => item.id === previous?.product_id)
						const previousUnitsRemaining = previous && previousProduct
							? (previousProduct.contains_qty ?? 1) - events.filter((event) => event.package_id === previous.id && event.type === 'unit_started').length
							: 0
						return {
							id: pkg.id,
							product_id: pkg.product_id,
							serial: pkg.serial,
							expiry: pkg.expiry,
							contains_qty: product.contains_qty,
							overlap_allowed: 0,
							previous_units_remaining: previousUnitsRemaining,
							is_received: events.some((event) => event.package_id === pkg.id && event.type === 'received') ? 1 : 0,
							is_open: events.some((event) => event.package_id === pkg.id && event.type === 'opened') ? 1 : 0,
						} as T
					}
					if (query.includes('SELECT id FROM categories')) {
						return (categories.find((category) => category.id === Number(values[0])) ?? null) as T | null
					}
					if (query.includes('INSERT INTO products')) {
						const product: FakeProduct = {
							id: nextProductId++,
							category_id: Number(values[0]),
							manufacturer: String(values[1]),
							name: String(values[2]),
							gtin: values[3] === null ? null : String(values[3]),
							contains_qty: values[4] === null ? null : Number(values[4]),
						}
						products.push(product)
						return product as T
					}
					if (query.includes('SELECT id FROM products')) {
						if (query.includes('WHERE gtin')) {
							return (products.find((product) => product.gtin === String(values[0])) ?? null) as T | null
						}
						return (products.find((product) => product.id === Number(values[0])) ?? null) as T | null
					}
					if (query.includes('SELECT lock_level, locked_until')) {
						return (lockedUntil ? { lock_level: lockLevel, locked_until: lockedUntil } : null) as T | null
					}
					if (query.includes('SELECT last_seen_at, expires_at')) {
						return (sessions.get(String(values[0])) ?? null) as T | null
					}
					if (query.includes('INSERT INTO auth_login_attempts')) {
						const now = Number(values[1])
						const windowCutoff = Number(values[2])
						if (windowStartedAt <= windowCutoff) {
							windowStartedAt = now
							attempts = 1
						} else {
							attempts += 1
						}
						return { window_started_at: windowStartedAt, attempts } as T
					}
					return null
				},
				async all<T>() {
					if (query.includes('FROM categories')) return { results: categories as T[] }
					if (query.includes('FROM products')) {
						return {
							results: products.map((product) => ({
								...product,
								category_name: categories.find((category) => category.id === product.category_id)?.name,
							})) as T[],
						}
					}
					if (query.includes('FROM packages')) {
						return {
							results: packages.flatMap((pkg) => {
								const product = products.find((item) => item.id === pkg.product_id)
								const received = events.find((event) => event.package_id === pkg.id && event.type === 'received')
								if (!product || !received) return []
								return [{
									...pkg,
									manufacturer: product.manufacturer,
									product_name: product.name,
									gtin: product.gtin,
									contains_qty: product.contains_qty,
									category_name: categories.find((category) => category.id === product.category_id)?.name,
									received_on: received.occurred_on,
									is_open: events.some((event) => event.package_id === pkg.id && event.type === 'opened') ? 1 : 0,
								}]
							}) as T[],
						}
					}
					return { results: [] as T[] }
				},
			}
			return statement
		},
		async batch(statements: D1PreparedStatement[]) {
			const prepared = statements as unknown as Array<{ query: string; getValues(): unknown[] }>
			for (const statement of prepared) {
				const values = statement.getValues()
				if (statement.query.includes('INSERT INTO packages')) {
					packages.push({
						id: nextPackageId++,
						product_id: Number(values[0]),
						lot: values[1] === null ? null : String(values[1]),
						serial: values[2] === null ? null : String(values[2]),
						expiry: values[3] === null ? null : String(values[3]),
						raw_barcode: values[4] === null ? null : String(values[4]),
					})
				} else if (statement.query.includes('INSERT INTO events')) {
					if (statement.query.includes("VALUES (last_insert_rowid(), 'received'")) {
					const pkg = packages.at(-1)
					if (pkg) events.push({
						id: events.length + 1,
						package_id: pkg.id,
						type: 'received',
						qty: 1,
						occurred_on: String(values[0]),
					})
					} else {
						events.push({
							id: events.length + 1,
							package_id: Number(values[0]),
							type: String(values[1]),
							qty: Number(values[2]),
							occurred_on: String(values[3]),
							unit_serial: values[4] === null ? null : String(values[4]),
							unit_expiry: values[5] === null ? null : String(values[5]),
							end_reason: values[6] === null ? null : String(values[6]),
						})
					}
				}
			}
			return statements.map(() => ({ success: true, results: [], meta: {} }))
		},
	} as unknown as D1Database & {
		sessions: Map<string, { last_seen_at: number; expires_at: number }>
		products: FakeProduct[]
		packages: FakePackage[]
		events: FakeEvent[]
	}
}

function createEnv(options: { password?: string } = {}): Env & {
	DB: D1Database & {
		sessions: Map<string, { last_seen_at: number; expires_at: number }>
		products: FakeProduct[]
		packages: FakePackage[]
		events: FakeEvent[]
	}
} {
	return {
		DB: createDatabase(),
		PIKALOG_PASSWORD: options.password,
	}
}

function loginRequest(password: string, origin = 'http://localhost'): RequestInit {
	return {
		method: 'POST',
		headers: {
			Origin: origin,
			'Content-Type': 'application/json',
			'CF-Connecting-IP': '192.0.2.10',
		},
		body: JSON.stringify({ password }),
	}
}

async function authenticatedCookie(env: Env): Promise<string> {
	const login = await app.request('/api/auth/login', loginRequest('household passphrase'), env)
	return (login.headers.get('set-cookie') ?? '').split(';', 1)[0]!
}

describe('Worker authentication routes', () => {
	it('keeps health and session discovery public while failing closed when unconfigured', async () => {
		const env = createEnv()
		const health = await app.request('/api/health', {}, env)
		const session = await app.request('/api/auth/session', {}, env)
		const inventory = await app.request('/api/categories', {}, env)

		expect(health.status).toBe(200)
		expect(await session.json()).toEqual({ configured: false, authenticated: false })
		expect(inventory.status).toBe(503)
	})

	it('requires a valid session for inventory routes', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const response = await app.request('/api/overview', {}, env)

		expect(response.status).toBe(401)
	})

	it('rejects cross-origin login requests', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const response = await app.request('/api/auth/login', loginRequest('household passphrase', 'https://attacker.example'), env)

		expect(response.status).toBe(403)
	})

	it('sets a strict HTTP-only session cookie after a valid login', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const login = await app.request('/api/auth/login', loginRequest('household passphrase'), env)
		const setCookie = login.headers.get('set-cookie') ?? ''
		const cookie = setCookie.split(';', 1)[0]
		const session = await app.request('/api/auth/session', { headers: { Cookie: cookie } }, env)

		expect(login.status).toBe(200)
		expect(setCookie).toContain('HttpOnly')
		expect(setCookie).toContain('SameSite=Strict')
		expect(await session.json()).toEqual({ configured: true, authenticated: true })
		expect(env.DB.sessions.size).toBe(1)

		const logout = await app.request('/api/auth/logout', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie },
		}, env)
		const revokedSession = await app.request('/api/auth/session', { headers: { Cookie: cookie } }, env)
		expect(logout.status).toBe(200)
		expect(await revokedSession.json()).toEqual({ configured: true, authenticated: false })
		expect(env.DB.sessions.size).toBe(0)
	})

	it('applies a progressive cooldown after repeated incorrect passwords', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const responses: number[] = []
		for (let attempt = 0; attempt < 9; attempt += 1) {
			const response = await app.request('/api/auth/login', loginRequest('wrong password'), env)
			responses.push(response.status)
		}

		expect(responses.slice(0, 8)).toEqual(Array.from({ length: 8 }, () => 401))
		expect(responses[8]).toBe(429)
		const blocked = await app.request('/api/auth/login', loginRequest('household passphrase'), env)
		expect(blocked.status).toBe(429)
		expect(blocked.headers.get('retry-after')).toBeTruthy()
	})

	it('sets API security headers and disables response caching', async () => {
		const response = await app.request('/api/health', {}, createEnv())

		expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
		expect(response.headers.get('x-content-type-options')).toBe('nosniff')
		expect(response.headers.get('x-frame-options')).toBe('DENY')
		expect(response.headers.get('cache-control')).toBe('no-store')
	})

	it('creates a custom product and records a receipt in the inventory ledger', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env)
		const productResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ categoryId: 1, manufacturer: 'Acme', name: 'Sensor pack', gtin: '09506000134352', containsQty: 2 }),
		}, env)
		const productData = await productResponse.json() as { product: { id: number } }

		const receiptResponse = await app.request('/api/receipts', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				productId: productData.product.id,
				lot: 'LOT-7',
				serial: 'SERIAL-9',
				expiry: '2028-12-31',
				rawBarcode: ']d201095060001343521728123110LOT-7',
				receivedOn: '2026-10-14',
			}),
		}, env)
		const openResponse = await app.request(`/api/packages/${env.DB.packages[0]!.id}/open`, {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ occurredOn: '2026-10-15' }),
		}, env)
		const inventoryResponse = await app.request('/api/inventory', { headers: { Cookie: cookie } }, env)
		const inventory = await inventoryResponse.json() as { packages: Array<Record<string, unknown>> }

		expect(productResponse.status).toBe(201)
		expect(receiptResponse.status).toBe(201)
		expect(openResponse.status).toBe(201)
		expect(env.DB.packages).toHaveLength(1)
		expect(env.DB.events).toMatchObject([
			{ type: 'received', occurred_on: '2026-10-14' },
			{ type: 'opened', occurred_on: '2026-10-15' },
			{ type: 'unit_started', occurred_on: '2026-10-15', qty: 1 },
		])
		expect(inventory.packages).toMatchObject([{
			manufacturer: 'Acme',
			product_name: 'Sensor pack',
			contains_qty: 2,
			lot: 'LOT-7',
			serial: 'SERIAL-9',
			expiry: '2028-12-31',
			received_on: '2026-10-14',
		}])

		const secondReceiptResponse = await app.request('/api/receipts', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ productId: productData.product.id, lot: 'LOT-8', receivedOn: '2026-10-16' }),
		}, env)
		const secondPackageId = env.DB.packages.at(-1)!.id
		const secondOpenResponse = await app.request(`/api/packages/${secondPackageId}/open`, {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ occurredOn: '2026-10-17' }),
		}, env)

		expect(secondReceiptResponse.status).toBe(201)
		expect(secondOpenResponse.status).toBe(201)
		expect(env.DB.events).toMatchObject([
			{ type: 'received', occurred_on: '2026-10-14' },
			{ type: 'opened', occurred_on: '2026-10-15' },
			{ type: 'unit_started', occurred_on: '2026-10-15', qty: 1 },
			{ type: 'received', occurred_on: '2026-10-16' },
			{ type: 'opened', occurred_on: '2026-10-17' },
			{ type: 'unit_ended', occurred_on: '2026-10-17', end_reason: 'planned' },
			{ type: 'unit_started', occurred_on: '2026-10-17', qty: 1 },
		])

		const duplicateProductResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ categoryId: 1, manufacturer: 'Another', name: 'Duplicate', gtin: '09506000134352', containsQty: 5 }),
		}, env)
		const invalidReceiptResponse = await app.request('/api/receipts', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ productId: productData.product.id, expiry: '2026-02-30', receivedOn: '2026-10-14' }),
		}, env)

		expect(duplicateProductResponse.status).toBe(409)
		expect(invalidReceiptResponse.status).toBe(400)
		expect(env.DB.packages).toHaveLength(2)
		expect(env.DB.events).toHaveLength(7)
	})
})