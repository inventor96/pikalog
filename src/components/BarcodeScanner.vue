<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { AlertCircle, Camera, Check, Keyboard, X } from '@lucide/vue'
import { decodeBarcodeFrame } from '@/barcode/decoder'
import { ingest, type BarcodeParseResult } from '@/barcode/ingest'

type ScanMode = 'receive' | 'open'

const props = defineProps<{
	initialMode?: ScanMode
}>()

const emit = defineEmits<{
	close: []
	detected: [result: BarcodeParseResult, mode: ScanMode]
}>()

const modeStorageKey = 'pikalog.scan-mode'
const scanMode = ref<ScanMode>(localStorage.getItem(modeStorageKey) === 'open' ? 'open' : 'receive')
const inputMethod = ref<'camera' | 'keyboard'>('camera')
const manualValue = ref('')
const scanResult = ref<BarcodeParseResult | null>(null)
const cameraError = ref('')
const isStarting = ref(false)
const cameraActive = ref(false)
const videoElement = ref<HTMLVideoElement | null>(null)
const dialogElement = ref<HTMLElement | null>(null)
const stream = ref<MediaStream | null>(null)

let animationFrame = 0
let lastDecodedAt = 0
let isDecoding = false

const resultTitle = computed(() => {
	if (!scanResult.value) return ''
	if (scanResult.value.kind === 'gs1') return 'GS1 code parsed'
	if (scanResult.value.kind === 'invalid') return 'Code needs review'
	return 'Unrecognized code'
})

watch(scanMode, (value) => localStorage.setItem(modeStorageKey, value))

onMounted(async () => {
	if (props.initialMode) scanMode.value = props.initialMode
	await nextTick()
	dialogElement.value?.focus()
	void startCamera()
})

onUnmounted(stopCamera)

function acceptBarcode(raw: string) {
	const result = ingest(raw)
	scanResult.value = result
	emit('detected', result, scanMode.value)
	stopCamera()
}

function submitManual() {
	const raw = manualValue.value.trim()
	if (!raw) return
	acceptBarcode(raw)
}

async function startCamera() {
	cameraError.value = ''
	isStarting.value = true

	try {
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error('Camera access is unavailable in this browser or context.')
		}

		stream.value = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				facingMode: { ideal: 'environment' },
				width: { ideal: 1280 },
				height: { ideal: 720 },
			},
		})

		if (videoElement.value) {
			videoElement.value.srcObject = stream.value
			await videoElement.value.play()
			cameraActive.value = true
			scheduleFrame()
		}
	} catch (error) {
		cameraError.value = error instanceof Error
			? error.message
			: 'Camera access could not be started.'
		stopCamera()
	} finally {
		isStarting.value = false
	}
}

function scheduleFrame() {
	animationFrame = requestAnimationFrame(() => {
		void scanFrame()
	})
}

async function scanFrame() {
	const video = videoElement.value
	if (!stream.value || !video) return
	if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
		scheduleFrame()
		return
	}

	const now = performance.now()
	if (!isDecoding && now - lastDecodedAt >= 250) {
		const canvas = document.createElement('canvas')
		canvas.width = video.videoWidth
		canvas.height = video.videoHeight
		const canvasContext = canvas.getContext('2d', { willReadFrequently: true })
		if (canvasContext && canvas.width > 0 && canvas.height > 0) {
			canvasContext.drawImage(video, 0, 0, canvas.width, canvas.height)
			const frame = canvasContext.getImageData(0, 0, canvas.width, canvas.height)
			isDecoding = true
			lastDecodedAt = now
			try {
				const raw = await decodeBarcodeFrame(frame)
				if (raw) acceptBarcode(raw)
			} catch {
				cameraError.value = 'The barcode decoder could not load. Use scanner input instead.'
				stopCamera()
			} finally {
				isDecoding = false
			}
		}
	}

	if (!scanResult.value && stream.value) scheduleFrame()
}

