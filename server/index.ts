import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
	matchUnitScan,
	planPackageOpen,
	planUnitStart,
	type LedgerEventDraft,
	type OpenPackageCandidate,
} from '../src/domain/ledger'
import { calculateSupplyForecast, type ForecastEvent } from '../src/domain/forecast'
import { estimateProjectedReceipts } from '../src/domain/receipts'
import { syncCatalog } from './catalog-sync'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { calculateDurationStatistics, type DurationLedgerEvent } from '../src/domain/statistics'
import {
	createSession,
	hashClientAddress,
	hashSessionToken,
	isAuthConfigured,
	LEGACY_SESSION_COOKIE,
	passwordMatches,
	SESSION_COOKIE,
	revokeSession,
	sessionCookieName,
	verifySession,
} from './auth'
import {
	consumeChallenge,
	encodePublicKey,
	generatePasskeyOptions,
	isWebAuthnResponse,
	listPasskeys,
	resolveRelyingParty,
	verifyPasskeyAuthentication,
	verifyPasskeyRegistration,
	type PasskeyCredential,
} from './webauthn'

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
	rated_wear_days: number | null
	min_samples: number
	expiry_rule: 'finish_by' | 'start_by' | 'none'
	expiry_strictness: 'hard' | 'soft'
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

type PackageOpeningState = {
	id: number
	product_id: number
	serial: string | null
	expiry: string | null
	contains_qty: number | null
	overlap_allowed: number
	previous_package_id: number | null
	previous_units_remaining: number
	is_received: number
	is_open: number
}

async function loadPackageOpeningState(db: D1Database, packageId: number): Promise<PackageOpeningState | null> {
	return db.prepare(`
		SELECT packages.id, packages.product_id, packages.serial, packages.expiry, products.contains_qty,
			categories.overlap_allowed,
			(SELECT previous.id
				FROM packages AS previous
				WHERE previous.product_id = packages.product_id
					AND EXISTS (SELECT 1 FROM events AS received WHERE received.package_id = previous.id AND received.type = 'received')
					AND EXISTS (SELECT 1 FROM events AS opened WHERE opened.package_id = previous.id AND opened.type = 'opened')
				ORDER BY (SELECT MAX(opened.id) FROM events AS opened
					WHERE opened.package_id = previous.id AND opened.type = 'opened') DESC
				LIMIT 1) AS previous_package_id,
			COALESCE((
				SELECT MAX(0, COALESCE(products_previous.contains_qty, 1)
					+ COALESCE((SELECT SUM(qty) FROM events AS adjusted
						WHERE adjusted.package_id = previous.id AND adjusted.type = 'adjusted'), 0)
					- COALESCE((SELECT SUM(qty) FROM events AS consumed
						WHERE consumed.package_id = previous.id AND consumed.type IN ('unit_started', 'discarded')), 0))
				FROM packages AS previous
				JOIN effective_products AS products_previous ON products_previous.id = previous.product_id
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
		JOIN effective_products AS products ON products.id = packages.product_id
		JOIN effective_categories AS categories ON categories.id = products.category_id
		WHERE packages.id = ?
	`).bind(packageId).first<PackageOpeningState>()
}

async function loadActiveUnit(db: D1Database, productId: number): Promise<{
	package_id: number
	unit_serial: string | null
	unit_expiry: string | null
} | null> {
	return db.prepare(`
		SELECT started.package_id, started.unit_serial, started.unit_expiry
		FROM events AS started
		JOIN packages AS active_package ON active_package.id = started.package_id
		JOIN effective_products AS active_product ON active_product.id = active_package.product_id
		JOIN effective_products AS target_product ON target_product.id = ?
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
	`).bind(productId).first<{
	package_id: number
	unit_serial: string | null
	unit_expiry: string | null
}>()
}

async function writeLedgerEvents(db: D1Database, events: readonly LedgerEventDraft[]): Promise<void> {
	await db.batch(events.map((event) => db.prepare(`
		INSERT INTO events (package_id, type, qty, occurred_on, recorded_at, unit_serial, unit_expiry, inferred, end_reason)
		VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?, ?)
	`).bind(
		event.packageId,
		event.type,
		event.qty,
		event.occurredOn,
		event.unitSerial ?? null,
		event.unitExpiry ?? null,
		event.inferred ? 1 : 0,
		event.endReason ?? null,
	)))
}

const app = new Hono<{ Bindings: Env }>()

const publicApiPaths = new Set([
	'/api/health',
	'/api/auth/session',
	'/api/auth/login',
	'/api/auth/passkeys/login/options',
	'/api/auth/passkeys/login/verify',
	'/api/auth/logout',
])
const attemptWindowMs = 10 * 60 * 1000
const maxLoginAttempts = 8
const initialLoginCooldownMs = 5 * 60 * 1000
const maxLoginCooldownMs = 60 * 60 * 1000
const sessionDurationSeconds = 12 * 60 * 60

