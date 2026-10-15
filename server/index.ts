import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { matchUnitScan, planPackageOpen, planUnitStart, type OpenPackageCandidate } from '../src/domain/ledger'
import {
	createSession,
	hashClientAddress,
	isAuthConfigured,
	LEGACY_SESSION_COOKIE,
	passwordMatches,
	SESSION_COOKIE,
	revokeSession,
	sessionCookieName,
	verifySession,
} from './auth'

type Category = {
	id: number
	key: string
	name: string
	overlap_allowed: number
}

type Product = {
	id: number
	category_id: number
	category_name: string
	manufacturer: string
	name: string
	gtin: string | null
	contains_product_id: number | null
	contains_qty: number | null
}

function isIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
	const date = new Date(`${value}T00:00:00.000Z`)
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isValidGtin(value: string): boolean {
	if (!/^\d{14}$/.test(value)) return false
	let sum = 0
	for (let index = value.length - 2, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) {
		sum += Number(value[index]) * weight
	}
	return (10 - (sum % 10)) % 10 === Number(value.at(-1))
}

const app = new Hono<{ Bindings: Env }>()

const publicApiPaths = new Set([
	'/api/health',
	'/api/auth/session',
	'/api/auth/login',
	'/api/auth/logout',
])
const attemptWindowMs = 10 * 60 * 1000
const maxLoginAttempts = 8
const initialLoginCooldownMs = 5 * 60 * 1000
const maxLoginCooldownMs = 60 * 60 * 1000
const sessionDurationSeconds = 12 * 60 * 60

app.use('*', async (context, next) => {
	await next()
	context.header('X-Content-Type-Options', 'nosniff')
	context.header('X-Frame-Options', 'DENY')
	context.header('Referrer-Policy', 'no-referrer')
	context.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
	context.header('Cross-Origin-Opener-Policy', 'same-origin')
	context.header('Cross-Origin-Resource-Policy', 'same-origin')
	context.header(
		'Content-Security-Policy',
		"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:",
	)
	if (new URL(context.req.url).protocol === 'https:') {
		context.header('Strict-Transport-Security', 'max-age=31536000')
	}
})

app.use('/api/*', async (context, next) => {
	context.header('Cache-Control', 'no-store')
	if (publicApiPaths.has(context.req.path)) return next()
	if (!isAuthConfigured(context.env)) {
		return context.json({ error: 'authentication_not_configured' }, 503)
	}

	const token = getCookie(context, sessionCookieName(context.req.url))
	const authenticated = await verifySession(context.env.DB, token)
	if (!authenticated) return context.json({ error: 'authentication_required' }, 401)
	if (!['GET', 'HEAD', 'OPTIONS'].includes(context.req.method)
		&& context.req.header('Origin') !== new URL(context.req.url).origin) {
		return context.json({ error: 'same_origin_required' }, 403)
	}
	return next()
})

app.get('/api/health', (context) => {
	return context.json({ status: 'ok' })
})

app.get('/api/auth/session', async (context) => {
	const configured = isAuthConfigured(context.env)
	const authenticated = configured && await verifySession(
		context.env.DB,
		getCookie(context, sessionCookieName(context.req.url)),
	)
	return context.json({ configured, authenticated })
})

