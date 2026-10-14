import { describe, expect, it } from 'vitest'
import { parseGs1Barcode } from './gs1'

const gtin = '09506000134352'

describe('parseGs1Barcode', () => {
	it('parses fixed and variable fields with a group separator', () => {
		const result = parseGs1Barcode(`]d201${gtin}1728123110LOT-7\u001d21SERIAL-4`)

		expect(result).toMatchObject({
			kind: 'gs1',
			fields: {
				gtin,
				expiry: '2028-12-31',
				lot: 'LOT-7',
				serial: 'SERIAL-4',
			},
		})
	})

	it('parses a variable field boundary when a scanner omits the separator', () => {
		const result = parseGs1Barcode(`01${gtin}1728123110LOT-721SERIAL-4`)

		expect(result).toMatchObject({
			kind: 'gs1',
			fields: { lot: 'LOT-7', serial: 'SERIAL-4' },
		})
		if (result.kind === 'gs1') {
			expect(result.warnings).toHaveLength(1)
		}
	})

	it('treats expiry day 00 as the last day of the month', () => {
		expect(parseGs1Barcode(`01${gtin}17260200`)).toMatchObject({
			kind: 'gs1',
			fields: { expiry: '2026-02-28' },
		})
	})

	it('accepts a GTIN when optional fields are absent', () => {
		expect(parseGs1Barcode(`01${gtin}`)).toMatchObject({
			kind: 'gs1',
			fields: { gtin },
		})
	})

	it.each([
		['96385074', '00000096385074'],
		['036000291452', '00036000291452'],
		['4006381333931', '04006381333931'],
		[gtin, gtin],
	])('normalizes standalone GTIN %s to 14 digits', (barcode, normalizedGtin) => {
		expect(parseGs1Barcode(barcode)).toMatchObject({
			kind: 'gs1',
			fields: { gtin: normalizedGtin },
		})
	})

	it('rejects a standalone GTIN with an invalid check digit', () => {
		expect(parseGs1Barcode('036000291453')).toMatchObject({ kind: 'invalid' })
	})

	it('accepts a textual group-separator replacement', () => {
		expect(parseGs1Barcode(`01${gtin}1728123110LOT-7<GS>21SERIAL-4`)).toMatchObject({
			kind: 'gs1',
			fields: { lot: 'LOT-7', serial: 'SERIAL-4' },
		})
	})

	it('does not treat an AI-like sequence inside a separated lot as a field boundary', () => {
		expect(parseGs1Barcode(`01${gtin}10LOT21PART\u001d21SERIAL-4`)).toMatchObject({
			kind: 'gs1',
			fields: { lot: 'LOT21PART', serial: 'SERIAL-4' },
		})
	})

	it('rejects an invalid GTIN check digit', () => {
		expect(parseGs1Barcode('0109506000134353')).toMatchObject({ kind: 'invalid' })
	})

	it('returns unknown for a non-GS1 string', () => {
		expect(parseGs1Barcode('vendor-code-123')).toEqual({ kind: 'unknown', raw: 'vendor-code-123' })
	})
})