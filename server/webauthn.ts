import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
	type WebAuthnCredential,
} from '@simplewebauthn/server'

const CHALLENGE_TTL_MS = 5 * 60 * 1000

export type WebAuthnPurpose = 'authentication' | 'registration'

export type RelyingParty = {
	id: string
	origin: string
}

export type PasskeyCredential = {
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

export function resolveRelyingParty(requestUrl: string): RelyingParty {
	const url = new URL(requestUrl)
	const hostname = url.hostname.toLowerCase()
	if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && hostname === 'localhost'))) {
		throw new Error('Passkeys require HTTPS, except on localhost.')
	}
	return { id: hostname, origin: url.origin }
}

export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
	const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
	return new Uint8Array(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
}

async function createChallengeRecord(
	database: D1Database,
	challenge: string,
	purpose: WebAuthnPurpose,
	rpId: string,
	sessionHash: string | null,
	userId: string | null,
): Promise<void> {
	const now = Date.now()
	await database.prepare('DELETE FROM auth_webauthn_challenges WHERE expires_at <= ?').bind(now).run()
	await database.prepare(`
		INSERT INTO auth_webauthn_challenges (challenge, purpose, rp_id, session_hash, user_id, expires_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).bind(challenge, purpose, rpId, sessionHash, userId, now + CHALLENGE_TTL_MS).run()
}

export async function consumeChallenge(
	database: D1Database,
	challenge: string,
	purpose: WebAuthnPurpose,
	rpId: string,
	sessionHash: string | null,
): Promise<{ userId: string | null } | null> {
	const result = await database.prepare(`
		DELETE FROM auth_webauthn_challenges
		WHERE challenge = ? AND purpose = ? AND rp_id = ? AND expires_at > ?
			AND ((session_hash IS NULL AND ? IS NULL) OR session_hash = ?)
		RETURNING user_id
	`).bind(challenge, purpose, rpId, Date.now(), sessionHash, sessionHash).first<{ user_id: string | null }>()
	return result ? { userId: result.user_id } : null
}

async function loadCredentials(database: D1Database, rpId: string): Promise<PasskeyCredential[]> {
	const result = await database.prepare(`
		SELECT credential_id, public_key, counter, transports, user_id, label,
			device_type, backed_up, rp_id, created_at
		FROM auth_webauthn_credentials WHERE rp_id = ? ORDER BY created_at
	`).bind(rpId).all<PasskeyCredential>()
	return result.results
}

export async function listPasskeys(database: D1Database, rpId: string): Promise<Pick<PasskeyCredential, 'credential_id' | 'label' | 'created_at' | 'device_type' | 'backed_up'>[]> {
	const credentials = await loadCredentials(database, rpId)
	return credentials.map(({ credential_id, label, created_at, device_type, backed_up }) => ({
		credential_id,
		label,
		created_at,
		device_type,
		backed_up,
	}))
}

export async function generatePasskeyOptions(
	database: D1Database,
	purpose: WebAuthnPurpose,
	rpId: string,
	sessionHash: string | null = null,
): Promise<Awaited<ReturnType<typeof generateAuthenticationOptions>> | Awaited<ReturnType<typeof generateRegistrationOptions>>> {
	const credentials = await loadCredentials(database, rpId)
	if (purpose === 'authentication') {
		if (!credentials.length) throw new Error('No passkeys are registered for this hostname.')
		const options = await generateAuthenticationOptions({
			rpID: rpId,
			allowCredentials: credentials.map((credential) => ({
				id: credential.credential_id,
				transports: JSON.parse(credential.transports) as string[],
			})),
			userVerification: 'required',
		})
		await createChallengeRecord(database, options.challenge, purpose, rpId, null, null)
		return options
	}

	const userId = credentials[0]?.user_id ?? encodeBase64Url(new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`pikalog:${rpId}`)),
	))
	const options = await generateRegistrationOptions({
		rpName: 'Pikalog',
		rpID: rpId,
		userID: decodeBase64Url(userId),
		userName: 'household',
		userDisplayName: 'Pikalog household',
		attestationType: 'none',
		excludeCredentials: credentials.map((credential) => ({
			id: credential.credential_id,
			transports: JSON.parse(credential.transports) as string[],
		})),
		authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
	})
	await createChallengeRecord(database, options.challenge, purpose, rpId, sessionHash, userId)
	return options
}

export async function verifyPasskeyRegistration(
	response: RegistrationResponseJSON,
	challenge: string,
	rp: RelyingParty,
) {
	return verifyRegistrationResponse({
		response,
		expectedChallenge: challenge,
		expectedOrigin: rp.origin,
		expectedRPID: rp.id,
		requireUserVerification: true,
	})
}

export async function verifyPasskeyAuthentication(
	response: AuthenticationResponseJSON,
	challenge: string,
	rp: RelyingParty,
	credential: PasskeyCredential,
) {
	const storedCredential: WebAuthnCredential = {
		id: credential.credential_id,
		publicKey: decodeBase64Url(credential.public_key),
		counter: credential.counter,
		transports: JSON.parse(credential.transports) as WebAuthnCredential['transports'],
	}
	return verifyAuthenticationResponse({
		response,
		expectedChallenge: challenge,
		expectedOrigin: rp.origin,
		expectedRPID: rp.id,
		credential: storedCredential,
		requireUserVerification: true,
	})
}

export function isWebAuthnResponse(value: unknown): value is AuthenticationResponseJSON | RegistrationResponseJSON {
	return Boolean(value && typeof value === 'object'
		&& 'id' in value && typeof value.id === 'string'
		&& 'rawId' in value && typeof value.rawId === 'string'
		&& 'response' in value && typeof value.response === 'object' && value.response !== null)
}

export function encodePublicKey(bytes: Uint8Array): string {
	return encodeBase64Url(bytes)
}