app.post('/api/auth/login', async (context) => {
	if (!isAuthConfigured(context.env)) {
		return context.json({ error: 'authentication_not_configured' }, 503)
	}
	if (context.req.header('Origin') !== new URL(context.req.url).origin) {
		return context.json({ error: 'same_origin_required' }, 403)
	}

	const body = await context.req.json<{ password?: unknown }>().catch(() => null)
	if (!body || typeof body.password !== 'string' || body.password.length > 1024) {
		return context.json({ error: 'invalid_request' }, 400)
	}

	const now = Date.now()
	const clientAddress = context.req.header('CF-Connecting-IP') ?? 'unknown'
	const clientKey = await hashClientAddress(clientAddress)
	await context.env.DB.prepare('DELETE FROM auth_login_attempts WHERE window_started_at < ?')
		.bind(now - 24 * 60 * 60 * 1000)
		.run()
	const lock = await context.env.DB.prepare(
		'SELECT lock_level, locked_until FROM auth_login_attempts WHERE client_key = ?',
	).bind(clientKey).first<{ lock_level: number; locked_until: number }>()
	if (lock?.locked_until && lock.locked_until > now) {
		context.header('Retry-After', String(Math.ceil((lock.locked_until - now) / 1000)))
		return context.json({ error: 'too_many_attempts' }, 429)
	}
	if (lock?.locked_until) {
		await context.env.DB.prepare(`
			UPDATE auth_login_attempts
			SET attempts = 0, window_started_at = ?, locked_until = 0
			WHERE client_key = ?
		`).bind(now, clientKey).run()
	}

	const attempt = await context.env.DB.prepare(`
		INSERT INTO auth_login_attempts (client_key, window_started_at, attempts)
		VALUES (?, ?, 1)
		ON CONFLICT(client_key) DO UPDATE SET
			window_started_at = CASE
				WHEN auth_login_attempts.window_started_at <= ? THEN excluded.window_started_at
				ELSE auth_login_attempts.window_started_at
			END,
			attempts = CASE
				WHEN auth_login_attempts.window_started_at <= ? THEN 1
				ELSE auth_login_attempts.attempts + 1
			END
		RETURNING window_started_at, attempts
	`).bind(clientKey, now, now - attemptWindowMs, now - attemptWindowMs).first<{
		window_started_at: number
		attempts: number
	}>()
	if (!attempt) return context.json({ error: 'authentication_unavailable' }, 503)
	if (attempt.attempts > maxLoginAttempts) {
		const lockLevel = lock?.lock_level ?? 0
		const cooldown = Math.min(initialLoginCooldownMs * 2 ** lockLevel, maxLoginCooldownMs)
		await context.env.DB.prepare(`
			UPDATE auth_login_attempts
			SET lock_level = lock_level + 1, locked_until = ?
			WHERE client_key = ?
		`).bind(now + cooldown, clientKey).run()
		context.header('Retry-After', String(Math.ceil(cooldown / 1000)))
		return context.json({ error: 'too_many_attempts' }, 429)
	}

	if (!await passwordMatches(body.password, context.env.PIKALOG_PASSWORD!)) {
		return context.json({ error: 'invalid_credentials' }, 401)
	}

	await context.env.DB.prepare('DELETE FROM auth_login_attempts WHERE client_key = ?').bind(clientKey).run()
	setCookie(context, sessionCookieName(context.req.url), await createSession(context.env.DB), {
		httpOnly: true,
		secure: new URL(context.req.url).protocol === 'https:',
		sameSite: 'Strict',
		path: '/',
		maxAge: sessionDurationSeconds,
	})
	return context.json({ authenticated: true })
})

app.post('/api/auth/logout', async (context) => {
	if (context.req.header('Origin') !== new URL(context.req.url).origin) {
		return context.json({ error: 'same_origin_required' }, 403)
	}
	await revokeSession(context.env.DB, getCookie(context, SESSION_COOKIE))
	await revokeSession(context.env.DB, getCookie(context, LEGACY_SESSION_COOKIE))
	const cookieOptions = {
		sameSite: 'Strict',
		path: '/',
	} as const
	if (new URL(context.req.url).protocol === 'https:') {
		deleteCookie(context, SESSION_COOKIE, { ...cookieOptions, secure: true })
	}
	deleteCookie(context, LEGACY_SESSION_COOKIE, cookieOptions)
	return context.json({ authenticated: false })
})

app.get('/api/overview', async (context) => {
	const [packages, events] = await Promise.all([
		context.env.DB.prepare('SELECT COUNT(*) AS count FROM packages').first<{ count: number }>(),
		context.env.DB.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>(),
	])

	return context.json({
		packageCount: packages?.count ?? 0,
		eventCount: events?.count ?? 0,
	})
})

app.get('/api/categories', async (context) => {
	const { results } = await context.env.DB.prepare(
		'SELECT id, key, name, overlap_allowed FROM categories ORDER BY id',
	).all<Category>()

	return context.json({ categories: results })
})

app.get('/api/products', async (context) => {
	const { results } = await context.env.DB.prepare(`
		SELECT products.id, products.category_id, categories.name AS category_name,
			products.manufacturer, products.name, products.gtin,
			products.contains_product_id, products.contains_qty
		FROM products
	JOIN categories ON categories.id = products.category_id
	ORDER BY categories.id, products.manufacturer, products.name
	`).all<Product>()

	return context.json({ products: results })
})

