import {
	prepareZXingModule,
	readBarcodes,
	type ReaderOptions,
} from 'zxing-wasm/reader'
import readerWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

const readerOptions: ReaderOptions = {
	formats: ['DataMatrix', 'Code128'],
	maxNumberOfSymbols: 255,
	tryHarder: true,
	returnErrors: true,
}

let readerReady: Promise<unknown> | undefined

async function initializeReader(): Promise<void> {
	if (!readerReady) {
		readerReady = prepareZXingModule({
			fireImmediately: true,
			overrides: {
				locateFile: (path: string, prefix: string) => path.endsWith('.wasm') ? readerWasmUrl : `${prefix}${path}`,
			},
		})
	}

	await readerReady
}

export async function decodeBarcodeFrame(image: ImageData): Promise<string | undefined> {
	await initializeReader()
	const results = await readBarcodes(image, readerOptions)
	return results.find((result) => result.contentType === 'GS1' && result.isValid)?.text || undefined
}