async function recordLoginAttempt(database: D1Database, clientKey: string, now: number): Promise<{
	retryAfterSeconds?: number
	unavailable?: boolean
}> {
	await database.prepare('DELETE FROM auth_login_attempts WHERE window_started_at < ?')
		.bind(now - 24 * 60 * 60 * 1000)
		.run()
	const lock = await database.prepare(
		'SELECT lock_level, locked_until FROM auth_login_attempts WHERE client_key = ?',
	).bind(clientKey).first<{ lock_level: number; locked_until: number }>()
	if (lock?.locked_until && lock.locked_until > now) {
		return { retryAfterSeconds: Math.ceil((lock.locked_until - now) / 1000) }
	}
	if (lock?.locked_until) {
		await database.prepare(`
			UPDATE auth_login_attempts
			SET attempts = 0, window_started_at = ?, locked_until = 0
			WHERE client_key = ?
		`).bind(now, clientKey).run()
	}
	const attempt = await database.prepare(`
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
	`).bind(clientKey, now, now - attemptWindowMs, now - attemptWindowMs).first<{ attempts: number }>()
	if (!attempt) return { unavailable: true }
	if (attempt.attempts <= maxLoginAttempts) return {}
	const lockLevel = lock?.lock_level ?? 0
	const cooldown = Math.min(initialLoginCooldownMs * 2 ** lockLevel, maxLoginCooldownMs)
	await database.prepare(`
		UPDATE auth_login_attempts
		SET lock_level = lock_level + 1, locked_until = ?
		WHERE client_key = ?
	`).bind(now + cooldown, clientKey).run()
	return { retryAfterSeconds: Math.ceil(cooldown / 1000) }
}

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
	let passkeysAvailable = false
	try {
		const relyingParty = resolveRelyingParty(context.req.url)
		const passkeys = await context.env.DB.prepare(
			'SELECT COUNT(*) AS count FROM auth_webauthn_credentials WHERE rp_id = ?',
		).bind(relyingParty.id).first<{ count: number }>()
		passkeysAvailable = (passkeys?.count ?? 0) > 0
	} catch {
		passkeysAvailable = false
	}
	return context.json({ configured, authenticated, passkeysAvailable })
})

app.post('/api/auth/passkeys/login/options', async (context) => {
	if (!isAuthConfigured(context.env)) return context.json({ error: 'authentication_not_configured' }, 503)
	if (context.req.header('Origin') !== new URL(context.req.url).origin) {
		return context.json({ error: 'same_origin_required' }, 403)
	}
	let relyingParty
	try {
		relyingParty = resolveRelyingParty(context.req.url)
	} catch {
		return context.json({ error: 'passkeys_require_secure_context' }, 400)
	}
	const clientAddress = context.req.header('CF-Connecting-IP') ?? 'unknown'
	const clientKey = `passkey:${await hashClientAddress(clientAddress)}`
	const attempt = await recordLoginAttempt(context.env.DB, clientKey, Date.now())
	if (attempt.unavailable) return context.json({ error: 'authentication_unavailable' }, 503)
	if (attempt.retryAfterSeconds) {
		context.header('Retry-After', String(attempt.retryAfterSeconds))
		return context.json({ error: 'too_many_attempts' }, 429)
	}
	if (!(await listPasskeys(context.env.DB, relyingParty.id)).length) {
		return context.json({ error: 'no_passkeys_registered' }, 404)
	}
	const options = await generatePasskeyOptions(context.env.DB, 'authentication', relyingParty.id)
	return context.json(options)
})

