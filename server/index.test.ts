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
	note?: string | null
}

type FakePasskey = {
	credential_id: string
	public_key: string
	counter: number
	transports: string
	user_id: string
	label: string
	device_type: string
	backed_up: number
	rp_id: string
	created_at: number
}

type FakeChallenge = {
	challenge: string
	purpose: string
	rp_id: string
	session_hash: string | null
	user_id: string | null
	expires_at: number
}

function createDatabase() {
	const loginAttempts = new Map<string, { attempts: number; window_started_at: number; lock_level: number; locked_until: number }>()
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
	const passkeys = new Map<string, FakePasskey>()
	const challenges = new Map<string, FakeChallenge>()
	return {
		sessions,
		passkeys,
		challenges,
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
					if (query.includes('INSERT INTO auth_webauthn_challenges')) {
						challenges.set(String(values[0]), {
							challenge: String(values[0]),
							purpose: String(values[1]),
							rp_id: String(values[2]),
							session_hash: values[3] === null ? null : String(values[3]),
							user_id: values[4] === null ? null : String(values[4]),
							expires_at: Number(values[5]),
						})
					}
					if (query.includes('DELETE FROM auth_webauthn_challenges WHERE expires_at')) {
						for (const [challenge, record] of challenges) {
							if (record.expires_at <= Number(values[0])) challenges.delete(challenge)
						}
					}
					if (query.includes('INSERT INTO auth_webauthn_credentials')) {
						const credential: FakePasskey = {
							credential_id: String(values[0]),
							public_key: String(values[1]),
							counter: Number(values[2]),
							transports: String(values[3]),
							user_id: String(values[4]),
							label: String(values[5]),
							device_type: String(values[6]),
							backed_up: Number(values[7]),
							rp_id: String(values[8]),
							created_at: Number(values[9]),
						}
						passkeys.set(`${credential.rp_id}:${credential.credential_id}`, credential)
					}
					if (query.includes('UPDATE auth_webauthn_credentials')) {
						const credential = passkeys.get(`${String(values[4])}:${String(values[3])}`)
						if (credential) {
							credential.counter = Number(values[0])
							credential.device_type = String(values[1])
							credential.backed_up = Number(values[2])
						}
					}
					if (query.includes('DELETE FROM auth_webauthn_credentials')) {
						passkeys.delete(`${String(values[1])}:${String(values[0])}`)
					}
					if (query.includes('INSERT INTO settings')) {
						settings.set('include_projected_receipts', String(values[0]))
					}
					if (query.includes('DELETE FROM auth_login_attempts WHERE client_key')) {
						loginAttempts.delete(String(values[0]))
					}
					if (query.includes('DELETE FROM auth_login_attempts WHERE window_started_at')) {
						for (const [clientKey, attempt] of loginAttempts) {
							if (attempt.window_started_at < Number(values[0])) loginAttempts.delete(clientKey)
						}
					}
					if (query.includes('UPDATE auth_login_attempts') && query.includes('attempts = 0')) {
						const attempt = loginAttempts.get(String(values[1]))
						if (attempt) {
							attempt.attempts = 0
							attempt.window_started_at = Number(values[0])
							attempt.locked_until = 0
						}
					}
					if (query.includes('UPDATE auth_login_attempts') && query.includes('lock_level = lock_level + 1')) {
						const attempt = loginAttempts.get(String(values[1]))
						if (attempt) {
							attempt.lock_level += 1
							attempt.locked_until = Number(values[0])
						}
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
					if (query.includes('DELETE FROM auth_webauthn_challenges') && query.includes('RETURNING user_id')) {
						const record = challenges.get(String(values[0]))
						if (!record || record.purpose !== String(values[1]) || record.rp_id !== String(values[2])
							|| record.expires_at <= Number(values[3]) || record.session_hash !== (values[4] === null ? null : String(values[4]))) return null
						challenges.delete(record.challenge)
						return { user_id: record.user_id } as T
					}
					if (query.includes('SELECT COUNT(*) AS count FROM auth_webauthn_credentials')) {
						return { count: [...passkeys.values()].filter((passkey) => passkey.rp_id === String(values[0])).length } as T
					}
					if (query.includes('FROM auth_webauthn_credentials WHERE credential_id = ?')) {
						return (passkeys.get(`${String(values[1])}:${String(values[0])}`) ?? null) as T | null
					}
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
							? (previousProduct.contains_qty ?? 1)
								+ events.filter((event) => event.package_id === previous.id && event.type === 'adjusted').reduce((sum, event) => sum + event.qty, 0)
								- events.filter((event) => event.package_id === previous.id
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
					if (query.includes('SELECT packages.id FROM packages') && query.includes('packages.serial = ?')) {
						const pkg = packages.find((item) => item.serial === String(values[0]) && !item.implicit)
						if (!pkg) return null
						const received = events.find((event) => event.package_id === pkg.id && event.type === 'received')
						if (received && events.some((event) => event.note === `undo:${received.id}`)) return null
						return { id: pkg.id } as T
					}
					if (query.includes('FROM events') && query.includes('products.contains_qty AS containsQty') && query.includes('WHERE events.id = ?')) {
						const event = events.find((item) => item.id === Number(values[0]))
						if (!event) return null
						const pkg = packages.find((item) => item.id === event.package_id)
						const product = products.find((item) => item.id === pkg?.product_id)
						return {
							id: event.id,
							packageId: event.package_id,
							type: event.type,
							qty: event.qty,
							occurredOn: event.occurred_on,
							unitExpiry: event.unit_expiry ?? null,
							note: event.note ?? null,
							containsQty: product?.contains_qty ?? null,
						} as T
					}
					if (query.includes('FROM events AS undoing')) {
						const undone = events.some((event) => event.note === `undo:${Number(values[0])}`)
						return (undone ? { undone: 1 } : null) as T | null
					}
					if (query.includes('SELECT 1 AS ended FROM events')) {
						const ended = events.some((event) => event.package_id === Number(values[0])
							&& event.type === 'unit_ended'
							&& (event.occurred_on > String(values[1])
								|| (event.occurred_on === String(values[2]) && event.id > Number(values[3]))))
						return (ended ? { ended: 1 } : null) as T | null
					}
					if (query.includes('SELECT COUNT(*) AS count FROM events WHERE package_id = ?')) {
						return { count: events.filter((event) => event.package_id === Number(values[0])).length } as T
					}
					if (query.includes('SELECT lock_level, locked_until')) {
						const attempt = loginAttempts.get(String(values[0]))
						return (attempt ? { lock_level: attempt.lock_level, locked_until: attempt.locked_until } : null) as T | null
					}
					if (query.includes('SELECT last_seen_at, expires_at')) {
						return (sessions.get(String(values[0])) ?? null) as T | null
					}
					if (query.includes('INSERT INTO auth_login_attempts')) {
						const clientKey = String(values[0])
						const now = Number(values[1])
						const windowCutoff = Number(values[2])
						const previous = loginAttempts.get(clientKey)
						if (!previous || previous.window_started_at <= windowCutoff) {
							const attempt = { attempts: 1, window_started_at: now, lock_level: previous?.lock_level ?? 0, locked_until: previous?.locked_until ?? 0 }
							loginAttempts.set(clientKey, attempt)
							return { window_started_at: attempt.window_started_at, attempts: attempt.attempts } as T
						} else {
							previous.attempts += 1
							return { window_started_at: previous.window_started_at, attempts: previous.attempts } as T
						}
					}
					return null
				},
				async all<T>() {
					if (query.includes('FROM auth_webauthn_credentials WHERE rp_id = ?')) {
						return { results: [...passkeys.values()].filter((passkey) => passkey.rp_id === String(values[0])) as T[] }
					}
					if (query.includes('FROM events') && query.includes('unit_products')) {
						return {
							results: events.flatMap((event) => {
								const pkg = packages.find((item) => item.id === event.package_id)
								const product = products.find((item) => item.id === pkg?.product_id)
								const unitProduct = products.find((item) => item.id === product?.contains_product_id)
								const category = categories.find((item) => item.id === product?.category_id)
								if (!pkg || !product || !category) return []
								const parsedUndo = event.note?.startsWith('undo:') ? Number(event.note.slice(5)) : null
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
									lot: pkg.lot ?? null,
									serial: pkg.serial ?? null,
									undone: events.some((undoing) => undoing.note === `undo:${event.id}`) ? 1 : 0,
									undoOfEventId: parsedUndo,
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
						return { results: events
							.filter((event) => event.unit_serial && !events.some((undoing) => undoing.note === `undo:${event.id}`))
							.map((event) => ({ unit_serial: event.unit_serial! })) as T[] }
					}
					if (query.includes('products.contains_product_id = ?')) {
						return {
							results: packages.flatMap((pkg) => {
								const product = products.find((item) => item.id === pkg.product_id)
								const received = events.find((event) => event.package_id === pkg.id && event.type === 'received')
								if (!product || product.contains_product_id !== Number(values[0]) || !received) return []
								const adjusted = events.filter((event) => event.package_id === pkg.id && event.type === 'adjusted').reduce((sum, event) => sum + event.qty, 0)
								const consumed = events.filter((event) => event.package_id === pkg.id
									&& (event.type === 'unit_started' || event.type === 'discarded')).reduce((sum, event) => sum + event.qty, 0)
								return [{
									id: pkg.id,
									containsProductId: product.contains_product_id,
									lot: pkg.lot ?? undefined,
									expiry: pkg.expiry ?? undefined,
									receivedOn: received.occurred_on,
									unitsRemaining: Math.max(0, (product.contains_qty ?? 1) + adjusted - consumed),
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
							note: values[8] === undefined || values[8] === null ? null : String(values[8]),
						})
					}
				}
			}
			return statements.map(() => ({ success: true, results: [], meta: {} }))
		},
	} as unknown as D1Database & {
		sessions: Map<string, { last_seen_at: number; expires_at: number }>
		passkeys: Map<string, FakePasskey>
		challenges: Map<string, FakeChallenge>
		products: FakeProduct[]
		packages: FakePackage[]
		events: FakeEvent[]
	}
}

function createEnv(options: { password?: string } = {}): Env & {
	DB: D1Database & {
		sessions: Map<string, { last_seen_at: number; expires_at: number }>
		passkeys: Map<string, FakePasskey>
		challenges: Map<string, FakeChallenge>
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

async function authenticatedCookie(env: Env, origin = 'http://localhost'): Promise<string> {
	const login = await app.request(`${origin}/api/auth/login`, loginRequest('household passphrase', origin), env)
	return (login.headers.get('set-cookie') ?? '').split(';', 1)[0]!
}

describe('Worker authentication routes', () => {
	it('keeps health and session discovery public while failing closed when unconfigured', async () => {
		const env = createEnv()
		const health = await app.request('/api/health', {}, env)
		const session = await app.request('/api/auth/session', {}, env)
		const inventory = await app.request('/api/categories', {}, env)

		expect(health.status).toBe(200)
		expect(await session.json()).toEqual({ configured: false, authenticated: false, passkeysAvailable: false })
		expect(inventory.status).toBe(503)
	})

	it('keeps session discovery available on an insecure non-local origin without advertising passkeys', async () => {
		const session = await app.request('http://supplies.example.com/api/auth/session', {}, createEnv({ password: 'household passphrase' }))

		expect(session.status).toBe(200)
		expect(await session.json()).toEqual({ configured: true, authenticated: false, passkeysAvailable: false })
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
		expect(await session.json()).toEqual({ configured: true, authenticated: true, passkeysAvailable: false })
		expect(env.DB.sessions.size).toBe(1)

		const logout = await app.request('/api/auth/logout', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie },
		}, env)
		const revokedSession = await app.request('/api/auth/session', { headers: { Cookie: cookie } }, env)
		expect(logout.status).toBe(200)
		expect(await revokedSession.json()).toEqual({ configured: true, authenticated: false, passkeysAvailable: false })
		expect(env.DB.sessions.size).toBe(0)
	})

	it('requires the household password and same-origin session before enrollment', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env, 'https://localhost')
		const headers = { Origin: 'https://localhost', Cookie: cookie, 'Content-Type': 'application/json' }
		const wrongPassword = await app.request('https://localhost/api/auth/passkeys/register/options', {
			method: 'POST',
			headers,
			body: JSON.stringify({ password: 'wrong password' }),
		}, env)
		const crossOrigin = await app.request('https://localhost/api/auth/passkeys/register/options', {
			method: 'POST',
			headers: { ...headers, Origin: 'https://attacker.example' },
			body: JSON.stringify({ password: 'household passphrase' }),
		}, env)

		expect(wrongPassword.status).toBe(401)
		expect(crossOrigin.status).toBe(403)
		expect(env.DB.challenges.size).toBe(0)
	})

	it('binds registration challenges to the session and consumes each challenge once', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env, 'https://localhost')
		const headers = { Origin: 'https://localhost', Cookie: cookie, 'Content-Type': 'application/json' }
		const optionsResponse = await app.request('https://localhost/api/auth/passkeys/register/options', {
			method: 'POST',
			headers,
			body: JSON.stringify({ password: 'household passphrase' }),
		}, env)
		const options = await optionsResponse.json() as { challenge: string }
		const otherCookie = await authenticatedCookie(env, 'https://localhost')
		const body = JSON.stringify({
			challenge: options.challenge,
			response: { id: 'credential', rawId: 'credential', response: {} },
		})
		const otherSession = await app.request('https://localhost/api/auth/passkeys/register/verify', {
			method: 'POST',
			headers: { Origin: 'https://localhost', Cookie: otherCookie, 'Content-Type': 'application/json' },
			body,
		}, env)
		const invalidCredential = await app.request('https://localhost/api/auth/passkeys/register/verify', {
			method: 'POST', headers, body,
		}, env)
		const replay = await app.request('https://localhost/api/auth/passkeys/register/verify', {
			method: 'POST', headers, body,
		}, env)

		expect(optionsResponse.status).toBe(200)
		expect(otherSession.status).toBe(401)
		expect(invalidCredential.status).toBe(400)
		expect(replay.status).toBe(401)
		expect(env.DB.challenges.size).toBe(0)
	})

	it('rejects an expired registration challenge', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env, 'https://localhost')
		const headers = { Origin: 'https://localhost', Cookie: cookie, 'Content-Type': 'application/json' }
		const optionsResponse = await app.request('https://localhost/api/auth/passkeys/register/options', {
			method: 'POST', headers,
			body: JSON.stringify({ password: 'household passphrase' }),
		}, env)
		const options = await optionsResponse.json() as { challenge: string }
		const challenge = env.DB.challenges.get(options.challenge)
		if (challenge) challenge.expires_at = Date.now() - 1
		const response = await app.request('https://localhost/api/auth/passkeys/register/verify', {
			method: 'POST', headers,
			body: JSON.stringify({
				challenge: options.challenge,
				response: { id: 'credential', rawId: 'credential', response: {} },
			}),
		}, env)

		expect(optionsResponse.status).toBe(200)
		expect(response.status).toBe(401)
	})

	it('lists and removes credentials only for the active hostname', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env)
		env.DB.passkeys.set('localhost:credential-a', {
			credential_id: 'credential-a',
			public_key: 'AQ',
			counter: 0,
			transports: '[]',
			user_id: 'user-id',
			label: 'Laptop',
			device_type: 'multiDevice',
			backed_up: 1,
			rp_id: 'localhost',
			created_at: Date.UTC(2026, 9, 16),
		})
		env.DB.passkeys.set('other.example:credential-b', {
			credential_id: 'credential-b',
			public_key: 'Ag',
			counter: 0,
			transports: '[]',
			user_id: 'other-user-id',
			label: 'Other host',
			device_type: 'singleDevice',
			backed_up: 0,
			rp_id: 'other.example',
			created_at: Date.UTC(2026, 9, 16),
		})
		const list = await app.request('/api/auth/passkeys', { headers: { Cookie: cookie } }, env)
		const session = await app.request('/api/auth/session', { headers: { Cookie: cookie } }, env)
		const remove = await app.request('/api/auth/passkeys/credential-a', {
			method: 'DELETE',
			headers: { Origin: 'http://localhost', Cookie: cookie },
		}, env)

		expect(await list.json()).toEqual({ passkeys: [{
			credential_id: 'credential-a', label: 'Laptop', created_at: Date.UTC(2026, 9, 16), device_type: 'multiDevice', backed_up: 1,
		}] })
		expect(await session.json()).toEqual({ configured: true, authenticated: true, passkeysAvailable: true })
		expect(remove.status).toBe(200)
		expect(env.DB.passkeys.has('localhost:credential-a')).toBe(false)
		expect(env.DB.passkeys.has('other.example:credential-b')).toBe(true)
	})

	it('rejects passkey login options from another origin and when none are enrolled', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const crossOrigin = await app.request('/api/auth/passkeys/login/options', {
			method: 'POST', headers: { Origin: 'https://attacker.example' },
		}, env)
		const missingPasskeys = await app.request('/api/auth/passkeys/login/options', {
			method: 'POST', headers: { Origin: 'http://localhost' },
		}, env)

		expect(crossOrigin.status).toBe(403)
		expect(missingPasskeys.status).toBe(404)
	})

	it('rejects assertions with the wrong browser origin and consumes failed login challenges', async () => {
		const env = createEnv({ password: 'household passphrase' })
		env.DB.passkeys.set('localhost:credential-a', {
			credential_id: 'credential-a',
			public_key: 'AQ',
			counter: 0,
			transports: '[]',
			user_id: 'user-id',
			label: 'Laptop',
			device_type: 'multiDevice',
			backed_up: 1,
			rp_id: 'localhost',
			created_at: Date.now(),
		})
		const optionsResponse = await app.request('/api/auth/passkeys/login/options', {
			method: 'POST', headers: { Origin: 'http://localhost' },
		}, env)
		const options = await optionsResponse.json() as { challenge: string }
		const clientDataJSON = btoa(JSON.stringify({
			type: 'webauthn.get',
			challenge: options.challenge,
			origin: 'https://attacker.example',
			crossOrigin: false,
		})).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
		const body = JSON.stringify({
			challenge: options.challenge,
			response: {
				id: 'credential-a',
				rawId: 'credential-a',
				type: 'public-key',
				response: { clientDataJSON, authenticatorData: 'AQ', signature: 'AQ', userHandle: null },
				clientExtensionResults: {},
			},
		})
		const verification = await app.request('/api/auth/passkeys/login/verify', {
			method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body,
		}, env)
		const replay = await app.request('/api/auth/passkeys/login/verify', {
			method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body,
		}, env)

		expect(optionsResponse.status).toBe(200)
		expect(verification.status).toBe(401)
		expect(replay.status).toBe(401)
		expect(env.DB.sessions.size).toBe(0)
	})

	it('keeps passkey throttling separate from password recovery', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const responses: number[] = []
		for (let attempt = 0; attempt < 9; attempt += 1) {
			const response = await app.request('/api/auth/passkeys/login/options', {
				method: 'POST',
				headers: { Origin: 'http://localhost', 'CF-Connecting-IP': '192.0.2.10' },
			}, env)
			responses.push(response.status)
		}
		const passwordLogin = await app.request('/api/auth/login', loginRequest('household passphrase'), env)

		expect(responses.slice(0, 8)).toEqual(Array.from({ length: 8 }, () => 404))
		expect(responses[8]).toBe(429)
		expect(passwordLogin.status).toBe(200)
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
			lot: 'LOT-8',
			serial: null,
			undone: 0,
			undoOfEventId: null,
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

	it('undoes ledger events by appending compensating entries and frees their serials', async () => {
		const env = createEnv({ password: 'household passphrase' })
		const cookie = await authenticatedCookie(env)
		const jsonHeaders = { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' }

		const unitResponse = await app.request('/api/products', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				categoryId: 1,
				manufacturer: 'Acme',
				name: 'Sensor',
				gtin: '00036000291452',
				containsQty: 1,
				ratedWearDays: 10,
			}),
		}, env)
		const unitData = await unitResponse.json() as { product: { id: number } }
		const packResponse = await app.request('/api/products', {
			method: 'POST',
			headers: jsonHeaders,
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
			headers: jsonHeaders,
			body: JSON.stringify({ productId: packData.product.id, lot: 'L1', serial: 'BOX-1', expiry: '2028-12-31', receivedOn: '2026-10-14' }),
		}, env)
		const startResponse = await app.request('/api/unit-scans', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ gtin: '00036000291452', lot: 'L1', expiry: '2028-12-31', serial: 'U1', occurredOn: '2026-10-15' }),
		}, env)
		const duplicateStartResponse = await app.request('/api/unit-scans', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ gtin: '00036000291452', lot: 'L1', expiry: '2028-12-31', serial: 'U1', occurredOn: '2026-10-15' }),
		}, env)
		expect(startResponse.status).toBe(201)
		expect(duplicateStartResponse.status).toBe(409)
		expect(env.DB.events).toMatchObject([
			{ id: 1, type: 'received' },
			{ id: 2, type: 'opened' },
			{ id: 3, type: 'unit_started', unit_serial: 'U1' },
		])

		const undoStartResponse = await app.request('/api/events/3/undo', {
			method: 'POST', headers: jsonHeaders, body: JSON.stringify({ occurredOn: '2026-10-17' }),
		}, env)
		expect(undoStartResponse.status).toBe(200)
		expect(env.DB.events).toMatchObject([
			{ id: 1, type: 'received' },
			{ id: 2, type: 'opened' },
			{ id: 3, type: 'unit_started', unit_serial: 'U1' },
			{ id: 4, type: 'adjusted', qty: 1, note: 'undo:3' },
			{ id: 5, type: 'unit_ended', occurred_on: '2026-10-15', end_reason: 'other', unit_serial: null, note: 'undo:3' },
		])
		const inventoryAfterUndo = await (await app.request('/api/inventory', { headers: { Cookie: cookie } }, env)).json() as {
			packages: Array<{ id: number; units_remaining: number }>
		}
		expect(inventoryAfterUndo.packages).toMatchObject([{ id: 1, units_remaining: 2 }])

		const rescanResponse = await app.request('/api/unit-scans', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ gtin: '00036000291452', lot: 'L1', expiry: '2028-12-31', serial: 'U1', occurredOn: '2026-10-18' }),
		}, env)
		expect(rescanResponse.status).toBe(201)
		expect(env.DB.events.filter((event) => event.type === 'unit_started')).toHaveLength(2)

		const repeatedUndo = await app.request('/api/events/3/undo', {
			method: 'POST', headers: jsonHeaders, body: JSON.stringify({ occurredOn: '2026-10-18' }),
		}, env)
		const undoOfUndo = await app.request('/api/events/4/undo', {
			method: 'POST', headers: jsonHeaders, body: JSON.stringify({ occurredOn: '2026-10-18' }),
		}, env)
		const undoOpened = await app.request('/api/events/2/undo', {
			method: 'POST', headers: jsonHeaders, body: JSON.stringify({ occurredOn: '2026-10-18' }),
		}, env)
		const undoEnded = await app.request('/api/events/5/undo', {
			method: 'POST', headers: jsonHeaders, body: JSON.stringify({ occurredOn: '2026-10-18' }),
		}, env)
		expect(repeatedUndo.status).toBe(409)
		expect(await repeatedUndo.json()).toMatchObject({ reason: 'already_undone' })
		expect(undoOfUndo.status).toBe(409)
		expect(await undoOfUndo.json()).toMatchObject({ reason: 'undo_event' })
		expect(undoOpened.status).toBe(409)
		expect(await undoOpened.json()).toMatchObject({ reason: 'structural_event' })
		expect(undoEnded.status).toBe(409)
		expect(await undoEnded.json()).toMatchObject({ reason: 'undo_event' })

		const blockedReceiptUndo = await app.request('/api/events/1/undo', {
			method: 'POST', headers: jsonHeaders, body: JSON.stringify({ occurredOn: '2026-10-18' }),
		}, env)
		expect(blockedReceiptUndo.status).toBe(409)
		expect(await blockedReceiptUndo.json()).toMatchObject({ reason: 'package_has_history' })

		const secondReceipt = await app.request('/api/receipts', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ productId: packData.product.id, lot: 'L2', serial: 'BOX-2', expiry: '2028-12-31', receivedOn: '2026-10-16' }),
		}, env)
		expect(secondReceipt.status).toBe(201)
		const secondReceiptId = env.DB.events.at(-1)!.id
		const cleanUndo = await app.request(`/api/events/${secondReceiptId}/undo`, {
			method: 'POST', headers: jsonHeaders, body: JSON.stringify({ occurredOn: '2026-10-18' }),
		}, env)
		expect(cleanUndo.status).toBe(200)
		const inventoryAfterReceivedUndo = await (await app.request('/api/inventory', { headers: { Cookie: cookie } }, env)).json() as {
			packages: Array<Record<string, unknown>>
		}
		expect(inventoryAfterReceivedUndo.packages).toContainEqual(
			expect.objectContaining({ serial: 'BOX-2', units_remaining: 0 }),
		)
		const rereceipt = await app.request('/api/receipts', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ productId: packData.product.id, lot: 'L2', serial: 'BOX-2', expiry: '2028-12-31', receivedOn: '2026-10-18' }),
		}, env)
		expect(rereceipt.status).toBe(201)

		const activity = await (await app.request('/api/activity', { headers: { Cookie: cookie } }, env)).json() as {
			events: Array<Record<string, unknown>>
			durationStats: Array<{ sampleCount: number }>
		}
		expect(activity.events.find((event) => event.id === 3)).toMatchObject({ undone: 1 })
		expect(activity.events.find((event) => event.id === 4)).toMatchObject({ undoOfEventId: 3 })
		expect(activity.events.find((event) => event.id === secondReceiptId)).toMatchObject({
			type: 'received', serial: 'BOX-2', lot: 'L2', undone: 1,
		})
		expect(activity.events.find((event) => event.undoOfEventId === secondReceiptId)).toMatchObject({
			type: 'adjusted', qty: -2,
		})
		expect(activity.durationStats).toEqual([])
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

	it('records a past-date unit scan without rejecting it at the API layer', async () => {
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
			body: JSON.stringify({ productId: packData.product.id, lot: 'LOT-PAST', expiry: '2026-10-14', receivedOn: '2026-10-14' }),
		}, env)

		const response = await app.request('/api/unit-scans', {
			method: 'POST',
			headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				gtin: '00036000291452',
				lot: 'LOT-PAST',
				expiry: '2026-10-14',
				serial: 'UNIT-PAST',
				occurredOn: '2026-10-15',
			}),
		}, env)

		expect(response.status).toBe(201)
		expect(env.DB.events).toMatchObject([
			{ type: 'received' },
			{ type: 'opened' },
			{ type: 'unit_started', unit_serial: 'UNIT-PAST', unit_expiry: '2026-10-14' },
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