app.post('/api/products', async (context) => {
	const body = await context.req.json<{
		categoryId?: unknown
		manufacturer?: unknown
		name?: unknown
		gtin?: unknown
		containsProductId?: unknown
		containsQty?: unknown
	}>().catch(() => null)
	const categoryId = body?.categoryId
	const manufacturer = typeof body?.manufacturer === 'string' ? body.manufacturer.trim() : ''
	const name = typeof body?.name === 'string' ? body.name.trim() : ''
	const gtin = typeof body?.gtin === 'string' && body.gtin ? body.gtin : null
	const containsProductId = body?.containsProductId === undefined || body.containsProductId === ''
		? null
		: Number(body.containsProductId)
	const containsQty = body?.containsQty === undefined ? 1 : body.containsQty

	if (!Number.isSafeInteger(categoryId) || Number(categoryId) <= 0
		|| !manufacturer || manufacturer.length > 120
		|| !name || name.length > 160
		|| !Number.isSafeInteger(containsQty) || Number(containsQty) <= 0 || Number(containsQty) > 10000
		|| (containsProductId !== null && (!Number.isSafeInteger(containsProductId) || containsProductId <= 0))
		|| (gtin !== null && !isValidGtin(gtin))) {
		return context.json({ error: 'invalid_product' }, 400)
	}

	const category = await context.env.DB.prepare('SELECT id FROM categories WHERE id = ?')
		.bind(Number(categoryId))
		.first<{ id: number }>()
	if (!category) return context.json({ error: 'category_not_found' }, 400)
	if (containsProductId !== null) {
		const containedProduct = await context.env.DB.prepare(`
			SELECT id FROM products
			WHERE id = ? AND category_id = ? AND contains_product_id IS NULL
		`).bind(containsProductId, Number(categoryId)).first<{ id: number }>()
		if (!containedProduct) return context.json({ error: 'contained_product_not_found' }, 400)
	}
	if (gtin) {
		const existing = await context.env.DB.prepare('SELECT id FROM products WHERE gtin = ?')
			.bind(gtin)
			.first<{ id: number }>()
		if (existing) return context.json({ error: 'gtin_already_exists' }, 409)
	}

	try {
		const product = await context.env.DB.prepare(`
			INSERT INTO products (category_id, manufacturer, name, gtin, contains_product_id, contains_qty, origin)
			VALUES (?, ?, ?, ?, ?, ?, 'custom')
			RETURNING id, category_id, manufacturer, name, gtin, contains_product_id, contains_qty
		`).bind(Number(categoryId), manufacturer, name, gtin, containsProductId, Number(containsQty)).first<{
			id: number
			category_id: number
			manufacturer: string
			name: string
			gtin: string | null
			contains_product_id: number | null
			contains_qty: number | null
		}>()
		if (!product) return context.json({ error: 'product_unavailable' }, 503)
		return context.json({ product }, 201)
	} catch {
		return context.json({ error: 'product_unavailable' }, 503)
	}
})

app.post('/api/receipts', async (context) => {
	const body = await context.req.json<{
		productId?: unknown
		lot?: unknown
		serial?: unknown
		expiry?: unknown
		rawBarcode?: unknown
		receivedOn?: unknown
	}>().catch(() => null)
	const productId = body?.productId
	const lot = typeof body?.lot === 'string' && body.lot ? body.lot : null
	const serial = typeof body?.serial === 'string' && body.serial ? body.serial : null
	const expiry = typeof body?.expiry === 'string' && body.expiry ? body.expiry : null
	const rawBarcode = typeof body?.rawBarcode === 'string' && body.rawBarcode ? body.rawBarcode : null
	const receivedOn = typeof body?.receivedOn === 'string' ? body.receivedOn : ''

	if (!Number.isSafeInteger(productId) || Number(productId) <= 0
		|| (lot !== null && lot.length > 120)
		|| (serial !== null && serial.length > 120)
		|| (expiry !== null && !isIsoDate(expiry))
		|| (rawBarcode !== null && rawBarcode.length > 1024)
		|| !isIsoDate(receivedOn)) {
		return context.json({ error: 'invalid_receipt' }, 400)
	}

	const product = await context.env.DB.prepare('SELECT id FROM products WHERE id = ?')
		.bind(Number(productId))
		.first<{ id: number }>()
	if (!product) return context.json({ error: 'product_not_found' }, 404)

	await context.env.DB.batch([
		context.env.DB.prepare(`
			INSERT INTO packages (product_id, lot, serial, expiry, raw_barcode, implicit)
			VALUES (?, ?, ?, ?, ?, 0)
		`).bind(Number(productId), lot, serial, expiry, rawBarcode),
		context.env.DB.prepare(`
			INSERT INTO events (package_id, type, qty, occurred_on, recorded_at)
			VALUES (last_insert_rowid(), 'received', 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		`).bind(receivedOn),
	])
	return context.json({ received: true }, 201)
})