app.post('/api/auth/passkeys/login/verify', async (context) => {
	if (!isAuthConfigured(context.env)) return context.json({ error: 'authentication_not_configured' }, 503)
	if (context.req.header('Origin') !== new URL(context.req.url).origin) {
		return context.json({ error: 'same_origin_required' }, 403)
	}
	const body = await context.req.json<{ challenge?: unknown; response?: unknown }>().catch(() => null)
	if (!body || typeof body.challenge !== 'string' || body.challenge.length > 128 || !isWebAuthnResponse(body.response)) {
		return context.json({ error: 'invalid_request' }, 400)
	}
	let relyingParty
	try {
		relyingParty = resolveRelyingParty(context.req.url)
	} catch {
		return context.json({ error: 'passkeys_require_secure_context' }, 400)
	}
	const challenge = await consumeChallenge(context.env.DB, body.challenge, 'authentication', relyingParty.id, null)
	if (!challenge) return context.json({ error: 'invalid_or_expired_challenge' }, 401)
	const response = body.response as AuthenticationResponseJSON
	const credential = await context.env.DB.prepare(`
		SELECT credential_id, public_key, counter, transports, user_id, label,
			device_type, backed_up, rp_id, created_at
		FROM auth_webauthn_credentials WHERE credential_id = ? AND rp_id = ?
	`).bind(response.id, relyingParty.id).first<PasskeyCredential>()
	if (!credential) return context.json({ error: 'invalid_credentials' }, 401)
	let verification
	try {
		verification = await verifyPasskeyAuthentication(response, body.challenge, relyingParty, credential)
	} catch {
		return context.json({ error: 'invalid_credentials' }, 401)
	}
	if (!verification.verified) return context.json({ error: 'invalid_credentials' }, 401)
	await context.env.DB.prepare(`
		UPDATE auth_webauthn_credentials
		SET counter = ?, device_type = ?, backed_up = ?
		WHERE credential_id = ? AND rp_id = ?
	`).bind(
		verification.authenticationInfo.newCounter,
		verification.authenticationInfo.credentialDeviceType,
		verification.authenticationInfo.credentialBackedUp ? 1 : 0,
		credential.credential_id,
		relyingParty.id,
	).run()
	const clientKey = `passkey:${await hashClientAddress(context.req.header('CF-Connecting-IP') ?? 'unknown')}`
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

app.get('/api/auth/passkeys', async (context) => {
	let relyingParty
	try {
		relyingParty = resolveRelyingParty(context.req.url)
	} catch {
		return context.json({ error: 'passkeys_require_secure_context' }, 400)
	}
	return context.json({ passkeys: await listPasskeys(context.env.DB, relyingParty.id) })
})

app.post('/api/auth/passkeys/register/options', async (context) => {
	const body = await context.req.json<{ password?: unknown }>().catch(() => null)
	if (!body || typeof body.password !== 'string' || body.password.length > 1024) {
		return context.json({ error: 'invalid_request' }, 400)
	}
	const clientKey = `passkey:${await hashClientAddress(context.req.header('CF-Connecting-IP') ?? 'unknown')}`
	const attempt = await recordLoginAttempt(context.env.DB, clientKey, Date.now())
	if (attempt.unavailable) return context.json({ error: 'authentication_unavailable' }, 503)
	if (attempt.retryAfterSeconds) {
		context.header('Retry-After', String(attempt.retryAfterSeconds))
		return context.json({ error: 'too_many_attempts' }, 429)
	}
	if (!await passwordMatches(body.password, context.env.PIKALOG_PASSWORD!)) {
		return context.json({ error: 'invalid_credentials' }, 401)
	}
	await context.env.DB.prepare('DELETE FROM auth_login_attempts WHERE client_key = ?').bind(clientKey).run()
	const sessionToken = getCookie(context, sessionCookieName(context.req.url))
	if (!sessionToken) return context.json({ error: 'authentication_required' }, 401)
	let relyingParty
	try {
		relyingParty = resolveRelyingParty(context.req.url)
	} catch {
		return context.json({ error: 'passkeys_require_secure_context' }, 400)
	}
	const options = await generatePasskeyOptions(
		context.env.DB,
		'registration',
		relyingParty.id,
		await hashSessionToken(sessionToken),
	)
	return context.json(options)
})

app.post('/api/auth/passkeys/register/verify', async (context) => {
	const body = await context.req.json<{ challenge?: unknown; label?: unknown; response?: unknown }>().catch(() => null)
	if (!body || typeof body.challenge !== 'string' || body.challenge.length > 128 || !isWebAuthnResponse(body.response)
		|| (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 80))) {
		return context.json({ error: 'invalid_request' }, 400)
	}
	const sessionToken = getCookie(context, sessionCookieName(context.req.url))
	if (!sessionToken) return context.json({ error: 'authentication_required' }, 401)
	let relyingParty
	try {
		relyingParty = resolveRelyingParty(context.req.url)
	} catch {
		return context.json({ error: 'passkeys_require_secure_context' }, 400)
	}
	const challenge = await consumeChallenge(
		context.env.DB,
		body.challenge,
		'registration',
		relyingParty.id,
		await hashSessionToken(sessionToken),
	)
	if (!challenge?.userId) return context.json({ error: 'invalid_or_expired_challenge' }, 401)
	let verification
	try {
		verification = await verifyPasskeyRegistration(body.response as RegistrationResponseJSON, body.challenge, relyingParty)
	} catch {
		return context.json({ error: 'invalid_credential' }, 400)
	}
	if (!verification.verified) return context.json({ error: 'invalid_credential' }, 400)
	const registration = verification.registrationInfo
	const credential = registration.credential
	const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Passkey'
	try {
		await context.env.DB.prepare(`
			INSERT INTO auth_webauthn_credentials
				(credential_id, public_key, counter, transports, user_id, label, device_type, backed_up, rp_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			credential.id,
			encodePublicKey(credential.publicKey),
			credential.counter,
			JSON.stringify(credential.transports ?? []),
			challenge.userId,
			label,
			registration.credentialDeviceType,
			registration.credentialBackedUp ? 1 : 0,
			relyingParty.id,
			Date.now(),
		).run()
	} catch {
		return context.json({ error: 'credential_already_registered' }, 409)
	}
	return context.json({ added: true })
})

app.delete('/api/auth/passkeys/:credentialId', async (context) => {
	let relyingParty
	try {
		relyingParty = resolveRelyingParty(context.req.url)
	} catch {
		return context.json({ error: 'passkeys_require_secure_context' }, 400)
	}
	const credentialId = context.req.param('credentialId')
	if (!/^[A-Za-z0-9_-]{1,1024}$/.test(credentialId)) return context.json({ error: 'invalid_request' }, 400)
	await context.env.DB.prepare(
		'DELETE FROM auth_webauthn_credentials WHERE credential_id = ? AND rp_id = ?',
	).bind(credentialId, relyingParty.id).run()
	return context.json({ removed: true })
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

app.get('/api/activity', async (context) => {
	const { results } = await context.env.DB.prepare(`
		SELECT events.id, events.package_id AS packageId, events.type, events.qty,
			events.occurred_on AS occurredOn, events.unit_serial AS unitSerial,
			events.unit_expiry AS unitExpiry, events.inferred, events.end_reason AS endReason,
			COALESCE(unit_products.id, products.id) AS productId,
			COALESCE(unit_products.name, products.name) AS productName,
			categories.id AS categoryId, categories.name AS categoryName,
			categories.overlap_allowed AS overlapAllowed
		FROM events
		JOIN packages ON packages.id = events.package_id
		JOIN effective_products AS products ON products.id = packages.product_id
		LEFT JOIN effective_products AS unit_products ON unit_products.id = products.contains_product_id
		JOIN effective_categories AS categories ON categories.id = products.category_id
		ORDER BY events.occurred_on, events.id
	`).all<DurationLedgerEvent & {
		packageId: number
		qty: number
		unitSerial: string | null
		unitExpiry: string | null
		categoryName: string
	}>()
	const durationEvents = results.filter(
		(event): event is typeof event & { type: 'unit_started' | 'unit_ended' } =>
			event.type === 'unit_started' || event.type === 'unit_ended',
	)
	return context.json({
		events: results.slice(-30).reverse(),
		durationStats: calculateDurationStatistics(durationEvents),
	})
})

app.get('/api/settings', async (context) => {
	const setting = await context.env.DB.prepare('SELECT value FROM settings WHERE key = ?')
		.bind('include_projected_receipts')
		.first<{ value: string }>()
	return context.json({ includeProjectedReceipts: setting?.value !== 'false' })
})

app.put('/api/settings', async (context) => {
	const body = await context.req.json<{ includeProjectedReceipts?: unknown }>().catch(() => null)
	if (typeof body?.includeProjectedReceipts !== 'boolean') {
		return context.json({ error: 'invalid_settings' }, 400)
	}
	const value = String(body.includeProjectedReceipts)
	await context.env.DB.prepare(`
		INSERT INTO settings (key, value) VALUES ('include_projected_receipts', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
	`).bind(value).run()
	return context.json({ includeProjectedReceipts: body.includeProjectedReceipts })
})

app.get('/api/catalog/status', async (context) => {
	const state = await context.env.DB.prepare(`
		SELECT version, last_synced_at, last_status, last_error
		FROM catalog_sync_state WHERE id = 1
	`).first<{
		version: string | null
		last_synced_at: string | null
		last_status: string | null
		last_error: string | null
	}>()
	return context.json({
		version: state?.version ?? null,
		lastSyncedAt: state?.last_synced_at ?? null,
		status: state?.last_status ?? 'not_synced',
		lastError: state?.last_error ?? null,
	})
})

app.post('/api/catalog/sync', async (context) => {
	try {
		return context.json(await syncCatalog(context.env.DB, context.env.CATALOG_BASE_URL))
	} catch {
		return context.json({ error: 'catalog_sync_failed' }, 502)
	}
})

app.get('/api/forecast', async (context) => {
	const requestedToday = context.req.query('today') ?? ''
	const today = isIsoDate(requestedToday) ? requestedToday : new Date().toISOString().slice(0, 10)
	const [productRows, packageRows, eventRows, projectionSetting] = await Promise.all([
		context.env.DB.prepare(`
			SELECT products.id, products.category_id, categories.name AS category_name,
				products.name, products.contains_product_id, products.rated_wear_days,
				products.min_samples, products.expiry_rule, products.expiry_strictness
			FROM effective_products AS products
			JOIN effective_categories AS categories ON categories.id = products.category_id
		`).all<{
			id: number
			category_id: number
			category_name: string
			name: string
			contains_product_id: number | null
			rated_wear_days: number | null
			min_samples: number
			expiry_rule: 'finish_by' | 'start_by' | 'none'
			expiry_strictness: 'hard' | 'soft'
		}>(),
		context.env.DB.prepare(`
			SELECT packages.id, packages.product_id, packages.expiry,
				products.contains_product_id, products.contains_qty,
				COALESCE(products.contains_qty, 1) AS units_received,
				MAX(0, COALESCE(products.contains_qty, 1)
					+ COALESCE((SELECT SUM(qty) FROM events AS adjusted
						WHERE adjusted.package_id = packages.id AND adjusted.type = 'adjusted'), 0)
					- COALESCE((SELECT SUM(qty) FROM events AS consumed
						WHERE consumed.package_id = packages.id AND consumed.type IN ('unit_started', 'discarded')), 0)
				) AS units_remaining,
				(SELECT occurred_on FROM events
					WHERE events.package_id = packages.id AND events.type = 'received'
					ORDER BY events.id LIMIT 1) AS received_on
			FROM packages
			JOIN effective_products AS products ON products.id = packages.product_id
			WHERE EXISTS (SELECT 1 FROM events
				WHERE events.package_id = packages.id AND events.type = 'received')
		`).all<{
			id: number
			product_id: number
			expiry: string | null
			contains_product_id: number | null
			contains_qty: number | null
			units_remaining: number
			units_received: number
			received_on: string
		}>(),
		context.env.DB.prepare(`
			SELECT events.id, events.package_id AS packageId, events.type,
				events.occurred_on AS occurredOn, events.unit_expiry AS unitExpiry,
				events.inferred, events.end_reason AS endReason,
			COALESCE(unit_products.id, products.id) AS productId,
			COALESCE(unit_products.name, products.name) AS productName,
			categories.id AS categoryId, categories.name AS categoryName,
			categories.overlap_allowed AS overlapAllowed
			FROM events
			JOIN packages ON packages.id = events.package_id
			JOIN effective_products AS products ON products.id = packages.product_id
			LEFT JOIN effective_products AS unit_products ON unit_products.id = products.contains_product_id
			JOIN effective_categories AS categories ON categories.id = products.category_id
			ORDER BY events.occurred_on, events.id
		`).all<ForecastEvent & { productName: string }>(),
		context.env.DB.prepare('SELECT value FROM settings WHERE key = ?')
			.bind('include_projected_receipts')
			.first<{ value: string }>(),
	])
	const products = productRows.results.map((product) => ({
		id: product.id,
		categoryId: product.category_id,
		categoryName: product.category_name,
		name: product.name,
		containsProductId: product.contains_product_id,
		ratedWearDays: product.rated_wear_days,
		minSamples: product.min_samples,
		expiryRule: product.expiry_rule,
		expiryStrictness: product.expiry_strictness,
	}))
	const packages = packageRows.results.map((inventoryPackage) => ({
		id: inventoryPackage.id,
		productId: inventoryPackage.product_id,
		expiry: inventoryPackage.expiry,
		receivedOn: inventoryPackage.received_on,
		unitsRemaining: inventoryPackage.units_remaining,
	}))
	const productById = new Map(products.map((product) => [product.id, product]))
	const includeProjectedReceipts = projectionSetting?.value !== 'false'
	const receiptHistory = packageRows.results.flatMap((inventoryPackage) => {
		const packageProduct = productById.get(inventoryPackage.product_id)
		const unitProduct = packageProduct?.containsProductId === null
			? packageProduct
			: packageProduct?.containsProductId === undefined
				? undefined
				: productById.get(packageProduct.containsProductId)
		return unitProduct ? [{
			productId: unitProduct.id,
			receivedOn: inventoryPackage.received_on,
			expiry: inventoryPackage.expiry,
			quantity: inventoryPackage.units_received,
		}] : []
	})
	const projectedReceipts = includeProjectedReceipts
		? estimateProjectedReceipts(receiptHistory, today)
		: []
	const durationEvents = eventRows.results.filter(
		(event): event is typeof event & { type: 'unit_started' | 'unit_ended' } =>
			event.type === 'unit_started' || event.type === 'unit_ended',
	)
	const durationStatistics = calculateDurationStatistics(durationEvents)
	return context.json({
		today,
		includeProjectedReceipts,
		categories: calculateSupplyForecast({
			today,
			products,
			packages,
			events: durationEvents as ForecastEvent[],
			durationStatistics,
			projectedReceipts,
		}),
	})
})

app.get('/api/categories', async (context) => {
	const includeHidden = context.req.query('includeHidden') === 'true'
	const { results } = await context.env.DB.prepare(`
		SELECT id, key, name, overlap_allowed, origin, hidden,
			COALESCE((SELECT group_concat(field, ',') FROM category_overrides WHERE category_id = effective_categories.id), '') AS overridden_fields
		FROM effective_categories
		WHERE (? = 1 OR hidden = 0)
		ORDER BY id
	`).bind(Number(includeHidden)).all<Category & { origin: 'catalog' | 'custom'; hidden: number; overridden_fields: string }>()

	return context.json({ categories: results })
})

app.post('/api/categories', async (context) => {
	const body = await context.req.json<{ key?: unknown; name?: unknown; overlapAllowed?: unknown }>().catch(() => null)
	const key = typeof body?.key === 'string' ? body.key.trim() : ''
	const name = typeof body?.name === 'string' ? body.name.trim() : ''
	if (!/^[a-z][a-z0-9_]{1,63}$/.test(key) || !name || name.length > 100
		|| (body?.overlapAllowed !== undefined && typeof body.overlapAllowed !== 'boolean')) {
		return context.json({ error: 'invalid_category' }, 400)
	}
	try {
		const category = await context.env.DB.prepare(`
			INSERT INTO categories (key, name, overlap_allowed, origin)
			VALUES (?, ?, ?, 'custom')
			RETURNING id
		`).bind(key, name, Number(body?.overlapAllowed ?? false)).first<{ id: number }>()
		return context.json({ category }, 201)
	} catch {
		return context.json({ error: 'category_key_already_exists' }, 409)
	}
})

app.patch('/api/categories/:id', async (context) => {
	const id = Number(context.req.param('id'))
	const body = await context.req.json<{
		name?: unknown
		overlapAllowed?: unknown
		hidden?: unknown
	}>().catch(() => null)
	if (!Number.isSafeInteger(id) || id <= 0 || !body
		|| (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100))
		|| (body.overlapAllowed !== undefined && typeof body.overlapAllowed !== 'boolean')
		|| (body.hidden !== undefined && typeof body.hidden !== 'boolean')
		|| (body.name === undefined && body.overlapAllowed === undefined && body.hidden === undefined)) {
		return context.json({ error: 'invalid_category' }, 400)
	}
	const category = await context.env.DB.prepare('SELECT id, name, overlap_allowed, origin FROM categories WHERE id = ?')
		.bind(id).first<{ id: number; name: string; overlap_allowed: number; origin: 'catalog' | 'custom' }>()
	if (!category) return context.json({ error: 'category_not_found' }, 404)
	const statements: D1PreparedStatement[] = []
	if (body.hidden !== undefined) statements.push(context.env.DB.prepare('UPDATE categories SET hidden = ? WHERE id = ?').bind(Number(body.hidden), id))
	if (body.name !== undefined) {
		const name = (body.name as string).trim()
		if (category.origin === 'custom') statements.push(context.env.DB.prepare('UPDATE categories SET name = ? WHERE id = ?').bind(name, id))
		else if (name === category.name) statements.push(context.env.DB.prepare("DELETE FROM category_overrides WHERE category_id = ? AND field = 'name'").bind(id))
		else statements.push(context.env.DB.prepare(`
			INSERT INTO category_overrides (category_id, field, value) VALUES (?, 'name', ?)
			ON CONFLICT(category_id, field) DO UPDATE SET value = excluded.value
		`).bind(id, name))
	}
	if (body.overlapAllowed !== undefined) {
		const overlapAllowed = Number(body.overlapAllowed)
		if (category.origin === 'custom') statements.push(context.env.DB.prepare('UPDATE categories SET overlap_allowed = ? WHERE id = ?').bind(overlapAllowed, id))
		else if (overlapAllowed === category.overlap_allowed) statements.push(context.env.DB.prepare("DELETE FROM category_overrides WHERE category_id = ? AND field = 'overlap_allowed'").bind(id))
		else statements.push(context.env.DB.prepare(`
			INSERT INTO category_overrides (category_id, field, value) VALUES (?, 'overlap_allowed', ?)
			ON CONFLICT(category_id, field) DO UPDATE SET value = excluded.value
		`).bind(id, String(overlapAllowed)))
	}
	await context.env.DB.batch(statements)
	return context.json({ updated: true })
})

app.post('/api/categories/:id/reset-overrides', async (context) => {
	const id = Number(context.req.param('id'))
	const category = await context.env.DB.prepare('SELECT origin FROM categories WHERE id = ?')
		.bind(id).first<{ origin: 'catalog' | 'custom' }>()
	if (!category) return context.json({ error: 'category_not_found' }, 404)
	if (category.origin !== 'catalog') return context.json({ error: 'custom_category_has_no_overrides' }, 409)
	await context.env.DB.prepare('DELETE FROM category_overrides WHERE category_id = ?').bind(id).run()
	return context.json({ reset: true })
})

app.delete('/api/categories/:id', async (context) => {
	const id = Number(context.req.param('id'))
	const category = await context.env.DB.prepare('SELECT origin FROM categories WHERE id = ?')
		.bind(id).first<{ origin: 'catalog' | 'custom' }>()
	if (!category) return context.json({ error: 'category_not_found' }, 404)
	if (category.origin !== 'custom') return context.json({ error: 'official_category_cannot_be_deleted' }, 409)
	const inUse = await context.env.DB.prepare('SELECT id FROM effective_products WHERE category_id = ? LIMIT 1')
		.bind(id).first<{ id: number }>()
	if (inUse) return context.json({ error: 'category_in_use' }, 409)
	await context.env.DB.batch([
		context.env.DB.prepare('DELETE FROM category_overrides WHERE category_id = ?').bind(id),
		context.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id),
	])
	return context.json({ deleted: true })
})

app.get('/api/products', async (context) => {
	const includeHidden = context.req.query('includeHidden') === 'true'
	const { results } = await context.env.DB.prepare(`
		SELECT products.id, products.category_id, categories.name AS category_name,
			products.manufacturer, products.name, products.gtin,
			products.contains_product_id, products.contains_qty, products.rated_wear_days,
			products.min_samples, products.expiry_rule, products.expiry_strictness,
			products.origin, products.hidden,
			COALESCE((SELECT group_concat(field, ',') FROM product_overrides WHERE product_id = products.id), '') AS overridden_fields
		FROM effective_products AS products
		JOIN effective_categories AS categories ON categories.id = products.category_id
		WHERE (? = 1 OR (products.hidden = 0 AND categories.hidden = 0))
		ORDER BY categories.id, products.manufacturer, products.name
	`).bind(Number(includeHidden)).all<Product & { origin: 'catalog' | 'custom'; hidden: number; overridden_fields: string }>()

	return context.json({ products: results })
})

app.patch('/api/products/:id', async (context) => {
	const id = Number(context.req.param('id'))
	const body = await context.req.json<{
		categoryId?: unknown
		manufacturer?: unknown
		name?: unknown
		minSamples?: unknown
		expiryRule?: unknown
		expiryStrictness?: unknown
		hidden?: unknown
	}>().catch(() => null)
	if (!Number.isSafeInteger(id) || id <= 0 || !body
		|| (body.categoryId !== undefined && (!Number.isSafeInteger(body.categoryId) || Number(body.categoryId) <= 0))
		|| (body.manufacturer !== undefined && (typeof body.manufacturer !== 'string' || !body.manufacturer.trim() || body.manufacturer.trim().length > 120))
		|| (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 160))
		|| (body.minSamples !== undefined && (!Number.isSafeInteger(body.minSamples) || Number(body.minSamples) < 1 || Number(body.minSamples) > 100))
		|| (body.expiryRule !== undefined && !['finish_by', 'start_by', 'none'].includes(String(body.expiryRule)))
		|| (body.expiryStrictness !== undefined && !['hard', 'soft'].includes(String(body.expiryStrictness)))
		|| (body.hidden !== undefined && typeof body.hidden !== 'boolean')
		|| !['categoryId', 'manufacturer', 'name', 'minSamples', 'expiryRule', 'expiryStrictness', 'hidden'].some((field) => body[field as keyof typeof body] !== undefined)) {
		return context.json({ error: 'invalid_product' }, 400)
	}
	const product = await context.env.DB.prepare(`
		SELECT id, category_id, manufacturer, name, min_samples, expiry_rule, expiry_strictness, origin
		FROM products WHERE id = ?
	`).bind(id).first<{
		id: number
		category_id: number
		manufacturer: string
		name: string
		min_samples: number
		expiry_rule: 'finish_by' | 'start_by' | 'none'
		expiry_strictness: 'hard' | 'soft'
		origin: 'catalog' | 'custom'
	}>()
	if (!product) return context.json({ error: 'product_not_found' }, 404)
	const nextCategoryId = body.categoryId === undefined ? product.category_id : Number(body.categoryId)
	if (body.categoryId !== undefined) {
		const category = await context.env.DB.prepare('SELECT id FROM categories WHERE id = ?')
			.bind(nextCategoryId).first<{ id: number }>()
		if (!category) return context.json({ error: 'category_not_found' }, 400)
	}
	const fields: Array<[string, unknown, unknown]> = [
		['category_id', body.categoryId === undefined ? undefined : nextCategoryId, product.category_id],
		['manufacturer', body.manufacturer === undefined ? undefined : (body.manufacturer as string).trim(), product.manufacturer],
		['name', body.name === undefined ? undefined : (body.name as string).trim(), product.name],
		['min_samples', body.minSamples, product.min_samples],
		['expiry_rule', body.expiryRule, product.expiry_rule],
		['expiry_strictness', body.expiryStrictness, product.expiry_strictness],
	]
	const statements: D1PreparedStatement[] = []
	if (body.hidden !== undefined) statements.push(context.env.DB.prepare('UPDATE products SET hidden = ? WHERE id = ?').bind(Number(body.hidden), id))
	for (const [field, value, canonicalValue] of fields) {
		if (value === undefined) continue
		if (product.origin === 'custom') {
			const column = field
			statements.push(context.env.DB.prepare(`UPDATE products SET ${column} = ? WHERE id = ?`).bind(value, id))
		} else if (value === canonicalValue) {
			statements.push(context.env.DB.prepare('DELETE FROM product_overrides WHERE product_id = ? AND field = ?').bind(id, field))
		} else {
			statements.push(context.env.DB.prepare(`
				INSERT INTO product_overrides (product_id, field, value) VALUES (?, ?, ?)
				ON CONFLICT(product_id, field) DO UPDATE SET value = excluded.value
			`).bind(id, field, String(value)))
		}
	}
	await context.env.DB.batch(statements)
	return context.json({ updated: true })
})

app.post('/api/products/:id/reset-overrides', async (context) => {
	const id = Number(context.req.param('id'))
	const product = await context.env.DB.prepare('SELECT origin FROM products WHERE id = ?')
		.bind(id).first<{ origin: 'catalog' | 'custom' }>()
	if (!product) return context.json({ error: 'product_not_found' }, 404)
	if (product.origin !== 'catalog') return context.json({ error: 'custom_product_has_no_overrides' }, 409)
	await context.env.DB.prepare('DELETE FROM product_overrides WHERE product_id = ?').bind(id).run()
	return context.json({ reset: true })
})

app.delete('/api/products/:id', async (context) => {
	const id = Number(context.req.param('id'))
	const product = await context.env.DB.prepare('SELECT origin FROM products WHERE id = ?')
		.bind(id).first<{ origin: 'catalog' | 'custom' }>()
	if (!product) return context.json({ error: 'product_not_found' }, 404)
	if (product.origin !== 'custom') return context.json({ error: 'official_product_cannot_be_deleted' }, 409)
	const inUse = await context.env.DB.prepare(`
		SELECT id FROM packages WHERE product_id = ?
		UNION ALL SELECT id FROM products WHERE contains_product_id = ?
		LIMIT 1
	`).bind(id, id).first<{ id: number }>()
	if (inUse) return context.json({ error: 'product_in_use' }, 409)
	await context.env.DB.batch([
		context.env.DB.prepare('DELETE FROM product_overrides WHERE product_id = ?').bind(id),
		context.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id),
	])
	return context.json({ deleted: true })
})

app.post('/api/products', async (context) => {
	const body = await context.req.json<{
		categoryId?: unknown
		manufacturer?: unknown
		name?: unknown
		gtin?: unknown
		containsProductId?: unknown
		containsQty?: unknown
		ratedWearDays?: unknown
		minSamples?: unknown
		expiryRule?: unknown
		expiryStrictness?: unknown
	}>().catch(() => null)
	const categoryId = body?.categoryId
	const manufacturer = typeof body?.manufacturer === 'string' ? body.manufacturer.trim() : ''
	const name = typeof body?.name === 'string' ? body.name.trim() : ''
	const gtin = typeof body?.gtin === 'string' && body.gtin ? body.gtin : null
	const containsProductId = body?.containsProductId === undefined || body.containsProductId === ''
		? null
		: Number(body.containsProductId)
	const containsQty = body?.containsQty === undefined ? 1 : body.containsQty
	const ratedWearDays = body?.ratedWearDays === undefined || body.ratedWearDays === null || body.ratedWearDays === ''
		? null
		: Number(body.ratedWearDays)
	const minSamples = body?.minSamples === undefined ? 3 : body.minSamples
	const expiryRule = body?.expiryRule === undefined ? 'finish_by' : body.expiryRule
	const expiryStrictness = body?.expiryStrictness === undefined ? 'hard' : body.expiryStrictness

	if (!Number.isSafeInteger(categoryId) || Number(categoryId) <= 0
		|| !manufacturer || manufacturer.length > 120
		|| !name || name.length > 160
		|| !Number.isSafeInteger(containsQty) || Number(containsQty) <= 0 || Number(containsQty) > 10000
		|| (ratedWearDays !== null && (!Number.isSafeInteger(ratedWearDays) || ratedWearDays <= 0 || ratedWearDays > 365))
		|| !Number.isSafeInteger(minSamples) || Number(minSamples) <= 0 || Number(minSamples) > 100
		|| !['finish_by', 'start_by', 'none'].includes(String(expiryRule))
		|| !['hard', 'soft'].includes(String(expiryStrictness))
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
			SELECT id FROM effective_products
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
			INSERT INTO products (
				category_id, manufacturer, name, gtin, contains_product_id, contains_qty,
				rated_wear_days, min_samples, expiry_rule, expiry_strictness, origin
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'custom')
			RETURNING id, category_id, manufacturer, name, gtin, contains_product_id, contains_qty,
				rated_wear_days, min_samples, expiry_rule, expiry_strictness
		`).bind(
			Number(categoryId), manufacturer, name, gtin, containsProductId, Number(containsQty),
			ratedWearDays, Number(minSamples), String(expiryRule), String(expiryStrictness),
		).first<{
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
	if (serial) {
		const existingPackage = await context.env.DB.prepare(`
			SELECT id FROM packages WHERE serial = ? AND implicit = 0
		`).bind(serial).first<{ id: number }>()
		if (existingPackage) return context.json({ error: 'serial_already_received' }, 409)
	}

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
	const body = await context.req.json<{
		occurredOn?: unknown
		startFirstUnit?: unknown
		leftoverResolution?: unknown
	}>().catch(() => null)
	const occurredOn = typeof body?.occurredOn === 'string' ? body.occurredOn : ''
	const startFirstUnit = body?.startFirstUnit
	const leftoverResolution = body?.leftoverResolution
	if (!Number.isSafeInteger(packageId) || packageId <= 0 || !isIsoDate(occurredOn)
		|| (startFirstUnit !== undefined && typeof startFirstUnit !== 'boolean')
		|| (leftoverResolution !== undefined && leftoverResolution !== 'keep' && leftoverResolution !== 'mark_used')) {
		return context.json({ error: 'invalid_open' }, 400)
	}
	const supply = await loadPackageOpeningState(context.env.DB, packageId)
	if (!supply || !supply.is_received) return context.json({ error: 'package_not_found' }, 404)
	if (supply.is_open) return context.json({ error: 'package_already_open' }, 409)
	const remainingUnits = Math.max(0, supply.previous_units_remaining)
	if (startFirstUnit === undefined && remainingUnits > 1) {
		return context.json({ error: 'start_choice_required', remainingUnits }, 409)
	}
	if (leftoverResolution !== undefined && (startFirstUnit !== true || remainingUnits <= 1)) {
		return context.json({ error: 'invalid_open' }, 400)
	}
	const activeUnit = supply.overlap_allowed ? null : await loadActiveUnit(context.env.DB, supply.product_id)

	const plan = planPackageOpen({
		packageId,
		previousPackageId: supply.previous_package_id ?? undefined,
		occurredOn,
		previousUnitsRemaining: remainingUnits,
		overlapAllowed: Boolean(supply.overlap_allowed),
		startFirstUnit: startFirstUnit as boolean | undefined,
		leftoverResolution: leftoverResolution as 'keep' | 'mark_used' | undefined,
		activeUnit: activeUnit ? {
			packageId: activeUnit.package_id,
			serial: activeUnit.unit_serial ?? undefined,
			expiry: activeUnit.unit_expiry ?? undefined,
		} : undefined,
		unitExpiry: supply.expiry ?? undefined,
	})
	if (plan.kind === 'confirmation_required') {
		return context.json({ error: 'leftover_confirmation_required', remainingUnits: plan.remainingUnits }, 409)
	}

	await writeLedgerEvents(context.env.DB, plan.events)
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
		markBoxOpened?: unknown
		leftoverResolution?: unknown
	}>().catch(() => null)
	const gtin = typeof body?.gtin === 'string' ? body.gtin : ''
	const lot = typeof body?.lot === 'string' && body.lot ? body.lot : undefined
	const expiry = typeof body?.expiry === 'string' && body.expiry ? body.expiry : undefined
	const serial = typeof body?.serial === 'string' && body.serial ? body.serial : undefined
	const rawBarcode = typeof body?.rawBarcode === 'string' && body.rawBarcode ? body.rawBarcode : null
	const occurredOn = typeof body?.occurredOn === 'string' ? body.occurredOn : ''
	const markBoxOpened = body?.markBoxOpened !== false
	const leftoverResolution = body?.leftoverResolution
	if (!isValidGtin(gtin) || (lot !== undefined && lot.length > 120)
		|| (expiry !== undefined && !isIsoDate(expiry)) || (serial !== undefined && serial.length > 120)
		|| (rawBarcode !== null && rawBarcode.length > 1024) || !isIsoDate(occurredOn)
		|| (body?.markBoxOpened !== undefined && typeof body.markBoxOpened !== 'boolean')
		|| (leftoverResolution !== undefined && (!markBoxOpened
			|| (leftoverResolution !== 'keep' && leftoverResolution !== 'mark_used')))) {
		return context.json({ error: 'invalid_unit_scan' }, 400)
	}

	const unitProduct = await context.env.DB.prepare(`
		SELECT products.id, products.category_id, categories.overlap_allowed
		FROM effective_products AS products JOIN effective_categories AS categories ON categories.id = products.category_id
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
			EXISTS (SELECT 1 FROM events AS opened
				WHERE opened.package_id = packages.id AND opened.type = 'opened') AS isOpen,
			(SELECT occurred_on FROM events AS received
				WHERE received.package_id = packages.id AND received.type = 'received'
				ORDER BY received.id LIMIT 1) AS receivedOn,
			MAX(0, COALESCE(products.contains_qty, 1)
				+ COALESCE((SELECT SUM(qty) FROM events AS adjusted
					WHERE adjusted.package_id = packages.id AND adjusted.type = 'adjusted'), 0)
				- COALESCE((SELECT SUM(qty) FROM events AS consumed
					WHERE consumed.package_id = packages.id AND consumed.type IN ('unit_started', 'discarded')), 0)
			) AS unitsRemaining
		FROM packages JOIN effective_products AS products ON products.id = packages.product_id
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
	if (match.serialAlreadyUsed) return context.json({ error: 'serial_already_used' }, 409)
	if (match.kind === 'matched' && markBoxOpened) {
		const candidate = candidateRows.find((row) => row.id === match.packageId)
		if (candidate && !candidate.isOpen) {
			const supply = await loadPackageOpeningState(context.env.DB, match.packageId)
			if (!supply || !supply.is_received) return context.json({ error: 'package_not_found' }, 404)
			if (leftoverResolution !== undefined && supply.previous_units_remaining <= 1) {
				return context.json({ error: 'invalid_unit_scan' }, 400)
			}
			const activeUnit = supply.overlap_allowed ? null : await loadActiveUnit(context.env.DB, supply.product_id)
			const plan = planPackageOpen({
				packageId: match.packageId,
				previousPackageId: supply.previous_package_id ?? undefined,
				occurredOn,
				previousUnitsRemaining: Math.max(0, supply.previous_units_remaining),
				startFirstUnit: true,
				leftoverResolution: leftoverResolution as 'keep' | 'mark_used' | undefined,
				overlapAllowed: Boolean(supply.overlap_allowed),
				activeUnit: activeUnit ? {
					packageId: activeUnit.package_id,
					serial: activeUnit.unit_serial ?? undefined,
					expiry: activeUnit.unit_expiry ?? undefined,
				} : undefined,
				unitSerial: serial,
				unitExpiry: expiry,
			})
			if (plan.kind === 'confirmation_required') {
				return context.json({ error: 'leftover_confirmation_required', remainingUnits: plan.remainingUnits }, 409)
			}
			await writeLedgerEvents(context.env.DB, plan.events)
			return context.json({
				started: true,
				opened: true,
				implicit: false,
				matchedBy: match.matchedBy,
				serialAlreadyUsed: match.serialAlreadyUsed,
			}, 201)
		}
	}
	const activeUnit = unitProduct.overlap_allowed ? null : await context.env.DB.prepare(`
		SELECT started.package_id, started.unit_serial, started.unit_expiry
		FROM events AS started
		JOIN packages AS active_package ON active_package.id = started.package_id
		JOIN effective_products AS active_product ON active_product.id = active_package.product_id
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
		opened: false,
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
		JOIN effective_products AS products ON products.id = packages.product_id
		JOIN effective_categories AS categories ON categories.id = products.category_id
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

const worker = Object.assign(app, {
	scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
		context.waitUntil(syncCatalog(env.DB, env.CATALOG_BASE_URL).then(() => undefined).catch(() => undefined))
	},
})

export default worker
