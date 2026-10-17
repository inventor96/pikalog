import { describe, expect, it } from 'vitest'
import { groupInventoryForListing, type InventoryListPackage } from './inventory-list'

function makePackage(overrides: Partial<InventoryListPackage>): InventoryListPackage {
	return {
		id: 1,
		product_id: 1,
		lot: null,
		serial: null,
		expiry: null,
		manufacturer: 'Maker',
		product_name: 'Product',
		gtin: null,
		units_remaining: 1,
		category_name: 'Care',
		received_on: '2026-01-01',
		is_open: 0,
		...overrides,
	}
}

describe('groupInventoryForListing', () => {
	it('excludes packages with no remaining units', () => {
		const grouped = groupInventoryForListing([
			makePackage({ id: 1, units_remaining: 3 }),
			makePackage({ id: 2, units_remaining: 0 }),
		], '2026-10-15')

		expect(grouped).toHaveLength(1)
		expect(grouped[0]!.boxCount).toBe(1)
		expect(grouped[0]!.products[0]!.boxes.map((box) => box.id)).toEqual([1])
	})

	it('groups by category then product and sorts each level', () => {
		const grouped = groupInventoryForListing([
			makePackage({ id: 1, category_name: 'Sensors', product_id: 2, manufacturer: 'Zeta', product_name: 'Wearable', gtin: 'G-2' }),
			makePackage({ id: 2, category_name: 'Care', product_id: 1, manufacturer: 'Acme', product_name: 'Strips', gtin: 'G-1' }),
			makePackage({ id: 3, category_name: 'Sensors', product_id: 2, manufacturer: 'Zeta', product_name: 'Wearable', gtin: 'G-2' }),
		], '2026-10-15')

		expect(grouped.map((category) => category.categoryName)).toEqual(['Care', 'Sensors'])
		expect(grouped[1]!.products[0]).toMatchObject({ groupKey: 'gtin:G-2', boxCount: 2, unitsRemaining: 2 })
	})

	it('falls back to product id for grouping when there is no GTIN', () => {
		const grouped = groupInventoryForListing([
			makePackage({ id: 1, product_id: 7, gtin: null }),
			makePackage({ id: 2, product_id: 8, gtin: null }),
		], '2026-10-15')

		expect(grouped[0]!.products.map((product) => product.groupKey)).toEqual(['product:7', 'product:8'])
	})

	it('sorts boxes by expiry with nulls last and flags expired boxes', () => {
		const grouped = groupInventoryForListing([
			makePackage({ id: 1, expiry: null }),
			makePackage({ id: 2, expiry: '2026-12-01' }),
			makePackage({ id: 3, expiry: '2026-10-01' }),
		], '2026-10-15')

		const boxes = grouped[0]!.products[0]!.boxes
		expect(boxes.map((box) => box.id)).toEqual([3, 2, 1])
		expect(boxes.map((box) => box.isExpired)).toEqual([true, false, false])
	})

	it('marks open packages and totals units across a product', () => {
		const grouped = groupInventoryForListing([
			makePackage({ id: 1, is_open: 1, units_remaining: 4 }),
			makePackage({ id: 2, is_open: 0, units_remaining: 6 }),
		], '2026-10-15')

		expect(grouped[0]!.products[0]!.unitsRemaining).toBe(10)
		expect(grouped[0]!.products[0]!.boxes[0]!.isOpen).toBe(true)
		expect(grouped[0]!.products[0]!.boxes[1]!.isOpen).toBe(false)
	})
})
