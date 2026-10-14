import { parseGs1Barcode, type BarcodeParseResult } from './gs1'

export type { BarcodeParseResult } from './gs1'

export function ingest(raw: string): BarcodeParseResult {
	return parseGs1Barcode(raw)
}