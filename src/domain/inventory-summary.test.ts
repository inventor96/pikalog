import { describe, expect, it } from 'vitest'
import { summarizeInventory } from './inventory-summary'

describe('summarizeInventory', () => {
	it('groups by individual-product GTIN and expands boxes into remaining items', () => {
		const summary = summarizeInventory([
			{ product_id: 1, product_name: '12-count box', manufacturer: 'Box Co', gtin: 'BOX-1', category_name: 'Care', units_remaining: 7, expiry: '2027-01-01' },
			{ product_id: 2, product_name: '6-count box', manufacturer: 'Other Box Co', gtin: 'BOX-2', category_name: 'Care', units_remaining: 4, expiry: '2026-10-14' },
			{ product_id: 3, product_name: 'Daily item', manufacturer: 'North', gtin: 'ITEM-1', category_name: 'Care', units_remaining: 2, expiry: null },
			{ product_id: 4, product_name: 'Travel item', manufacturer: 'South', gtin: 'ITEM-2', category_name: 'Care', units_remaining: 1, expiry: null },
			{ product_id: 1, product_name: '12-count box', manufacturer: 'Box Co', gtin: 'BOX-1', category_name: 'Care', units_remaining: 0, expiry: '2026-10-10' },
		], [
			{ id: 1, category_id: 10, category_name: 'Care', manufacturer: 'Box Co', name: '12-count box', gtin: 'BOX-1', contains_product_id: 3 },
			{ id: 2, category_id: 10, category_name: 'Care', manufacturer: 'Other Box Co', name: '6-count box', gtin: 'BOX-2', contains_product_id: 3 },
			{ id: 3, category_id: 10, category_name: 'Care', manufacturer: 'North', name: 'Daily item', gtin: 'ITEM-1', contains_product_id: null },
			{ id: 4, category_id: 10, category_name: 'Care', manufacturer: 'South', name: 'Travel item', gtin: 'ITEM-2', contains_product_id: null },
		], '2026-10-15')

		expect(summary).toEqual([
			{
				categoryId: 10,
				categoryName: 'Care',
				itemCount: 14,
				availableBoxCount: 4,
				pastDateUnits: 4,
				products: [
					{ groupKey: 'gtin:ITEM-1', productName: 'Daily item', manufacturer: 'North', gtin: 'ITEM-1', itemCount: 13, availableBoxCount: 3, pastDateUnits: 4 },
					{ groupKey: 'gtin:ITEM-2', productName: 'Travel item', manufacturer: 'South', gtin: 'ITEM-2', itemCount: 1, availableBoxCount: 1, pastDateUnits: 0 },
				],
			},
		])
	})

	it('groups by category name when a product is missing from the catalog', () => {
		expect(summarizeInventory([
			{ product_id: 1, product_name: 'Unknown item', manufacturer: 'Maker', gtin: null, category_name: 'Other', units_remaining: 2, expiry: '2026-10-15' },
		], [], '2026-10-15')).toMatchObject([
			{ categoryId: null, categoryName: 'Other', itemCount: 2, availableBoxCount: 1, pastDateUnits: 0 },
		])
	})

	it('counts past-date remaining units but not already-consumed units', () => {
		const summary = summarizeInventory([
			{ product_id: 1, product_name: 'Sensor pack', manufacturer: 'Maker', gtin: 'PACK-1', category_name: 'Care', units_remaining: 2, expiry: '2026-10-14' },
		], [
			{ id: 1, category_id: 10, category_name: 'Care', manufacturer: 'Maker', name: 'Sensor pack', gtin: 'PACK-1', contains_product_id: null },
		], '2026-10-15')

		expect(summary[0]).toMatchObject({ pastDateUnits: 2 })
	})
})