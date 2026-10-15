import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const directory = path.dirname(fileURLToPath(import.meta.url))
const dataFiles = ['categories.json', 'products.json', 'barcode_formats.json']
const containedProductFields = ['manufacturer', 'ratedWearDays', 'minSamples', 'expiryRule', 'expiryStrictness']
const schemaFiles = {
	'categories.json': 'categories.schema.json',
	'products.json': 'products.schema.json',
	'barcode_formats.json': 'barcode_formats.schema.json',
}
const ajv = new Ajv2020({ allErrors: true, strict: true })

async function readJson(filename) {
	return JSON.parse(await readFile(path.join(directory, filename), 'utf8'))
}

function sha256(content) {
	return createHash('sha256').update(content).digest('hex')
}

function isValidGtin(value) {
	if (!/^\d{14}$/.test(value)) return false
	let sum = 0
	for (let index = 12, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) {
		sum += Number(value[index]) * weight
	}
	return (10 - (sum % 10)) % 10 === Number(value[13])
}

function assertUnique(records, key, filename) {
	const values = records.map((record) => record[key])
	if (new Set(values).size !== values.length) throw new Error(`${filename} contains duplicate ${key} values`)
}

async function main() {
	const manifest = await readJson('manifest.json')
	const manifestValidator = ajv.compile(await readJson('manifest.schema.json'))

	const rawFiles = new Map()
	const datasets = new Map()
	for (const filename of dataFiles) {
		const raw = await readFile(path.join(directory, filename))
		const data = JSON.parse(raw.toString('utf8'))
		const validator = ajv.compile(await readJson(schemaFiles[filename]))
		if (!validator(data)) throw new Error(`${filename}: ${ajv.errorsText(validator.errors)}`)
		rawFiles.set(filename, raw)
		datasets.set(filename, data)
	}

	const categories = datasets.get('categories.json')
	const products = datasets.get('products.json')
	const barcodeFormats = datasets.get('barcode_formats.json')
	assertUnique(categories, 'key', 'categories.json')
	assertUnique(products, 'key', 'products.json')
	assertUnique(barcodeFormats, 'key', 'barcode_formats.json')
	assertUnique(products.filter((product) => product.gtin !== null), 'gtin', 'products.json')

	const categoryKeys = new Set(categories.map((category) => category.key))
	const productByKey = new Map(products.map((product) => [product.key, product]))
	for (const product of products) {
		if (!categoryKeys.has(product.categoryKey)) throw new Error(`product ${product.key} references an unknown category`)
		if (product.gtin !== null && !isValidGtin(product.gtin)) throw new Error(`product ${product.key} has an invalid GTIN check digit`)
		if (product.containsProductKey !== null) {
			const contained = productByKey.get(product.containsProductKey)
			if (!contained || contained.categoryKey !== product.categoryKey || contained.containsProductKey !== null) {
				throw new Error(`product ${product.key} has an invalid contained-product reference`)
			}
			for (const field of containedProductFields) {
				if (product[field] !== contained[field]) {
					throw new Error(`product ${product.key} has a ${field} mismatch with contained product ${contained.key}`)
				}
			}
		}
	}
	for (const format of barcodeFormats) {
		if (!productByKey.has(format.productKey)) throw new Error(`barcode format ${format.key} references an unknown product`)
		try {
			new RegExp(format.pattern)
		} catch {
			throw new Error(`barcode format ${format.key} has an invalid regular expression`)
		}
	}

	if (process.argv.includes('--update-checksums')) {
		manifest.files = Object.fromEntries(dataFiles.map((filename) => [filename, sha256(rawFiles.get(filename))]))
		await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`)
	} else {
		for (const filename of dataFiles) {
			const actual = sha256(rawFiles.get(filename))
			if (manifest.files[filename] !== actual) throw new Error(`manifest checksum mismatch for ${filename}`)
		}
	}
	if (!manifestValidator(manifest)) {
		throw new Error(`manifest.json: ${ajv.errorsText(manifestValidator.errors)}`)
	}
	if (manifest.schemaVersion > 1) throw new Error('catalog schemaVersion is newer than this app supports')
	console.log(`Catalog ${manifest.version} validated (${products.length} products, ${barcodeFormats.length} barcode formats).`)
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})