app.post('/api/packages/:id/open', async (context) => {
	const packageId = Number(context.req.param('id'))
	const body = await context.req.json<{ occurredOn?: unknown }>().catch(() => null)
	const occurredOn = typeof body?.occurredOn === 'string' ? body.occurredOn : ''
	if (!Number.isSafeInteger(packageId) || packageId <= 0 || !isIsoDate(occurredOn)) {
		return context.json({ error: 'invalid_open' }, 400)
	}

	const supply = await context.env.DB.prepare(`
		SELECT packages.id, packages.product_id, packages.serial, packages.expiry, products.contains_qty,
			categories.overlap_allowed,
			COALESCE((
				SELECT COALESCE(products_previous.contains_qty, 1) - (
					SELECT COUNT(*) FROM events AS started
					WHERE started.package_id = previous.id AND started.type = 'unit_started'
				)
				FROM packages AS previous
				JOIN products AS products_previous ON products_previous.id = previous.product_id
				WHERE previous.product_id = packages.product_id
					AND EXISTS (SELECT 1 FROM events AS received WHERE received.package_id = previous.id AND received.type = 'received')
					AND EXISTS (SELECT 1 FROM events AS opened WHERE opened.package_id = previous.id AND opened.type = 'opened')
				ORDER BY (SELECT MAX(opened.id) FROM events AS opened
					WHERE opened.package_id = previous.id AND opened.type = 'opened') DESC
				LIMIT 1
			), 0) AS previous_units_remaining,
			EXISTS (SELECT 1 FROM events WHERE events.package_id = packages.id AND events.type = 'received') AS is_received,
			EXISTS (SELECT 1 FROM events WHERE events.package_id = packages.id AND events.type = 'opened') AS is_open
		FROM packages
		JOIN products ON products.id = packages.product_id
		JOIN categories ON categories.id = products.category_id
		WHERE packages.id = ?
	`).bind(packageId).first<{
		id: number
		product_id: number
		serial: string | null
		expiry: string | null
		contains_qty: number | null
		overlap_allowed: number
		previous_units_remaining: number
		is_received: number
		is_open: number
	}>()
	if (!supply || !supply.is_received) return context.json({ error: 'package_not_found' }, 404)
	if (supply.is_open) return context.json({ error: 'package_already_open' }, 409)
	const activeUnit = supply.overlap_allowed ? null : await context.env.DB.prepare(`
		SELECT started.package_id, started.unit_serial, started.unit_expiry
		FROM events AS started
		JOIN packages AS active_package ON active_package.id = started.package_id
		JOIN products AS active_product ON active_product.id = active_package.product_id
		JOIN products AS target_product ON target_product.id = ?
		WHERE active_product.category_id = target_product.category_id
			AND started.type = 'unit_started'
			AND NOT EXISTS (
				SELECT 1 FROM events AS ended
				WHERE ended.package_id = started.package_id AND ended.type = 'unit_ended'
					AND (ended.occurred_on > started.occurred_on
						OR (ended.occurred_on = started.occurred_on AND ended.id > started.id))
			)
		ORDER BY started.occurred_on DESC, started.id DESC
		LIMIT 1
	`).bind(supply.product_id).first<{
		package_id: number
		unit_serial: string | null
		unit_expiry: string | null
	}>()

	const plan = planPackageOpen({
		packageId,
		occurredOn,
		previousUnitsRemaining: Math.max(0, supply.previous_units_remaining),
		overlapAllowed: Boolean(supply.overlap_allowed),
		activeUnit: activeUnit ? {
			packageId: activeUnit.package_id,
			serial: activeUnit.unit_serial ?? undefined,
			expiry: activeUnit.unit_expiry ?? undefined,
		} : undefined,
		unitExpiry: supply.expiry ?? undefined,
	})
	if (plan.kind === 'confirmation_required') {
		return context.json({ error: 'open_confirmation_required', remainingUnits: plan.remainingUnits }, 409)
	}

	await context.env.DB.batch(plan.events.map((event) => context.env.DB.prepare(`
		INSERT INTO events (package_id, type, qty, occurred_on, recorded_at, unit_serial, unit_expiry, end_reason)
		VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?)
	`).bind(
		event.packageId,
		event.type,
		event.qty,
		event.occurredOn,
		event.unitSerial ?? null,
		event.unitExpiry ?? null,
		event.endReason ?? null,
	)))
	return context.json({ opened: true, startedFirstUnit: plan.startFirstUnit }, 201)
})

