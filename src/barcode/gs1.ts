const GROUP_SEPARATOR = '\u001d'
const SUPPORTED_APPLICATION_IDENTIFIERS = ['01', '10', '17', '20', '21', '91'] as const

type ApplicationIdentifier = (typeof SUPPORTED_APPLICATION_IDENTIFIERS)[number]

export type ParsedBarcodeFields = {
	gtin?: string
	expiry?: string
	lot?: string
	productVariant?: string
	serial?: string
}

export type BarcodeParseResult =
	| { kind: 'gs1'; raw: string; fields: ParsedBarcodeFields; warnings: string[] }
	| { kind: 'invalid'; raw: string; reason: string }
	| { kind: 'unknown'; raw: string }

function normalize(raw: string): string {
	return raw
		.trim()
		.replace(/^\](?:d2|C1|e0)/i, '')
		.replace(/\((01|10|17|20|21|91)\)/g, (match, identifier: string, offset: number) =>
			`${offset === 0 ? '' : GROUP_SEPARATOR}${identifier}`,
		)
		.replace(/<GS>/gi, GROUP_SEPARATOR)
		.replace(/\{GS\}/gi, GROUP_SEPARATOR)
		.replace(/\u001e/g, GROUP_SEPARATOR)
}

function applicationIdentifierAt(value: string, index: number): ApplicationIdentifier | undefined {
	const candidate = value.slice(index, index + 2)
	return SUPPORTED_APPLICATION_IDENTIFIERS.find((identifier) => identifier === candidate)
}

function hasPlausibleApplicationIdentifierValue(
	value: string,
	index: number,
	identifier: ApplicationIdentifier,
): boolean {
	const dataStart = index + identifier.length
	if (identifier === '01') return isValidGtin(value.slice(dataStart, dataStart + 14))
	if (identifier === '17') return parseExpiry(value.slice(dataStart, dataStart + 6)) !== undefined
	if (identifier === '20') return /^\d{2}$/.test(value.slice(dataStart, dataStart + 2))
	if (identifier === '10' || identifier === '21') return value.length - dataStart >= 2
	return false
}

function nextApplicationIdentifier(value: string, from: number): number {
	for (let index = from; index < value.length - 1; index += 1) {
		const identifier = applicationIdentifierAt(value, index)
		if (identifier && hasPlausibleApplicationIdentifierValue(value, index, identifier)) {
			return index
		}
	}
	return -1
}

function isValidGtin(gtin: string): boolean {
	if (!/^\d{14}$/.test(gtin)) {
		return false
	}

	let sum = 0
	for (let index = gtin.length - 2, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) {
		sum += Number(gtin[index]) * weight
	}

	return (10 - (sum % 10)) % 10 === Number(gtin.at(-1))
}

function parseExpiry(value: string): string | undefined {
	if (!/^\d{6}$/.test(value)) {
		return undefined
	}

	const year = 2000 + Number(value.slice(0, 2))
	const month = Number(value.slice(2, 4))
	const scannedDay = Number(value.slice(4, 6))
	if (month < 1 || month > 12 || scannedDay > 31) {
		return undefined
	}

	const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
	const day = scannedDay === 0 ? lastDayOfMonth : scannedDay
	const date = new Date(Date.UTC(year, month - 1, day))
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		return undefined
	}

	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function parseGs1Barcode(raw: string): BarcodeParseResult {
	const value = normalize(raw)
	if (!value) {
		return { kind: 'unknown', raw }
	}

	if (!applicationIdentifierAt(value, 0)) {
		if (!/^(?:\d{8}|\d{12,14})$/.test(value)) {
			return { kind: 'unknown', raw }
		}

		const gtin = value.padStart(14, '0')
		if (!isValidGtin(gtin)) {
			return { kind: 'invalid', raw, reason: 'The GTIN must have a valid check digit.' }
		}

		return { kind: 'gs1', raw, fields: { gtin }, warnings: [] }
	}

	const fields: ParsedBarcodeFields = {}
	const warnings: string[] = []
	let cursor = 0

	while (cursor < value.length) {
		if (value[cursor] === GROUP_SEPARATOR) {
			cursor += 1
			continue
		}

		const identifier = applicationIdentifierAt(value, cursor)
		if (!identifier) {
			return { kind: 'invalid', raw, reason: 'Unexpected data between GS1 application identifiers.' }
		}
		cursor += 2

		if (identifier === '01') {
			const gtin = value.slice(cursor, cursor + 14)
			if (!isValidGtin(gtin)) {
				return { kind: 'invalid', raw, reason: 'The GTIN must contain 14 digits and a valid check digit.' }
			}
			if (fields.gtin) {
				return { kind: 'invalid', raw, reason: 'The barcode contains more than one GTIN.' }
			}
			fields.gtin = gtin
			cursor += 14
			continue
		}

		if (identifier === '17') {
			const expiry = parseExpiry(value.slice(cursor, cursor + 6))
			if (!expiry) {
				return { kind: 'invalid', raw, reason: 'The expiry date is invalid.' }
			}
			if (fields.expiry) {
				return { kind: 'invalid', raw, reason: 'The barcode contains more than one expiry date.' }
			}
			fields.expiry = expiry
			cursor += 6
			continue
		}

		if (identifier === '20') {
			const productVariant = value.slice(cursor, cursor + 2)
			if (!/^\d{2}$/.test(productVariant)) {
				return { kind: 'invalid', raw, reason: 'Application identifier 20 has an invalid value length.' }
			}
			if (fields.productVariant !== undefined) {
				return { kind: 'invalid', raw, reason: 'The barcode contains more than one product variant.' }
			}
			fields.productVariant = productVariant
			cursor += 2
			continue
		}

		const separatorIndex = value.indexOf(GROUP_SEPARATOR, cursor)
		const nextAiIndex = nextApplicationIdentifier(value, cursor + 1)
		const valueEnd = separatorIndex >= 0
			? separatorIndex
			: identifier === '91' ? value.length
				: nextAiIndex >= 0 ? nextAiIndex : value.length
		const fieldValue = value.slice(cursor, valueEnd)
		if (fieldValue.length === 0 || fieldValue.length > (identifier === '91' ? 90 : 20)) {
			return { kind: 'invalid', raw, reason: `Application identifier ${identifier} has an invalid value length.` }
		}

		if (separatorIndex < 0 && nextAiIndex >= 0) {
			warnings.push('A variable-length field was separated by a recognized AI without a group separator; verify the parsed value.')
		}

		if (identifier === '10') {
			if (fields.lot !== undefined) {
				return { kind: 'invalid', raw, reason: 'The barcode contains more than one lot number.' }
			}
			fields.lot = fieldValue
		} else if (identifier === '21') {
			if (fields.serial !== undefined) {
				return { kind: 'invalid', raw, reason: 'The barcode contains more than one serial number.' }
			}
			fields.serial = fieldValue
		}
		cursor = valueEnd
	}

	if (!fields.gtin && !fields.expiry && !fields.lot && !fields.serial) {
		return { kind: 'unknown', raw }
	}

	return { kind: 'gs1', raw, fields, warnings }
}