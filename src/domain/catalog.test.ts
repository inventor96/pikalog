import { describe, expect, it } from 'vitest'
import { validateCatalogBundle } from './catalog'

const manifest = {
	version: '2026.10.14',
	schemaVersion: 1,
	files: {
		'categories.json': 'a'.repeat(64),
		'products.json': 'b'.repeat(64),
		'barcode_formats.json': 'c'.repeat(64),
	},
}

const category = { key: 'cgm_sensor', name: 'CGM sensor', overlapAllowed: false }
const product = {
	key: 'acme.sensor',
	categoryKey: 'cgm_sensor',
	manufacturer: 'Acme',
	name: 'Sensor',
	gtin: '00036000291452',
	containsProductKey: null,
	containsQty: 1,
	ratedWearDays: 10,
	minSamples: 3,
	expiryRule: 'finish_by',
	expiryStrictness: 'hard',
	sourceUrl: 'https://example.com/instructions',
	verified: false,
}

describe('validateCatalogBundle', () => {
	it('accepts a structurally sound bundle with sourced products', () => {
		const result = validateCatalogBundle({
			manifest,
			categories: [category],
			products: [product],
			barcodeFormats: [],
		})

		expect(result.products[0]?.key).toBe('acme.sensor')
	})

	it('rejects unsupported schema versions before accepting data', () => {
		expect(() => validateCatalogBundle({
			manifest: { ...manifest, schemaVersion: 2 },
			categories: [category],
			products: [],
			barcodeFormats: [],
		})).toThrow('catalog_schema_unsupported')
	})

	it('rejects bad GTINs and unresolved product or category references', () => {
		expect(() => validateCatalogBundle({
			manifest,
			categories: [category],
			products: [{ ...product, gtin: '00036000291453' }],
			barcodeFormats: [],
		})).toThrow('invalid_catalog_product')
		expect(() => validateCatalogBundle({
			manifest,
			categories: [category],
			products: [{ ...product, categoryKey: 'missing' }],
			barcodeFormats: [],
		})).toThrow('unknown_catalog_category')
	})

	it('rejects nested packs and invalid barcode regular expressions', () => {
		const nested = { ...product, key: 'acme.inner', gtin: null, containsProductKey: 'acme.sensor', containsQty: 2 }
		expect(() => validateCatalogBundle({
			manifest,
			categories: [category],
			products: [{ ...product, containsProductKey: 'acme.inner' }, nested],
			barcodeFormats: [],
		})).toThrow('invalid_catalog_containment')
		expect(() => validateCatalogBundle({
			manifest,
			categories: [category],
			products: [product],
			barcodeFormats: [{
				key: 'broken', productKey: product.key, pattern: '(', fields: { gtin: 'gtin' },
				sourceUrl: 'https://example.com/barcode', verified: false,
			}],
		})).toThrow('invalid_catalog_barcode_pattern')
	})

	it('allows package-specific identifiers and provenance to differ from the contained product', () => {
		const packageProduct = {
			...product,
			key: 'acme.sensor.pack',
			name: 'Sensor 5-pack',
			gtin: null,
			containsProductKey: product.key,
			containsQty: 5,
			sourceUrl: 'https://example.com/package',
			verified: true,
		}

		expect(() => validateCatalogBundle({
			manifest,
			categories: [category],
			products: [product, packageProduct],
			barcodeFormats: [],
		})).not.toThrow()
	})

	it.each([
		['manufacturer', { manufacturer: 'Other' }],
		['ratedWearDays', { ratedWearDays: null }],
		['minSamples', { minSamples: 4 }],
		['expiryRule', { expiryRule: 'start_by' }],
		['expiryStrictness', { expiryStrictness: 'soft' }],
	] as const)('rejects package when %s differs from contained product', (_field, mismatch) => {
		const packageProduct = {
			...product,
			key: 'acme.sensor.pack',
			name: 'Sensor 5-pack',
			gtin: null,
			containsProductKey: product.key,
			containsQty: 5,
			...mismatch,
		}

		expect(() => validateCatalogBundle({
			manifest,
			categories: [category],
			products: [product, packageProduct],
			barcodeFormats: [],
		})).toThrow('catalog_product_mismatch')
	})
})