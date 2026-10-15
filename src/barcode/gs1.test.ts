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

	it('parses the compact AI 01, AI 17, and AI 10 sample', () => {
		expect(parseGs1Barcode('010570524402342017271001106016216')).toMatchObject({
			kind: 'gs1',
			fields: {
				gtin: '05705244023420',
				expiry: '2027-10-01',
				lot: '6016216',
			},
			warnings: [],
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

	it('parses parenthesized human-readable AIs and product variant AI 20', () => {
		expect(parseGs1Barcode('(01)20763000413389(17)260305(10)HG8MJ2G(20)01')).toMatchObject({
			kind: 'gs1',
			fields: {
				gtin: '20763000413389',
				expiry: '2026-03-05',
				lot: 'HG8MJ2G',
				productVariant: '01',
			},
			warnings: [],
		})
	})

	it('keeps recognized fields when an internal AI 91 follows them', () => {
		expect(parseGs1Barcode('01003575998800021727043010T60004606{GS}210RW7HFKCC{GS}9178893-01')).toMatchObject({
			kind: 'gs1',
			fields: {
				gtin: '00357599880002',
				expiry: '2027-04-30',
				lot: 'T60004606',
				serial: '0RW7HFKCC',
			},
		})
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