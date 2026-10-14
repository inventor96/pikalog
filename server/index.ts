import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
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

export default app
