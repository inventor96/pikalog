export type InventoryListPackage = {
	id: number
	product_id: number
	lot: string | null
	serial: string | null
	expiry: string | null
	manufacturer: string
	product_name: string
	gtin: string | null
	units_remaining: number
	category_name: string
	received_on: string
	is_open: number
}

export type InventoryListBox = {
	id: number
	lot: string | null
	serial: string | null
	expiry: string | null
	receivedOn: string
	unitsRemaining: number
	isOpen: boolean
	isExpired: boolean
}

export type InventoryListProduct = {
	groupKey: string
	productName: string
	manufacturer: string
	gtin: string | null
	boxCount: number
	unitsRemaining: number
	boxes: InventoryListBox[]
}

export type InventoryListCategory = {
	categoryKey: string
	categoryName: string
	boxCount: number
	unitsRemaining: number
	products: InventoryListProduct[]
}

function compareExpiry(first: string | null, second: string | null): number {
	if (first === second) return 0
	if (first === null) return 1
	if (second === null) return -1
	return first.localeCompare(second)
}

export function groupInventoryForListing(
	packages: readonly InventoryListPackage[],
	today: string,
): InventoryListCategory[] {
	const categories = new Map<string, {
		categoryKey: string
		categoryName: string
		boxCount: number
		unitsRemaining: number
		products: Map<string, InventoryListProduct>
	}>()

	for (const inventoryPackage of packages) {
		if (inventoryPackage.units_remaining <= 0) continue

		const categoryKey = `name:${inventoryPackage.category_name}`
		let category = categories.get(categoryKey)
		if (!category) {
			category = {
				categoryKey,
				categoryName: inventoryPackage.category_name,
				boxCount: 0,
				unitsRemaining: 0,
				products: new Map(),
			}
			categories.set(categoryKey, category)
		}
		category.boxCount += 1
		category.unitsRemaining += inventoryPackage.units_remaining

		const groupKey = inventoryPackage.gtin
			? `gtin:${inventoryPackage.gtin}`
			: `product:${inventoryPackage.product_id}`
		let product = category.products.get(groupKey)
		if (!product) {
			product = {
				groupKey,
				productName: inventoryPackage.product_name,
				manufacturer: inventoryPackage.manufacturer,
				gtin: inventoryPackage.gtin,
				boxCount: 0,
				unitsRemaining: 0,
				boxes: [],
			}
			category.products.set(groupKey, product)
		}
		product.boxCount += 1
		product.unitsRemaining += inventoryPackage.units_remaining
		product.boxes.push({
			id: inventoryPackage.id,
			lot: inventoryPackage.lot,
			serial: inventoryPackage.serial,
			expiry: inventoryPackage.expiry,
			receivedOn: inventoryPackage.received_on,
			unitsRemaining: inventoryPackage.units_remaining,
			isOpen: Boolean(inventoryPackage.is_open),
			isExpired: inventoryPackage.expiry !== null && inventoryPackage.expiry < today,
		})
	}

	return [...categories.values()]
		.map((category) => ({
			categoryKey: category.categoryKey,
			categoryName: category.categoryName,
			boxCount: category.boxCount,
			unitsRemaining: category.unitsRemaining,
			products: [...category.products.values()]
				.map((product) => ({
					...product,
					boxes: product.boxes.sort((first, second) =>
						compareExpiry(first.expiry, second.expiry) || first.id - second.id,
					),
				}))
				.sort((first, second) =>
					`${first.manufacturer} ${first.productName}`.localeCompare(`${second.manufacturer} ${second.productName}`),
				),
		}))
		.sort((first, second) => first.categoryName.localeCompare(second.categoryName))
}
