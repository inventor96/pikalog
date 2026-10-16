<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { KeyRound, LockKeyhole } from '@lucide/vue'
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser'
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()
const password = ref('')
const isConfigured = ref<boolean | null>(null)
const passkeysAvailable = ref(false)
const supportsPasskeys = ref(false)
const isChecking = ref(true)
const isSubmitting = ref(false)
const isPasskeySubmitting = ref(false)
const errorMessage = ref('')

onMounted(async () => {
	try {
		const response = await fetch('/api/auth/session', { cache: 'no-store' })
		if (!response.ok) throw new Error('Could not check the authentication setup.')
		const session = await response.json() as { configured: boolean; authenticated: boolean; passkeysAvailable: boolean }
		isConfigured.value = session.configured
		passkeysAvailable.value = session.passkeysAvailable
		supportsPasskeys.value = browserSupportsWebAuthn()
		if (session.authenticated) await router.replace({ name: 'home' })
	} catch {
		isConfigured.value = null
		errorMessage.value = 'The authentication service could not be reached.'
	} finally {
		isChecking.value = false
	}
})

function loginDestination(): string {
	const redirect = route.query.redirect
	return typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//') && redirect !== '/login'
		? redirect
		: '/'
}

async function finishSignIn() {
	await router.replace(loginDestination())
}

async function signIn() {
	if (!isConfigured.value || isSubmitting.value || isPasskeySubmitting.value) return
	isSubmitting.value = true
	errorMessage.value = ''

	try {
		const response = await fetch('/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password: password.value }),
		})
		if (response.ok) {
			await finishSignIn()
			return
		}

		if (response.status === 401) errorMessage.value = 'That password did not match.'
		else if (response.status === 429) errorMessage.value = 'Too many attempts. Wait before trying again.'
		else if (response.status === 503) errorMessage.value = 'The household password is not configured for this deployment.'
		else errorMessage.value = 'Sign-in could not be completed. Try again.'
	} catch {
		errorMessage.value = 'The authentication service could not be reached.'
	} finally {
		isSubmitting.value = false
	}
}

async function signInWithPasskey() {
	if (!isConfigured.value || !passkeysAvailable.value || !supportsPasskeys.value || isPasskeySubmitting.value) return
	isPasskeySubmitting.value = true
	errorMessage.value = ''
	try {
		const optionsResponse = await fetch('/api/auth/passkeys/login/options', { method: 'POST' })
		if (!optionsResponse.ok) {
			if (optionsResponse.status === 429) errorMessage.value = 'Too many attempts. Wait before trying again.'
			else errorMessage.value = 'Passkey sign-in is unavailable for this hostname.'
			return
		}
		const options = await optionsResponse.json() as PublicKeyCredentialRequestOptionsJSON
		const assertion = await startAuthentication({ optionsJSON: options })
		const verification = await fetch('/api/auth/passkeys/login/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ challenge: options.challenge, response: assertion }),
		})
		if (verification.ok) {
			await finishSignIn()
			return
		}
		if (verification.status === 429) errorMessage.value = 'Too many attempts. Wait before trying again.'
		else errorMessage.value = 'That passkey could not be verified. Try again or use the household password.'
	} catch (error) {
		errorMessage.value = error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')
			? 'Passkey sign-in was cancelled.'
			: 'The authentication service could not be reached.'
	} finally {
		isPasskeySubmitting.value = false
	}
}
</script>

<template>
	<main class="login-screen">
		<section class="login-panel" aria-labelledby="login-title">
			<div class="login-brand">
				<img class="login-brand-mark" src="/favicon.svg" alt="" aria-hidden="true">
				<span>pikalog</span>
			</div>
			<p class="login-eyebrow">PRIVATE WORKSPACE</p>
			<h1 id="login-title">Sign in</h1>
			<p class="login-description">Enter your household password to continue.</p>

			<div v-if="isChecking" class="login-notice" aria-live="polite">Checking workspace…</div>
			<div v-else-if="isConfigured === null" class="login-notice" role="alert">{{ errorMessage }}</div>
			<div v-else-if="!isConfigured" class="login-notice login-notice--setup" role="status">
				This deployment needs a <code>PIKALOG_PASSWORD</code> of at least 8 characters.
			</div>
			<form v-else class="login-form" @submit.prevent="signIn">
				<button
					v-if="passkeysAvailable && supportsPasskeys"
					class="login-submit login-passkey"
					type="button"
					:disabled="isPasskeySubmitting || isSubmitting"
					@click="signInWithPasskey"
				>
					<KeyRound :size="16" aria-hidden="true" />
					{{ isPasskeySubmitting ? 'Waiting for passkey…' : 'Use a passkey' }}
				</button>
				<p v-if="passkeysAvailable && supportsPasskeys" class="login-divider">OR USE YOUR PASSWORD</p>
				<label for="household-password">Household password</label>
				<div class="login-input-wrap">
					<LockKeyhole :size="17" aria-hidden="true" />
					<input
						id="household-password"
						v-model="password"
						autocomplete="current-password"
						autofocus
						aria-describedby="login-error"
						required
						type="password"
					/>
				</div>
				<p v-if="errorMessage" id="login-error" class="login-error" role="alert">{{ errorMessage }}</p>
				<button class="login-submit" type="submit" :disabled="isSubmitting || isPasskeySubmitting || !password">
					{{ isSubmitting ? 'Signing in…' : 'Continue' }}
				</button>
			</form>
			<p class="login-footnote">Your inventory stays in your Cloudflare account.</p>
		</section>
	</main>
