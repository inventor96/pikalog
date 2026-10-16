import { describe, expect, it } from 'vitest'
import {
	createSession,
	hashClientAddress,
	isAuthConfigured,
	passwordMatches,
	revokeSession,
	verifySession,
} from './auth'
import { decodeBase64Url, encodeBase64Url, resolveRelyingParty } from './webauthn'

function createSessionDatabase() {
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
					if (query.includes('INSERT INTO auth_sessions')) {
						sessions.set(String(values[0]), {
							last_seen_at: Number(values[2]),
							expires_at: Number(values[3]),
						})
					} else if (query.includes('UPDATE auth_sessions SET last_seen_at')) {
						const session = sessions.get(String(values[1]))
						if (session) session.last_seen_at = Number(values[0])
					} else if (query.includes('DELETE FROM auth_sessions WHERE token_hash')) {
						sessions.delete(String(values[0]))
					} else if (query.includes('DELETE FROM auth_sessions WHERE expires_at')) {
						for (const [hash, session] of sessions) {
							if (session.expires_at <= Number(values[0]) || session.last_seen_at <= Number(values[1])) {
								sessions.delete(hash)
							}
						}
					}
					return { success: true }
				},
				async first<T>() {
					return (sessions.get(String(values[0])) ?? null) as T | null
				},
			}
			return statement
		},
	} as unknown as D1Database & { sessions: Map<string, { last_seen_at: number; expires_at: number }> }
}

describe('worker authentication helpers', () => {
	it('requires a household password of at least 8 characters', () => {
		expect(isAuthConfigured({})).toBe(false)
		expect(isAuthConfigured({ PIKALOG_PASSWORD: '1234567' })).toBe(false)
		expect(isAuthConfigured({ PIKALOG_PASSWORD: '12345678' })).toBe(true)
	})

	it('matches passwords without comparing raw strings directly', async () => {
		expect(await passwordMatches('correct horse battery staple', 'correct horse battery staple')).toBe(true)
		expect(await passwordMatches('wrong password', 'correct horse battery staple')).toBe(false)
	})

	it('stores only a token hash and revokes sessions immediately', async () => {
		const now = Date.UTC(2026, 9, 13)
		const database = createSessionDatabase()
		const token = await createSession(database, now)

		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect([...database.sessions.keys()][0]).not.toBe(token)
		expect(await verifySession(database, token, now + 1000)).toBe(true)
		await revokeSession(database, token)
		expect(await verifySession(database, token, now + 2000)).toBe(false)
	})

	it('expires sessions after 30 minutes idle or 12 hours absolute', async () => {
		const now = Date.UTC(2026, 9, 13)
		const idleDatabase = createSessionDatabase()
		const idleToken = await createSession(idleDatabase, now)
		expect(await verifySession(idleDatabase, idleToken, now + 30 * 60 * 1000)).toBe(false)

		const absoluteDatabase = createSessionDatabase()
		const absoluteToken = await createSession(absoluteDatabase, now)
		expect(await verifySession(absoluteDatabase, absoluteToken, now + 12 * 60 * 60 * 1000)).toBe(false)
	})

	it('creates a keyed, deterministic client address identifier', async () => {
		const first = await hashClientAddress('192.0.2.1')
		expect(await hashClientAddress('192.0.2.1')).toBe(first)
		expect(await hashClientAddress('192.0.2.2')).not.toBe(first)
	})

	it('resolves passkeys to the exact secure hostname, with localhost for development', () => {
		expect(resolveRelyingParty('https://supplies.example.com:8443/login')).toEqual({
			id: 'supplies.example.com',
			origin: 'https://supplies.example.com:8443',
		})
		expect(resolveRelyingParty('http://localhost:5173/login')).toEqual({
			id: 'localhost',
			origin: 'http://localhost:5173',
		})
		expect(() => resolveRelyingParty('http://supplies.example.com/login')).toThrow('Passkeys require HTTPS')
	})

	it('round-trips WebAuthn base64url byte values', () => {
		const bytes = new Uint8Array([0, 1, 127, 128, 255])
		expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes)
	})
})