function stopCamera() {
	if (animationFrame) cancelAnimationFrame(animationFrame)
	animationFrame = 0
	stream.value?.getTracks().forEach((track) => track.stop())
	stream.value = null
	cameraActive.value = false
	if (videoElement.value) videoElement.value.srcObject = null
}

function closeDialog() {
	stopCamera()
	emit('close')
}
</script>

<template>
	<div class="scan-backdrop" @click.self="closeDialog" @keydown.esc.stop="closeDialog">
		<section
			ref="dialogElement"
			class="scan-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="scan-title"
			tabindex="-1"
		>
			<header class="scan-header">
				<div>
					<p class="scan-eyebrow">BARCODE INTAKE</p>
					<h2 id="scan-title">Scan supplies</h2>
				</div>
			<button class="scan-close" type="button" aria-label="Close scanner" @click="closeDialog">
				<X :size="18" aria-hidden="true" />
			</button>
			</header>

			<div class="scan-mode" role="group" aria-label="Scan action">
				<button type="button" :aria-pressed="scanMode === 'receive'" @click="scanMode = 'receive'">Receive</button>
				<button type="button" :aria-pressed="scanMode === 'open'" @click="scanMode = 'open'">Open</button>
			</div>

			<div class="scan-method" role="tablist" aria-label="Barcode input method">
				<button
					type="button"
					role="tab"
					:aria-selected="inputMethod === 'camera'"
					@click="inputMethod = 'camera'; scanResult = null"
				>
					<Camera :size="15" aria-hidden="true" /> Camera
				</button>
				<button
					type="button"
					role="tab"
					:aria-selected="inputMethod === 'keyboard'"
					@click="stopCamera(); inputMethod = 'keyboard'; scanResult = null"
				>
					<Keyboard :size="15" aria-hidden="true" /> Scanner input
				</button>
			</div>

			<div v-if="scanResult" class="scan-result" aria-live="polite">
				<div class="result-status" :class="`result-status--${scanResult.kind}`">
					<Check v-if="scanResult.kind === 'gs1'" :size="16" aria-hidden="true" />
					<AlertCircle v-else :size="16" aria-hidden="true" />
					<div>
						<strong>{{ resultTitle }}</strong>
						<span>PARSED · NOT SAVED</span>
					</div>
				</div>

				<dl v-if="scanResult.kind === 'gs1'" class="result-fields">
					<template v-for="(value, field) in scanResult.fields" :key="field">
						<dt>{{ field }}</dt>
						<dd>{{ value }}</dd>
					</template>
				</dl>
				<p v-else-if="scanResult.kind === 'invalid'" class="result-message">{{ scanResult.reason }}</p>
				<p v-else class="result-message">No supported GS1 fields were found in this code.</p>
				<ul v-if="scanResult.kind === 'gs1' && scanResult.warnings.length" class="result-warnings">
					<li v-for="warning in scanResult.warnings" :key="warning">{{ warning }}</li>
				</ul>
				<code class="result-raw">{{ scanResult.raw }}</code>
				<button class="scan-done" type="button" @click="closeDialog">Done</button>
			</div>

			<div v-else-if="inputMethod === 'camera'" class="camera-panel">
				<div class="camera-view">
					<video
						ref="videoElement"
						class="camera-video"
						:class="{ 'camera-video--hidden': !cameraActive }"
						aria-label="Live camera view"
						playsinline
						muted
					/>
					<div v-if="!cameraActive" class="camera-idle">
						<div class="camera-icon"><Camera :size="24" aria-hidden="true" /></div>
						<button class="camera-start" type="button" :disabled="isStarting" @click="startCamera">
							{{ isStarting ? 'Starting camera…' : cameraError ? 'Try camera again' : 'Start camera' }}
						</button>
					</div>
					<div v-if="cameraActive" class="scan-frame" aria-hidden="true"><span></span></div>
				</div>
				<p v-if="cameraError" class="camera-error" role="alert">{{ cameraError }}</p>
				<p v-else class="camera-caption">Position a barcode inside the frame.</p>
			</div>

			<form v-else class="keyboard-panel" @submit.prevent="submitManual">
				<label for="scanner-input">Barcode value</label>
				<div class="keyboard-entry">
					<input
						id="scanner-input"
						v-model="manualValue"
						autocomplete="off"
						spellcheck="false"
						placeholder="Scan with a wedge scanner or type code"
					/>
					<button type="submit" :disabled="!manualValue.trim()">Parse</button>
				</div>
				<p class="camera-caption">Keyboard-wedge scanners enter data into this field.</p>
			</form>

			<footer class="scan-footer">Mode: <strong>{{ scanMode === 'receive' ? 'Receive' : 'Open' }}</strong></footer>
		</section>
	</div>
