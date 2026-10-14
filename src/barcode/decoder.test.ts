import { describe, expect, it } from 'vitest'
import { ingest } from './ingest'

describe('ingest', () => {
	it('uses the same parser for camera and keyboard input strings', () => {
		const cameraText = '01095060001343521728123110LOT-7\u001d21SERIAL-4'
		const keyboardText = `]d2${cameraText}`
		const cameraResult = ingest(cameraText)
		const keyboardResult = ingest(keyboardText)

		expect(cameraResult.kind).toBe('gs1')
		expect(keyboardResult.kind).toBe('gs1')
		if (cameraResult.kind === 'gs1' && keyboardResult.kind === 'gs1') {
			expect(cameraResult.fields).toEqual(keyboardResult.fields)
		}
	})
})