app.post('/api/unit-scans', async (context) => {
	const body = await context.req.json<{
		gtin?: unknown
		lot?: unknown
		expiry?: unknown
		serial?: unknown
		rawBarcode?: unknown
		occurredOn?: unknown
	}>().catch(() => null)
	const gtin = typeof body?.gtin === 'string' ? body.gtin : ''
	const lot = typeof body?.lot === 'string' && body.lot ? body.lot : undefined
	const expiry = typeof body?.expiry === 'string' && body.expiry ? body.expiry : undefined
	const serial = typeof body?.serial === 'string' && body.serial ? body.serial : undefined
	const rawBarcode = typeof body?.rawBarcode === 'string' && body.rawBarcode ? body.rawBarcode : null
	const occurredOn = typeof body?.occurredOn === 'string' ? body.occurredOn : ''
	if (!isValidGtin(gtin) || (lot !== undefined && lot.length > 120)
		|| (expiry !== undefined && !isIsoDate(expiry)) || (serial !== undefined && serial.length > 120)
		|| (rawBarcode !== null && rawBarcode.length > 1024) || !isIsoDate(occurredOn)) {
		return context.json({ error: 'invalid_unit_scan' }, 400)
	}

	const unitProduct = await context.env.DB.prepare(`
		SELECT products.id, products.category_id, categories.overlap_allowed
		FROM products JOIN categories ON categories.id = products.category_id
		WHERE products.gtin = ?
	`).bind(gtin).first<{
		id: number
		category_id: number
		overlap_allowed: number
	}>()
	if (!unitProduct) return context.json({ error: 'unit_product_not_found' }, 404)

	const { results: candidateRows } = await context.env.DB.prepare(`
		SELECT packages.id, products.contains_product_id AS containsProductId,
			packages.lot, packages.expiry,
			(SELECT occurred_on FROM events AS received
				WHERE received.package_id = packages.id AND received.type = 'received'
				ORDER BY received.id LIMIT 1) AS receivedOn,
			MAX(0, COALESCE(products.contains_qty, 1)
				+ COALESCE((SELECT SUM(qty) FROM events AS adjusted
					WHERE adjusted.package_id = packages.id AND adjusted.type = 'adjusted'), 0)
				- COALESCE((SELECT SUM(qty) FROM events AS consumed
					WHERE consumed.package_id = packages.id AND consumed.type IN ('unit_started', 'discarded')), 0)
			) AS unitsRemaining
		FROM packages JOIN products ON products.id = packages.product_id
		WHERE products.contains_product_id = ?
			AND EXISTS (SELECT 1 FROM events AS received
				WHERE received.package_id = packages.id AND received.type = 'received')
	`).bind(unitProduct.id).all<OpenPackageCandidate>()
	const { results: usedSerialRows } = await context.env.DB.prepare(`
		SELECT unit_serial FROM events WHERE unit_serial IS NOT NULL
	`).all<{ unit_serial: string }>()
	const match = matchUnitScan({
		productId: unitProduct.id,
		gtin,
		lot,
		expiry,
		serial,
	}, candidateRows, usedSerialRows.map((event) => event.unit_serial))
	const activeUnit = unitProduct.overlap_allowed ? null : await context.env.DB.prepare(`
		SELECT started.package_id, started.unit_serial, started.unit_expiry
		FROM events AS started
		JOIN packages AS active_package ON active_package.id = started.package_id
		JOIN products AS active_product ON active_product.id = active_package.product_id
		WHERE active_product.category_id = ? AND started.type = 'unit_started'
			AND NOT EXISTS (
				SELECT 1 FROM events AS ended
				WHERE ended.package_id = started.package_id AND ended.type = 'unit_ended'
					AND (ended.occurred_on > started.occurred_on
						OR (ended.occurred_on = started.occurred_on AND ended.id > started.id))
			)
		ORDER BY started.occurred_on DESC, started.id DESC LIMIT 1
	`).bind(unitProduct.category_id).first<{
		package_id: number
		unit_serial: string | null
		unit_expiry: string | null
	}>()
	const implicitPackageId = Number.MAX_SAFE_INTEGER
	const targetPackageId = match.kind === 'matched' ? match.packageId : implicitPackageId
	const events = planUnitStart({
		packageId: targetPackageId,
		occurredOn,
		overlapAllowed: Boolean(unitProduct.overlap_allowed),
		activeUnit: activeUnit ? {
			packageId: activeUnit.package_id,
			serial: activeUnit.unit_serial ?? undefined,
			expiry: activeUnit.unit_expiry ?? undefined,
		} : undefined,
		unitSerial: serial,
		unitExpiry: expiry,
	})
	const statements: D1PreparedStatement[] = []
	for (const event of events) {
		if (match.kind === 'implicit' && event.packageId === implicitPackageId) {
			statements.push(context.env.DB.prepare(`
				INSERT INTO packages (product_id, lot, serial, expiry, raw_barcode, implicit)
				VALUES (?, ?, ?, ?, ?, 1)
			`).bind(unitProduct.id, lot ?? null, serial ?? null, expiry ?? null, rawBarcode))
			statements.push(context.env.DB.prepare(`
				INSERT INTO events (package_id, type, qty, occurred_on, recorded_at, unit_serial, unit_expiry)
				VALUES (last_insert_rowid(), 'unit_started', 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)
			`).bind(occurredOn, serial ?? null, expiry ?? null))
		} else {
			statements.push(context.env.DB.prepare(`
				INSERT INTO events (package_id, type, qty, occurred_on, recorded_at, unit_serial, unit_expiry, end_reason)
				VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?)
			`).bind(event.packageId, event.type, event.qty, event.occurredOn,
				event.unitSerial ?? null, event.unitExpiry ?? null, event.endReason ?? null))
		}
	}
	await context.env.DB.batch(statements)
	return context.json({
		started: true,
		implicit: match.kind === 'implicit',
		matchedBy: match.kind === 'matched' ? match.matchedBy : null,
		serialAlreadyUsed: match.serialAlreadyUsed,
	}, 201)
})