</template>

<style scoped>
.scan-backdrop {
	position: fixed;
	inset: 0;
	z-index: 10;
	display: grid;
	place-items: center;
	background: rgb(24 39 34 / 48%);
	padding: 20px;
}

.scan-dialog {
	width: min(100%, 520px);
	max-height: min(90vh, 760px);
	overflow: auto;
	border: 1px solid var(--color-line-strong);
	border-radius: 8px;
	background: var(--color-paper);
	box-shadow: 0 18px 64px rgb(14 38 29 / 22%);
	padding: 24px;
}

.scan-header,
.result-status,
.keyboard-entry {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.scan-eyebrow {
	margin: 0 0 5px;
	color: var(--color-green);
	font-family: var(--font-mono);
	font-size: 10px;
}

.scan-header h2 {
	margin: 0;
	font-size: 21px;
	font-weight: 650;
}

.scan-close {
	display: grid;
	width: 36px;
	height: 36px;
	place-items: center;
	border: 1px solid var(--color-line-strong);
	border-radius: 5px;
	background: var(--color-white);
	color: var(--color-ink-soft);
	cursor: pointer;
}

.scan-mode {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 3px;
	margin-top: 22px;
	border: 1px solid var(--color-line-strong);
	border-radius: 6px;
	background: #e9ede8;
	padding: 3px;
}

.scan-mode button {
	min-height: 35px;
	border: 0;
	border-radius: 4px;
	background: transparent;
	color: var(--color-ink-soft);
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
}

.scan-mode button[aria-pressed='true'] {
	background: var(--color-white);
	box-shadow: 0 1px 3px rgb(23 55 43 / 12%);
	color: var(--color-green-dark);
}

.scan-method {
	display: flex;
	gap: 18px;
	margin-top: 23px;
	border-bottom: 1px solid var(--color-line-strong);
}

.scan-method button {
	display: inline-flex;
	min-height: 34px;
	align-items: center;
	gap: 7px;
	margin-bottom: -1px;
	border: 0;
	border-bottom: 2px solid transparent;
	background: transparent;
	color: var(--color-ink-soft);
	font-size: 12px;
	cursor: pointer;
}

.scan-method button[aria-selected='true'] {
	border-bottom-color: var(--color-green);
	color: var(--color-green-dark);
	font-weight: 650;
}

.camera-panel,
.keyboard-panel,
.scan-result {
	padding-top: 17px;
}

.camera-view {
	position: relative;
	display: grid;
	min-height: 260px;
	aspect-ratio: 4 / 3;
	overflow: hidden;
	place-items: center;
	border-radius: 5px;
	background: #1c2925;
}

.camera-video {
	width: 100%;
	height: 100%;
	object-fit: cover;
}

.camera-video--hidden {
	display: none;
}

.camera-idle {
	display: grid;
	justify-items: center;
	gap: 14px;
	color: #eef4ef;
}

.camera-icon {
	display: grid;
	width: 52px;
	height: 52px;
	place-items: center;
	border: 1px solid rgb(255 255 255 / 25%);
	border-radius: 50%;
	color: #c5d6cc;
}

.camera-start,
.keyboard-entry button,
.scan-done {
	min-height: 37px;
	border: 0;
	border-radius: 5px;
	background: var(--color-green);
	padding: 0 14px;
	color: #ffffff;
	font-size: 12px;
	font-weight: 650;
	cursor: pointer;
}

.camera-start:disabled,
.keyboard-entry button:disabled {
	cursor: wait;
	opacity: 0.6;
}

.scan-frame {
	position: absolute;
	inset: 50% auto auto 50%;
	width: min(72%, 300px);
	height: 104px;
	transform: translate(-50%, -50%);
	border: 1px solid rgb(255 255 255 / 60%);
	border-radius: 5px;
	box-shadow: 0 0 0 999px rgb(8 17 14 / 24%);
}

.scan-frame::before,
.scan-frame::after,
.scan-frame span::before,
.scan-frame span::after {
	position: absolute;
	width: 16px;
	height: 16px;
	border-color: #f0c95e;
	border-style: solid;
	content: '';
}

.scan-frame::before { inset: -1px auto auto -1px; border-width: 2px 0 0 2px; }
.scan-frame::after { inset: -1px -1px auto auto; border-width: 2px 2px 0 0; }
.scan-frame span::before { inset: auto auto -1px -1px; border-width: 0 0 2px 2px; }
.scan-frame span::after { inset: auto -1px -1px auto; border-width: 0 2px 2px 0; }

.camera-caption,
.camera-error {
	margin: 11px 0 0;
	color: var(--color-ink-soft);
	font-size: 11px;
}

.camera-error {
	color: #a24634;
}

.keyboard-panel label {
	display: block;
	margin-bottom: 7px;
	color: var(--color-ink-soft);
	font-size: 11px;
	font-weight: 600;
}

.keyboard-entry {
	gap: 8px;
}

.keyboard-entry input {
	width: 100%;
	min-width: 0;
	min-height: 39px;
	border: 1px solid var(--color-line-strong);
	border-radius: 5px;
	background: var(--color-white);
	padding: 0 10px;
	color: var(--color-ink);
	font-family: var(--font-mono);
	font-size: 11px;
}

.result-status {
	justify-content: flex-start;
	gap: 10px;
	border: 1px solid var(--color-line);
	border-radius: 5px;
	background: var(--color-white);
	padding: 11px;
	color: var(--color-green-dark);
}

.result-status--invalid {
	color: #9e4938;
}

.result-status--unknown {
	color: var(--color-ink-soft);
}

.result-status div {
	display: flex;
	flex: 1;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.result-status strong {
	font-size: 12px;
}

.result-status span {
	color: var(--color-ink-faint);
	font-family: var(--font-mono);
	font-size: 9px;
}

.result-fields {
	display: grid;
	grid-template-columns: 92px minmax(0, 1fr);
	gap: 9px 12px;
	margin: 17px 0;
}

.result-fields dt {
	color: var(--color-ink-faint);
	font-family: var(--font-mono);
	font-size: 10px;
}

.result-fields dd {
	min-width: 0;
	margin: 0;
	overflow-wrap: anywhere;
	font-size: 12px;
	font-weight: 600;
}

.result-message,
.result-warnings {
	color: var(--color-ink-soft);
	font-size: 12px;
	line-height: 1.5;
}

.result-raw {
	display: block;
	max-height: 70px;
	overflow: auto;
	border-top: 1px solid var(--color-line);
	margin-top: 15px;
	padding-top: 11px;
	color: var(--color-ink-faint);
	font-family: var(--font-mono);
	font-size: 9px;
	white-space: pre-wrap;
	word-break: break-all;
}

.scan-done {
	width: 100%;
	margin-top: 15px;
}

.scan-footer {
	border-top: 1px solid var(--color-line);
	margin-top: 20px;
	padding-top: 12px;
	color: var(--color-ink-faint);
	font-size: 10px;
}

.scan-footer strong {
	color: var(--color-ink-soft);
}

@media (max-width: 540px) {
	.scan-backdrop {
		align-items: end;
		padding: 0;
	}

	.scan-dialog {
		width: 100%;
		max-height: 92vh;
		border-radius: 10px 10px 0 0;
		padding: 20px 18px max(18px, env(safe-area-inset-bottom));
	}

	.camera-view {
		min-height: 220px;
	}

	.result-status div {
		align-items: flex-start;
		flex-direction: column;
		gap: 4px;
	}
}
</style>