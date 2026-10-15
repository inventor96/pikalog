export type CatalogCategory = {
	key: string
	name: string
	overlapAllowed: boolean
}

export type CatalogProduct = {
	key: string
	categoryKey: string
	manufacturer: string
	name: string
	gtin: string | null
	containsProductKey: string | null
	containsQty: number | null
	ratedWearDays: number | null
	minSamples: number
	expiryRule: 'finish_by' | 'start_by' | 'none'
	expiryStrictness: 'hard' | 'soft'
	sourceUrl: string
	verified: boolean
}

export type CatalogBarcodeFormat = {
	key: string
	productKey: string
	pattern: string
	fields: Record<string, 'gtin' | 'expiry' | 'lot' | 'serial'>
	sourceUrl: string
	verified: boolean
}

export type CatalogManifest = {
	version: string
	schemaVersion: number
	files: Record<'categories.json' | 'products.json' | 'barcode_formats.json', string>
}

export type CatalogBundle = {
	manifest: CatalogManifest
	categories: CatalogCategory[]
	products: CatalogProduct[]
	barcodeFormats: CatalogBarcodeFormat[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown, maxLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isNullableInteger(value: unknown, minimum: number, maximum: number): value is number | null {
	return value === null || (Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum)
}

function isValidGtin(value: string): boolean {
	if (!/^\d{14}$/.test(value)) return false
	let sum = 0
	for (let index = 12, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) {
		sum += Number(value[index]) * weight
	}
	return (10 - (sum % 10)) % 10 === Number(value[13])
}

function isSourceUrl(value: unknown): value is string {
	if (!isString(value, 2048)) return false
	try {
		const url = new URL(value)
		return url.protocol === 'https:' || url.protocol === 'http:'
	} catch {
		return false
	}
}

export function validateCatalogBundle(input: {
	manifest: unknown
	categories: unknown
	products: unknown
	barcodeFormats: unknown
}): CatalogBundle {
	const manifest = input.manifest
	if (!isRecord(manifest)
		|| typeof manifest.version !== 'string'
		|| !/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(manifest.version)
		|| !Number.isSafeInteger(manifest.schemaVersion)
		|| Number(manifest.schemaVersion) < 1
		|| !isRecord(manifest.files)) {
		throw new Error('invalid_catalog_manifest')
	}
	if (Number(manifest.schemaVersion) > 1) throw new Error('catalog_schema_unsupported')
	const filenames = ['categories.json', 'products.json', 'barcode_formats.json'] as const
	for (const filename of filenames) {
		if (typeof manifest.files[filename] !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.files[filename] as string)) {
			throw new Error('invalid_catalog_manifest')
		}
	}
	if (!Array.isArray(input.categories) || !Array.isArray(input.products) || !Array.isArray(input.barcodeFormats)) {
		throw new Error('invalid_catalog_files')
	}

	const categories: CatalogCategory[] = input.categories.map((category) => {
		if (!isRecord(category)
			|| !isString(category.key, 64)
			|| !/^[a-z][a-z0-9_]{1,63}$/.test(category.key)
			|| !isString(category.name, 100)
			|| typeof category.overlapAllowed !== 'boolean') throw new Error('invalid_catalog_category')
		return { key: category.key, name: category.name, overlapAllowed: category.overlapAllowed }
	})
	const categoryKeys = new Set(categories.map((category) => category.key))
	if (categoryKeys.size !== categories.length) throw new Error('duplicate_catalog_category')

	const products: CatalogProduct[] = input.products.map((product) => {
		if (!isRecord(product)
			|| !isString(product.key, 100)
			|| !/^[a-z0-9][a-z0-9._-]{1,99}$/.test(product.key)
			|| !isString(product.categoryKey, 64)
			|| !isString(product.manufacturer, 120)
			|| !isString(product.name, 160)
			|| !(product.gtin === null || (isString(product.gtin, 14) && isValidGtin(product.gtin)))
			|| !(product.containsProductKey === null || isString(product.containsProductKey, 100))
			|| !isNullableInteger(product.containsQty, 1, 10000)
			|| !isNullableInteger(product.ratedWearDays, 1, 365)
			|| !Number.isSafeInteger(product.minSamples)
			|| Number(product.minSamples) < 1 || Number(product.minSamples) > 100
			|| !['finish_by', 'start_by', 'none'].includes(String(product.expiryRule))
			|| !['hard', 'soft'].includes(String(product.expiryStrictness))
			|| !isSourceUrl(product.sourceUrl)
			|| typeof product.verified !== 'boolean'
			|| (product.containsProductKey !== null && (!Number.isSafeInteger(product.containsQty) || Number(product.containsQty) < 1))) {
			throw new Error('invalid_catalog_product')
		}
		return product as CatalogProduct
	})
	const productKeys = new Set(products.map((product) => product.key))
	const gtins = products.flatMap((product) => product.gtin === null ? [] : [product.gtin])
	if (productKeys.size !== products.length || new Set(gtins).size !== gtins.length) {
		throw new Error('duplicate_catalog_product')
	}
	const productByKey = new Map(products.map((product) => [product.key, product]))
	for (const product of products) {
		if (!categoryKeys.has(product.categoryKey)) throw new Error('unknown_catalog_category')
		if (product.containsProductKey !== null) {
			const contained = productByKey.get(product.containsProductKey)
			if (!contained || contained.categoryKey !== product.categoryKey || contained.containsProductKey !== null) {
				throw new Error('invalid_catalog_containment')
			}
			if (product.manufacturer !== contained.manufacturer
				|| product.ratedWearDays !== contained.ratedWearDays
				|| product.minSamples !== contained.minSamples
				|| product.expiryRule !== contained.expiryRule
				|| product.expiryStrictness !== contained.expiryStrictness) {
				throw new Error('catalog_product_mismatch')
			}
		}
	}

	const barcodeFormats: CatalogBarcodeFormat[] = input.barcodeFormats.map((format) => {
		if (!isRecord(format)
			|| !isString(format.key, 100)
			|| !/^[a-z0-9][a-z0-9._-]{1,99}$/.test(format.key)
			|| !isString(format.productKey, 100)
			|| !isString(format.pattern, 1000)
			|| !isRecord(format.fields)
			|| !Object.keys(format.fields).length
			|| !isSourceUrl(format.sourceUrl)
			|| typeof format.verified !== 'boolean'
			|| Object.values(format.fields).some((field) => !['gtin', 'expiry', 'lot', 'serial'].includes(String(field)))) {
			throw new Error('invalid_catalog_barcode_format')
		}
		try {
			new RegExp(format.pattern)
		} catch {
			throw new Error('invalid_catalog_barcode_pattern')
		}
		if (!productKeys.has(format.productKey)) throw new Error('unknown_catalog_barcode_product')
		return format as CatalogBarcodeFormat
	})
	if (new Set(barcodeFormats.map((format) => format.key)).size !== barcodeFormats.length) {
		throw new Error('duplicate_catalog_barcode_format')
	}

	return {
		manifest: manifest as CatalogManifest,
		categories,
		products,
		barcodeFormats,
	}
}