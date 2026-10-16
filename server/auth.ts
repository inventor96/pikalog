const encoder = new TextEncoder()
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000

export const SESSION_COOKIE = '__Host-pikalog_session'
export const LEGACY_SESSION_COOKIE = 'pikalog_session'

type AuthSecrets = {
	PIKALOG_PASSWORD?: string
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
	const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
	return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function isAuthConfigured(secrets: AuthSecrets): boolean {
	return Boolean(secrets.PIKALOG_PASSWORD && secrets.PIKALOG_PASSWORD.length >= 8)
}

export async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
	const [candidateDigest, expectedDigest] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
		crypto.subtle.digest('SHA-256', encoder.encode(expected)),
	])
	const candidateBytes = new Uint8Array(candidateDigest)
	const expectedBytes = new Uint8Array(expectedDigest)
	let difference = 0
	for (let index = 0; index < expectedBytes.length; index += 1) {
		difference |= candidateBytes[index]! ^ expectedBytes[index]!
	}
	return difference === 0
}

async function hashValue(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
	return toBase64Url(new Uint8Array(digest))
}

export function sessionCookieName(requestUrl: string): string {
	return new URL(requestUrl).protocol === 'https:' ? SESSION_COOKIE : LEGACY_SESSION_COOKIE
}

export async function createSession(database: D1Database, now = Date.now()): Promise<string> {
	const randomBytes = crypto.getRandomValues(new Uint8Array(32))
	const token = toBase64Url(randomBytes)
	const tokenHash = await hashValue(token)
	await database.prepare(
		'DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at <= ?',
	).bind(now, now - SESSION_IDLE_TIMEOUT_MS).run()
	await database.prepare(`
		INSERT INTO auth_sessions (token_hash, created_at, last_seen_at, expires_at)
		VALUES (?, ?, ?, ?)
	`).bind(tokenHash, now, now, now + SESSION_DURATION_MS).run()
	return token
}

export async function verifySession(database: D1Database, token: string | undefined, now = Date.now()): Promise<boolean> {
	if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false
	const tokenHash = await hashValue(token)
	const session = await database.prepare(
		'SELECT last_seen_at, expires_at FROM auth_sessions WHERE token_hash = ?',
	).bind(tokenHash).first<{ last_seen_at: number; expires_at: number }>()
	if (!session) return false

	if (session.expires_at <= now || session.last_seen_at <= now - SESSION_IDLE_TIMEOUT_MS) {
		await revokeSession(database, token)
		return false
	}

	await database.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?')
		.bind(now, tokenHash)
		.run()
	return true
}

export async function revokeSession(database: D1Database, token: string | undefined): Promise<void> {
	if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return
	const tokenHash = await hashValue(token)
	await database.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run()
}

export async function hashClientAddress(address: string): Promise<string> {
	return hashValue(address)
}

export async function hashSessionToken(token: string): Promise<string> {
	return hashValue(token)
}