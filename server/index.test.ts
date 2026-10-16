import { describe, expect, it } from 'vitest'
import app from './index'

type FakeProduct = {
	id: number
	category_id: number
	manufacturer: string
	name: string
	gtin: string | null
	contains_product_id: number | null
	contains_qty: number | null
	rated_wear_days: number | null
	min_samples: number
	expiry_rule: 'finish_by' | 'start_by' | 'none'
	expiry_strictness: 'hard' | 'soft'
	origin: 'catalog' | 'custom'
}

type FakePackage = {
	id: number
	product_id: number
	lot: string | null
	serial: string | null
	expiry: string | null
	raw_barcode: string | null
	implicit?: number
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
	inferred?: number
}

function createDatabase() {
	let attempts = 0
	let windowStartedAt = 0
	let lockLevel = 0
	let lockedUntil = 0
	let nextProductId = 1
	let nextPackageId = 1
	const categories = [
		{ id: 1, key: 'cgm_sensor', name: 'CGM sensor', overlap_allowed: 0, origin: 'catalog' as const },
	]
	const products: FakeProduct[] = []
	const packages: FakePackage[] = []
	const events: FakeEvent[] = []
	const settings = new Map<string, string>()
	const sessions = new Map<string, { last_seen_at: number; expires_at: number }>()
	return {
		sessions,
		settings,
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
					if (query.includes('INSERT INTO settings')) {
						settings.set('include_projected_receipts', String(values[0]))
					}
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
					if (query.includes('SELECT origin FROM categories WHERE id = ?')) {
						return (categories.find((category) => category.id === Number(values[0])) ?? null) as T | null
					}
					if (query.includes('SELECT origin FROM products WHERE id = ?')) {
						return (products.find((product) => product.id === Number(values[0])) ?? null) as T | null
					}
					if (query.includes('SELECT value FROM settings')) {
						const value = settings.get(String(values[0]))
						return value === undefined ? null : { value } as T
					}
					if ((query.includes('FROM products JOIN categories') || query.includes('FROM effective_products AS products JOIN effective_categories AS categories')) && query.includes('WHERE products.gtin = ?')) {
						const product = products.find((item) => item.gtin === String(values[0]))
						if (!product) return null
						return {
							id: product.id,
							category_id: product.category_id,
							overlap_allowed: categories.find((item) => item.id === product.category_id)?.overlap_allowed ?? 0,
						} as T
					}
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
							? (previousProduct.contains_qty ?? 1) - events.filter((event) => event.package_id === previous.id
								&& (event.type === 'unit_started' || event.type === 'discarded')).reduce((sum, event) => sum + event.qty, 0)
							: 0
						return {
							id: pkg.id,
							product_id: pkg.product_id,
							serial: pkg.serial,
							expiry: pkg.expiry,
							contains_qty: product.contains_qty,
							overlap_allowed: 0,
							previous_package_id: previous?.id ?? null,
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
							contains_product_id: values[4] === null ? null : Number(values[4]),
							contains_qty: values[5] === null ? null : Number(values[5]),
							rated_wear_days: values[6] === null ? null : Number(values[6]),
							min_samples: Number(values[7]),
							expiry_rule: values[8] as FakeProduct['expiry_rule'],
							expiry_strictness: values[9] as FakeProduct['expiry_strictness'],
							origin: 'custom',
						}
						products.push(product)
						return product as T
					}
					if (query.includes('SELECT id FROM products') || query.includes('SELECT id FROM effective_products')) {
						if (query.includes('WHERE gtin')) {
							return (products.find((product) => product.gtin === String(values[0])) ?? null) as T | null
						}
						return (products.find((product) => product.id === Number(values[0])) ?? null) as T | null
					}
					if (query.includes('SELECT id FROM packages WHERE serial = ?')) {
						return (packages.find((pkg) => pkg.serial === String(values[0]) && !pkg.implicit) ?? null) as T | null
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
					if (query.includes('FROM events') && query.includes('unit_products')) {
						return {
							results: events.flatMap((event) => {
								const pkg = packages.find((item) => item.id === event.package_id)
								const product = products.find((item) => item.id === pkg?.product_id)
								const unitProduct = products.find((item) => item.id === product?.contains_product_id)
								const category = categories.find((item) => item.id === product?.category_id)
								if (!pkg || !product || !category) return []
								return [{
									id: event.id,
									packageId: event.package_id,
									type: event.type,
									qty: event.qty,
									occurredOn: event.occurred_on,
									unitSerial: event.unit_serial ?? null,
									unitExpiry: event.unit_expiry ?? null,
									inferred: event.inferred ?? 0,
									endReason: event.end_reason ?? null,
									productId: unitProduct?.id ?? product.id,
									productName: unitProduct?.name ?? product.name,
									categoryId: category.id,
									categoryName: category.name,
									overlapAllowed: Boolean(category.overlap_allowed),
								}]
							}) as T[],
						}
					}
					if (query.includes('FROM categories') || query.includes('FROM effective_categories')) return { results: categories as T[] }
					if (query.includes('unit_serial FROM events')) {
						return { results: events.filter((event) => event.unit_serial).map((event) => ({ unit_serial: event.unit_serial! })) as T[] }
					}
					if (query.includes('products.contains_product_id = ?')) {
						return {
							results: packages.flatMap((pkg) => {
								const product = products.find((item) => item.id === pkg.product_id)
								const received = events.find((event) => event.package_id === pkg.id && event.type === 'received')
								if (!product || product.contains_product_id !== Number(values[0]) || !received) return []
								const consumed = events.filter((event) => event.package_id === pkg.id
									&& (event.type === 'unit_started' || event.type === 'discarded')).reduce((sum, event) => sum + event.qty, 0)
								return [{
									id: pkg.id,
									containsProductId: product.contains_product_id,
									lot: pkg.lot ?? undefined,
									expiry: pkg.expiry ?? undefined,
									receivedOn: received.occurred_on,
									unitsRemaining: Math.max(0, (product.contains_qty ?? 1) - consumed),
									isOpen: events.some((event) => event.package_id === pkg.id && event.type === 'opened'),
								}] as T[]
							}),
						}
					}
					if (query.includes('FROM products') || query.includes('FROM effective_products')) {
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
								contains_product_id: product.contains_product_id,
								units_received: product.contains_qty ?? 1,
									units_remaining: Math.max(0, (product.contains_qty ?? 1)
										+ events.filter((event) => event.package_id === pkg.id && event.type === 'adjusted').reduce((sum, event) => sum + event.qty, 0)
										- events.filter((event) => event.package_id === pkg.id && (event.type === 'unit_started' || event.type === 'discarded')).reduce((sum, event) => sum + event.qty, 0)),
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
						implicit: statement.query.includes('VALUES (?, ?, ?, ?, ?, 1)') ? 1 : 0,
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
					} else if (statement.query.includes("VALUES (last_insert_rowid(), 'unit_started'")) {
						const pkg = packages.at(-1)
						if (pkg) events.push({
							id: events.length + 1,
							package_id: pkg.id,
							type: 'unit_started',
							qty: 1,
							occurred_on: String(values[0]),
							unit_serial: values[1] === null ? null : String(values[1]),
							unit_expiry: values[2] === null ? null : String(values[2]),
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
							inferred: Number(values[6] ?? 0),
							end_reason: values[7] === null ? null : String(values[7]),
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

	it('does not allow deleting official categories or products', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env)
		env.DB.products.push({
			id: 7,
			category_id: 1,
			manufacturer: 'Acme',
			name: 'Sensor',
			gtin: null,
			contains_product_id: null,
			contains_qty: 1,
			rated_wear_days: null,
			min_samples: 3,
			expiry_rule: 'finish_by',
			expiry_strictness: 'hard',
			origin: 'catalog',
		})
		const headers = { Origin: 'http://localhost', Cookie: cookie }

		const categoryResponse = await app.request('/api/categories/1', { method: 'DELETE', headers }, env)
		const productResponse = await app.request('/api/products/7', { method: 'DELETE', headers }, env)

		expect(categoryResponse.status).toBe(409)
		expect(productResponse.status).toBe(409)
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

	it('projects linked-product receipts and persists the projection toggle', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env)
		const unitResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				categoryId: 1,
				manufacturer: 'Acme',
				name: 'Sensor',
				gtin: '00036000291452',
				ratedWearDays: 10,
			}),
		}, env)
		const unit = await unitResponse.json() as { product: { id: number } }
		const packResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ categoryId: 1, manufacturer: 'Acme', name: 'Sensor box', containsProductId: unit.product.id, containsQty: 2 }),
		}, env)
		const pack = await packResponse.json() as { product: { id: number } }
		for (const [receivedOn, expiry] of [
			['2026-07-01', '2027-01-01'],
			['2026-08-01', '2026-11-09'],
			['2026-09-01', '2026-12-10'],
		]) {
			const receiptResponse = await app.request('/api/receipts', {
				method: 'POST',
				headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
				body: JSON.stringify({ productId: pack.product.id, receivedOn, expiry }),
			}, env)
			expect(receiptResponse.status).toBe(201)
		}

		const settingsResponse = await app.request('/api/settings', { headers: { Cookie: cookie } }, env)
		const settings = await settingsResponse.json() as { includeProjectedReceipts: boolean }
		const forecastResponse = await app.request('/api/forecast?today=2026-09-15', { headers: { Cookie: cookie } }, env)
		const forecast = await forecastResponse.json() as {
			includeProjectedReceipts: boolean
			categories: Array<{
				projectedReceipts: Array<Record<string, unknown>>
				surplusPerQuarter: number | null
			}>
		}

		expect(settings.includeProjectedReceipts).toBe(true)
		expect(forecast.includeProjectedReceipts).toBe(true)
		expect(forecast.categories[0]?.projectedReceipts[0]).toMatchObject({
			productName: 'Sensor',
			arrivalOn: '2026-10-02',
			expiry: '2027-01-10',
			quantity: 2,
		})
		expect(forecast.categories[0]?.surplusPerQuarter).toBeCloseTo(-3.19, 2)

		const disableResponse = await app.request('/api/settings', {
			method: 'PUT',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ includeProjectedReceipts: false }),
		}, env)
		const disabledForecastResponse = await app.request('/api/forecast?today=2026-09-15', { headers: { Cookie: cookie } }, env)
		const disabledForecast = await disabledForecastResponse.json() as {
			includeProjectedReceipts: boolean
			categories: Array<{
				projectedReceipts: Array<Record<string, unknown>>
				surplusPerQuarter: number | null
			}>
		}
		const invalidSettingResponse = await app.request('/api/settings', {
			method: 'PUT',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ includeProjectedReceipts: 'false' }),
		}, env)

		expect(disableResponse.status).toBe(200)
		expect(disabledForecast.includeProjectedReceipts).toBe(false)
		expect(disabledForecast.categories[0]?.projectedReceipts).toEqual([])
		expect(disabledForecast.categories[0]?.surplusPerQuarter).toBeNull()
		expect(invalidSettingResponse.status).toBe(400)
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
		const duplicateReceiptResponse = await app.request('/api/receipts', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ productId: productData.product.id, serial: 'SERIAL-9', receivedOn: '2026-10-14' }),
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
		expect(duplicateReceiptResponse.status).toBe(409)
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
			units_remaining: 1,
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
		const activityResponse = await app.request('/api/activity', { headers: { Cookie: cookie } }, env)
		const activity = await activityResponse.json() as {
			events: Array<{ type: string; occurredOn: string }>
			durationStats: Array<{ productName: string; sampleCount: number; meanDays: number }>
		}

		expect(secondReceiptResponse.status).toBe(201)
		expect(secondOpenResponse.status).toBe(201)
		expect(activityResponse.status).toBe(200)
		expect(activity.events[0]).toEqual({
			id: 7,
			packageId: 2,
			type: 'unit_started',
			qty: 1,
			occurredOn: '2026-10-17',
			unitSerial: null,
			unitExpiry: null,
			inferred: 0,
			endReason: null,
			productId: 1,
			productName: 'Sensor pack',
			categoryId: 1,
			categoryName: 'CGM sensor',
			overlapAllowed: false,
		})
		expect(activity.durationStats).toMatchObject([{
			productName: 'Sensor pack',
			sampleCount: 1,
			meanDays: 2,
		}])
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

	it('matches a unit scan to its linked pack and consumes one remaining unit', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env)
		const unitResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				categoryId: 1,
				manufacturer: 'Acme',
				name: 'Sensor',
				gtin: '00036000291452',
				containsQty: 1,
				ratedWearDays: 10,
				minSamples: 5,
				expiryRule: 'start_by',
				expiryStrictness: 'soft',
			}),
		}, env)
		const unitData = await unitResponse.json() as { product: {
			id: number
			rated_wear_days: number
			min_samples: number
			expiry_rule: string
			expiry_strictness: string
		} }
		expect(unitData.product).toMatchObject({
			rated_wear_days: 10,
			min_samples: 5,
			expiry_rule: 'start_by',
			expiry_strictness: 'soft',
		})
		const productListResponse = await app.request('/api/products', { headers: { Cookie: cookie } }, env)
		const productList = await productListResponse.json() as { products: Array<Record<string, unknown>> }
		expect(productList.products[0]).toMatchObject(unitData.product)
		const invalidSettingsResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ categoryId: 1, manufacturer: 'Acme', name: 'Invalid sensor', ratedWearDays: 0 }),
		}, env)
		expect(invalidSettingsResponse.status).toBe(400)
		const packResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				categoryId: 1,
				manufacturer: 'Acme',
				name: 'Sensor pack',
				gtin: '09506000134352',
				containsProductId: unitData.product.id,
				containsQty: 2,
			}),
		}, env)
		const packData = await packResponse.json() as { product: { id: number } }
		await app.request('/api/receipts', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ productId: packData.product.id, lot: 'LOT-U', expiry: '2028-12-31', receivedOn: '2026-10-14' }),
		}, env)

		const startResponse = await app.request('/api/unit-scans', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				gtin: '00036000291452',
				lot: 'LOT-U',
				expiry: '2028-12-31',
				serial: 'UNIT-4',
				rawBarcode: '01000360002914521728123121UNIT-4',
				occurredOn: '2026-10-15',
			}),
		}, env)
		const duplicateStartResponse = await app.request('/api/unit-scans', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				gtin: '00036000291452',
				lot: 'LOT-U',
				expiry: '2028-12-31',
				serial: 'UNIT-4',
				occurredOn: '2026-10-15',
			}),
		}, env)
		const startData = await startResponse.json() as { started: boolean; opened: boolean; implicit: boolean; matchedBy: string }
		const inventoryResponse = await app.request('/api/inventory', { headers: { Cookie: cookie } }, env)
		const inventory = await inventoryResponse.json() as { packages: Array<Record<string, unknown>> }
		const forecastResponse = await app.request('/api/forecast?today=2026-10-15', { headers: { Cookie: cookie } }, env)
		const forecast = await forecastResponse.json() as {
			categories: Array<{
				categoryName: string
				stockUnits: number
				activeUnits: number
				runOutDate: string
				nextPickProduct: string | null
			}>
		}

		expect(unitResponse.status).toBe(201)
		expect(packResponse.status).toBe(201)
		expect(startResponse.status).toBe(201)
		expect(duplicateStartResponse.status).toBe(409)
		expect(startData).toMatchObject({ started: true, opened: true, implicit: false, matchedBy: 'lot_expiry' })
		expect(env.DB.events.filter((event) => event.type === 'opened')).toHaveLength(1)
		expect(env.DB.events.filter((event) => event.type === 'unit_started'))
			.toMatchObject([{ type: 'unit_started', occurred_on: '2026-10-15', unit_serial: 'UNIT-4', unit_expiry: '2028-12-31' }])
		expect(inventory.packages).toMatchObject([{ units_remaining: 1 }])
		expect(forecastResponse.status).toBe(200)
		expect(forecast.categories).toMatchObject([{
			categoryName: 'CGM sensor',
			stockUnits: 1,
			activeUnits: 1,
			runOutDate: '2026-11-04',
			nextPickProduct: 'Sensor',
		}])
	})

	it('starts an item without opening its matched box when the scan toggle is off', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env)
		const unitResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ categoryId: 1, manufacturer: 'Acme', name: 'Sensor', gtin: '00036000291452' }),
		}, env)
		const unitData = await unitResponse.json() as { product: { id: number } }
		const packResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ categoryId: 1, manufacturer: 'Acme', name: 'Sensor pack', containsProductId: unitData.product.id, containsQty: 2 }),
		}, env)
		const packData = await packResponse.json() as { product: { id: number } }
		await app.request('/api/receipts', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ productId: packData.product.id, lot: 'LOT-OFF', receivedOn: '2026-10-14' }),
		}, env)

		const response = await app.request('/api/unit-scans', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ gtin: '00036000291452', lot: 'LOT-OFF', markBoxOpened: false, occurredOn: '2026-10-15' }),
		}, env)
		const result = await response.json() as { opened: boolean; implicit: boolean }

		expect(response.status).toBe(201)
		expect(result).toMatchObject({ opened: false, implicit: false })
		expect(env.DB.events.map((event) => event.type)).toEqual(['received', 'unit_started'])
	})

	it('defers an item scan until the previous-package leftovers are resolved', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env)
		const unitResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ categoryId: 1, manufacturer: 'Acme', name: 'Sensor', gtin: '00036000291452' }),
		}, env)
		const unitData = await unitResponse.json() as { product: { id: number } }
		const packResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ categoryId: 1, manufacturer: 'Acme', name: 'Sensor pack', containsProductId: unitData.product.id, containsQty: 3 }),
		}, env)
		const packData = await packResponse.json() as { product: { id: number } }
		const receivePackage = async (lot: string, receivedOn: string) => {
			await app.request('/api/receipts', {
				method: 'POST',
				headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
				body: JSON.stringify({ productId: packData.product.id, lot, receivedOn }),
			}, env)
			return env.DB.packages.at(-1)!.id
		}
		const firstPackageId = await receivePackage('LOT-OLD', '2026-10-10')
		await app.request(`/api/packages/${firstPackageId}/open`, {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ occurredOn: '2026-10-11' }),
		}, env)
		const secondPackageId = await receivePackage('LOT-NEW', '2026-10-12')
		const scanBody = {
			gtin: '00036000291452',
			lot: 'LOT-NEW',
			serial: 'UNIT-NEW',
			occurredOn: '2026-10-15',
			markBoxOpened: true,
		}
		const eventCountBeforeScan = env.DB.events.length
		const scanRequest = (extra: Record<string, unknown> = {}) => app.request('/api/unit-scans', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...scanBody, ...extra }),
		}, env)

		const confirmationResponse = await scanRequest()
		const confirmation = await confirmationResponse.json() as { error: string; remainingUnits: number }
		expect(confirmationResponse.status).toBe(409)
		expect(confirmation).toMatchObject({ error: 'leftover_confirmation_required', remainingUnits: 2 })
		expect(env.DB.events).toHaveLength(eventCountBeforeScan)

		const resolvedResponse = await scanRequest({ leftoverResolution: 'keep' })
		const resolved = await resolvedResponse.json() as { opened: boolean; matchedBy: string }
		expect(resolvedResponse.status).toBe(201)
		expect(resolved).toMatchObject({ opened: true, matchedBy: 'lot' })
		expect(env.DB.events.slice(eventCountBeforeScan)).toMatchObject([
			{ package_id: secondPackageId, type: 'opened' },
			{ package_id: firstPackageId, type: 'unit_ended' },
			{ package_id: secondPackageId, type: 'unit_started', unit_serial: 'UNIT-NEW' },
		])
	})

	it('asks before opening a box with leftovers, then records the chosen resolution', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env)
		const productResponse = await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ categoryId: 1, manufacturer: 'Acme', name: 'Sensor pack', gtin: '09506000134352', containsQty: 3 }),
		}, env)
		const productData = await productResponse.json() as { product: { id: number } }
		const receivePackage = async (receivedOn: string) => {
			await app.request('/api/receipts', {
				method: 'POST',
				headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
				body: JSON.stringify({ productId: productData.product.id, receivedOn }),
			}, env)
			return env.DB.packages.at(-1)!.id
		}
		const openRequest = (packageId: number, options: Record<string, unknown> = {}) => app.request(`/api/packages/${packageId}/open`, {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ occurredOn: '2026-10-15', ...options }),
		}, env)
		const firstPackageId = await receivePackage('2026-10-10')
		expect((await openRequest(firstPackageId)).status).toBe(201)
		const secondPackageId = await receivePackage('2026-10-11')

		const startChoiceResponse = await openRequest(secondPackageId)
		const startChoice = await startChoiceResponse.json() as { error: string; remainingUnits: number }
		const leftoverResponse = await openRequest(secondPackageId, { startFirstUnit: true })
		const leftover = await leftoverResponse.json() as { error: string; remainingUnits: number }
		expect(startChoiceResponse.status).toBe(409)
		expect(startChoice).toMatchObject({ error: 'start_choice_required', remainingUnits: 2 })
		expect(leftoverResponse.status).toBe(409)
		expect(leftover).toMatchObject({ error: 'leftover_confirmation_required', remainingUnits: 2 })
		expect(env.DB.events).toHaveLength(4)

		const resolvedResponse = await openRequest(secondPackageId, { startFirstUnit: true, leftoverResolution: 'mark_used' })
		expect(resolvedResponse.status).toBe(201)
		expect(env.DB.events.slice(4)).toMatchObject([
			{ package_id: firstPackageId, type: 'discarded', qty: 2, inferred: 1 },
			{ package_id: secondPackageId, type: 'opened' },
			{ package_id: firstPackageId, type: 'unit_ended', end_reason: 'planned' },
			{ package_id: secondPackageId, type: 'unit_started' },
		])
	})

	it('creates an implicit package when a unit scan has no eligible received pack', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env)
		await app.request('/api/products', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ categoryId: 1, manufacturer: 'Acme', name: 'Sensor', gtin: '00036000291452', containsQty: 1 }),
		}, env)
		const response = await app.request('/api/unit-scans', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ gtin: '00036000291452', serial: 'UNIT-9', occurredOn: '2026-10-14' }),
		}, env)
		const duplicateResponse = await app.request('/api/unit-scans', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ gtin: '00036000291452', serial: 'UNIT-9', occurredOn: '2026-10-14' }),
		}, env)
		const result = await response.json() as { implicit: boolean; matchedBy: null }

		expect(response.status).toBe(201)
		expect(duplicateResponse.status).toBe(409)
		expect(result).toMatchObject({ implicit: true, matchedBy: null })
		expect(env.DB.packages).toMatchObject([{ implicit: 1, product_id: 1 }])
		expect(env.DB.events).toMatchObject([{ type: 'unit_started', unit_serial: 'UNIT-9' }])
	})
})