</template>

<style scoped>
.login-screen {
	position: relative;
	display: grid;
	min-height: 100vh;
	place-items: center;
	background:
		linear-gradient(135deg, rgb(231 239 232 / 80%), transparent 48%),
		var(--color-paper);
	padding: 24px;
}

.login-panel {
	width: min(100%, 390px);
	border: 1px solid var(--color-line-strong);
	border-radius: 7px;
	background: var(--color-white);
	box-shadow: 0 14px 42px rgb(30 56 44 / 8%);
	padding: 30px;
}

.login-brand {
	display: flex;
	align-items: center;
	gap: 9px;
	color: var(--color-ink);
	font-size: 16px;
	font-weight: 700;
}

.login-brand-mark {
	display: block;
	width: 30px;
	height: 30px;
	flex: 0 0 auto;
	object-fit: contain;
}

.login-eyebrow {
	margin: 31px 0 7px;
	color: var(--color-green);
	font-family: var(--font-mono);
	font-size: 10px;
}

.login-panel h1 {
	margin: 0;
	font-size: 25px;
	font-weight: 650;
}

.login-description {
	margin: 8px 0 24px;
	color: var(--color-ink-soft);
	font-size: 13px;
}

.login-form label {
	display: block;
	margin-bottom: 7px;
	color: var(--color-ink-soft);
	font-size: 11px;
	font-weight: 600;
}

.login-input-wrap {
	display: flex;
	min-height: 43px;
	align-items: center;
	gap: 9px;
	border: 1px solid var(--color-line-strong);
	border-radius: 5px;
	padding: 0 11px;
	color: var(--color-ink-faint);
}

.login-input-wrap:focus-within {
	border-color: var(--color-green);
	box-shadow: 0 0 0 2px var(--color-green-soft);
}

.login-input-wrap input {
	width: 100%;
	min-width: 0;
	border: 0;
	outline: 0;
	background: transparent;
	color: var(--color-ink);
	font-size: 14px;
}

.login-submit {
	display: flex;
	width: 100%;
	min-height: 42px;
	align-items: center;
	justify-content: center;
	gap: 8px;
	border: 0;
	border-radius: 5px;
	margin-top: 15px;
	background: var(--color-green);
	color: white;
	font-size: 12px;
	font-weight: 650;
	cursor: pointer;
}

.login-submit:disabled {
	cursor: wait;
	opacity: 0.65;
}

.login-passkey {
	margin: 0 0 18px;
}

.login-divider {
	margin: 0 0 17px;
	color: var(--color-ink-faint);
	font-family: var(--font-mono);
	font-size: 9px;
	text-align: center;
}

.login-notice {
	border: 1px solid var(--color-line);
	border-radius: 5px;
	background: #f6f8f5;
	padding: 12px;
	color: var(--color-ink-soft);
	font-size: 12px;
	line-height: 1.55;
}

.login-notice--setup {
	border-color: #e8d9ad;
	background: #fbf7ea;
	color: #68552d;
}

.login-notice code {
	font-family: var(--font-mono);
	font-size: 10px;
}

.login-error {
	margin: 9px 0 0;
	color: #a24634;
	font-size: 11px;
}

.login-footnote {
	border-top: 1px solid var(--color-line);
	margin: 25px 0 0;
	padding-top: 14px;
	color: var(--color-ink-faint);
	font-size: 10px;
}

@media (max-width: 420px) {
	.login-panel {
		padding: 24px 20px;
	}
}
</style>