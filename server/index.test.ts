import { describe, expect, it } from 'vitest'
import app from './index'

function createDatabase() {
	let attempts = 0
	let windowStartedAt = 0
	let lockLevel = 0
	let lockedUntil = 0
	const sessions = new Map<string, { last_seen_at: number; expires_at: number }>()
	return {
		sessions,
		prepare(query: string) {
			let values: unknown[] = []
			const statement = {
				bind(...parameters: unknown[]) {
					values = parameters
					return statement
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
			}
			return statement
		},
	} as unknown as D1Database & { sessions: Map<string, { last_seen_at: number; expires_at: number }> }
}

function createEnv(options: { password?: string } = {}): Env & {
	DB: D1Database & { sessions: Map<string, { last_seen_at: number; expires_at: number }> }
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
})