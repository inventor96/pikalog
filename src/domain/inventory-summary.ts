export type InventorySummaryPackage = {
	product_id: number
	product_name: string
	manufacturer: string
	gtin: string | null
	category_name: string
	units_remaining: number
	expiry: string | null
}

export type InventorySummaryProductInfo = {
	id: number
	category_id: number
	category_name: string
	manufacturer: string
	name: string
	gtin: string | null
	contains_product_id: number | null
}

export type InventoryProductSummary = {
	groupKey: string
	productName: string
	manufacturer: string
	gtin: string | null
	itemCount: number
	availableBoxCount: number
	pastDateUnits: number
}

export type InventoryCategorySummary = {
	categoryId: number | null
	categoryName: string
	itemCount: number
	availableBoxCount: number
	pastDateUnits: number
	products: InventoryProductSummary[]
}

export function summarizeInventory(
	packages: readonly InventorySummaryPackage[],
	products: readonly InventorySummaryProductInfo[],
	today: string,
): InventoryCategorySummary[] {
	const productById = new Map(products.map((product) => [product.id, product]))
	const containedProductIds = new Set(
		products
			.filter((product) => product.contains_product_id !== null)
			.map((product) => product.contains_product_id as number),
	)
	const categories = new Map<string, {
		categoryId: number | null
		categoryName: string
		itemCount: number
		availableBoxCount: number
		pastDateUnits: number
		products: Map<string, InventoryProductSummary>
	}>()

	for (const inventoryPackage of packages) {
		const packageProduct = productById.get(inventoryPackage.product_id)
		const containedProduct = packageProduct?.contains_product_id === null || !packageProduct
			? packageProduct
			: productById.get(packageProduct.contains_product_id)
		const product = containedProduct ?? packageProduct
		const categoryId = product?.category_id ?? null
		const categoryName = product?.category_name ?? inventoryPackage.category_name
		const categoryKey = categoryId === null ? `name:${inventoryPackage.category_name}` : `id:${categoryId}`
		let category = categories.get(categoryKey)
		if (!category) {
			category = {
				categoryId,
				categoryName,
				itemCount: 0,
				availableBoxCount: 0,
				pastDateUnits: 0,
				products: new Map(),
			}
			categories.set(categoryKey, category)
		}

		category.itemCount += inventoryPackage.units_remaining
		const pastDateUnits = inventoryPackage.expiry !== null && inventoryPackage.expiry < today
			? inventoryPackage.units_remaining
			: 0
		category.pastDateUnits += pastDateUnits
		const countsAsBox = !containedProductIds.has(inventoryPackage.product_id)
		if (countsAsBox && inventoryPackage.units_remaining > 0) category.availableBoxCount += 1

		const productGtin = product?.gtin ?? inventoryPackage.gtin
		const productId = product?.id ?? inventoryPackage.product_id
		const groupKey = productGtin ? `gtin:${productGtin}` : `product:${productId}`
		let productSummary = category.products.get(groupKey)
		if (!productSummary) {
			productSummary = {
				groupKey,
				productName: product?.name ?? inventoryPackage.product_name,
				manufacturer: product?.manufacturer ?? inventoryPackage.manufacturer,
				gtin: productGtin,
				itemCount: 0,
				availableBoxCount: 0,
				pastDateUnits: 0,
			}
			category.products.set(groupKey, productSummary)
		}
		productSummary.itemCount += inventoryPackage.units_remaining
		productSummary.pastDateUnits += pastDateUnits
		if (countsAsBox && inventoryPackage.units_remaining > 0) productSummary.availableBoxCount += 1
	}

	return [...categories.values()]
		.map((category) => ({ ...category, products: [...category.products.values()] }))
		.sort((first, second) => first.categoryName.localeCompare(second.categoryName))
		.map((category) => ({
			...category,
			products: category.products.sort((first, second) =>
				`${first.manufacturer} ${first.productName}`.localeCompare(`${second.manufacturer} ${second.productName}`),
			),
		}))
}