import type { BarcodeParseResult } from '@/barcode/gs1'

function cleanProductFact(value: string): string {
	return value.trim().replace(/[\r\n]+/g, ' ').slice(0, 160) || 'Unknown'
}

export function buildCatalogSuggestionUrl(input: {
	barcode: BarcodeParseResult | null
	manufacturer: string
	productName: string
}): string | null {
	const barcode = input.barcode
	if (!barcode || barcode.kind === 'invalid') return null

	const gtin = barcode.kind === 'gs1' ? barcode.fields.gtin : undefined
	const unknownText = barcode.kind === 'unknown' ? barcode.raw.trim() : ''
	if (!gtin && !unknownText) return null

	const barcodeFact = gtin
		? `- GTIN: ${gtin}`
		: `- Unrecognized barcode text: ${JSON.stringify(unknownText.slice(0, 512))}`
	const title = gtin ? `Unknown catalog product: GTIN ${gtin}` : 'Unknown barcode format'
	const body = [
		'<!-- INSTRUCTIONS: Please fill in the following product facts. If you could attach a picture of the product and its label, that would be very helpful. -->',
		'',
		'## Product facts',
		`- Manufacturer: ${cleanProductFact(input.manufacturer)}`,
		`- Product: ${cleanProductFact(input.productName)}`,
		'',
		'## Barcode facts',
		barcodeFact,
		'',
		'<!-- No receipt dates or inventory history are included. Review unrecognized barcode text for lot, serial, or expiry details before submitting. -->',
	].join('\n')
	const issueUrl = new URL('https://github.com/inventor96/pikalog/issues/new')
	issueUrl.searchParams.set('title', title)
	issueUrl.searchParams.set('body', body)
	return issueUrl.toString()
}