app.get('/api/inventory', async (context) => {
	const { results } = await context.env.DB.prepare(`
		SELECT packages.id, packages.product_id, packages.lot, packages.serial, packages.expiry,
			products.manufacturer, products.name AS product_name, products.gtin,
			products.contains_qty, categories.name AS category_name,
			MAX(0, COALESCE(products.contains_qty, 1)
				+ COALESCE((SELECT SUM(qty) FROM events AS adjusted
					WHERE adjusted.package_id = packages.id AND adjusted.type = 'adjusted'), 0)
				- COALESCE((SELECT SUM(qty) FROM events AS consumed
					WHERE consumed.package_id = packages.id AND consumed.type IN ('unit_started', 'discarded')), 0)
			) AS units_remaining,
			(SELECT occurred_on FROM events
				WHERE events.package_id = packages.id AND events.type = 'received'
				ORDER BY events.id LIMIT 1) AS received_on,
			EXISTS (SELECT 1 FROM events
				WHERE events.package_id = packages.id AND events.type = 'opened') AS is_open
		FROM packages
		JOIN products ON products.id = packages.product_id
		JOIN categories ON categories.id = products.category_id
		WHERE EXISTS (SELECT 1 FROM events
			WHERE events.package_id = packages.id AND events.type = 'received')
		ORDER BY received_on DESC, packages.id DESC
	`).all<{
		id: number
		product_id: number
		lot: string | null
		serial: string | null
		expiry: string | null
		manufacturer: string
		product_name: string
		gtin: string | null
		contains_qty: number | null
		units_remaining: number
		category_name: string
		received_on: string
		is_open: number
	}>()
	return context.json({ packages: results })
})

export default app
