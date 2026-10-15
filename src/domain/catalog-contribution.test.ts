import { describe, expect, it } from 'vitest'
import { buildCatalogSuggestionUrl } from './catalog-contribution'

describe('buildCatalogSuggestionUrl', () => {
	it('includes only product facts and GTIN for an unmatched GS1 scan', () => {
		const url = buildCatalogSuggestionUrl({
			barcode: {
				kind: 'gs1',
				raw: '01:0003600029145210LOT-1',
				fields: { gtin: '00036000291452', lot: 'LOT-1', expiry: '2026-12-31', serial: 'SERIAL-1' },
				warnings: [],
			},
			manufacturer: 'Acme',
			productName: 'Sensor',
		})
		const issue = new URL(url!)
		const body = issue.searchParams.get('body')!

		expect(issue.searchParams.get('title')).toContain('00036000291452')
		expect(body).toContain('Manufacturer: Acme')
		expect(body).toContain('Product: Sensor')
		expect(body).toContain('GTIN: 00036000291452')
		expect(body).not.toContain('LOT-1')
		expect(body).not.toContain('SERIAL-1')
		expect(body).not.toContain('2026-12-31')
	})

	it('includes raw text for an unrecognized format and bounds its length', () => {
		const url = buildCatalogSuggestionUrl({
			barcode: { kind: 'unknown', raw: 'X'.repeat(600) },
			manufacturer: '',
			productName: '',
		})
		const body = new URL(url!).searchParams.get('body')!

		expect(body).toContain(`Unrecognized barcode text: ${JSON.stringify('X'.repeat(512))}`)
		expect(body).toContain('Manufacturer: Unknown')
	})

	it('does not create an issue for invalid, empty, or missing scans', () => {
		expect(buildCatalogSuggestionUrl({ barcode: null, manufacturer: '', productName: '' })).toBeNull()
		expect(buildCatalogSuggestionUrl({
			barcode: { kind: 'invalid', raw: 'bad', reason: 'invalid' },
			manufacturer: '',
			productName: '',
		})).toBeNull()
		expect(buildCatalogSuggestionUrl({
			barcode: { kind: 'unknown', raw: '' },
			manufacturer: '',
			productName: '',
		})).toBeNull()
	})
})