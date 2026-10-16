import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readBarcodes } from 'zxing-wasm/reader'
import { decodeBarcodeFrame } from './decoder'
import { ingest } from './ingest'

vi.mock('zxing-wasm/reader', () => ({
	prepareZXingModule: vi.fn(),
	readBarcodes: vi.fn(),
}))

beforeEach(() => vi.clearAllMocks())

describe('decodeBarcodeFrame', () => {
	it('skips non-GS1 codes and finds GS1 content in the same frame', async () => {
		vi.mocked(readBarcodes).mockResolvedValue([
			{ text: '036000291453', contentType: 'Text', isValid: true },
			{ text: ']C10109506000134352', contentType: 'GS1', isValid: true },
		] as never)

		await expect(decodeBarcodeFrame({} as ImageData)).resolves.toBe(']C10109506000134352')
		expect(readBarcodes).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ formats: ['DataMatrix', 'Code128'] }),
		)
	})

	it('ignores a frame containing only non-GS1 codes', async () => {
		vi.mocked(readBarcodes).mockResolvedValue([
			{ text: '036000291453', contentType: 'Text', isValid: true },
		] as never)

		await expect(decodeBarcodeFrame({} as ImageData)).resolves.toBeUndefined()
	})

	it('does not accept invalid GS1 results', async () => {
		vi.mocked(readBarcodes).mockResolvedValue([
			{ text: ']C10109506000134352', contentType: 'GS1', isValid: false, error: 'Invalid checksum' },
		] as never)

		await expect(decodeBarcodeFrame({} as ImageData)).resolves.toBeUndefined()
	})
})

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