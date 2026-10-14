export type LedgerEventDraft = {
	packageId: number
	type: 'opened' | 'unit_started' | 'unit_ended'
	qty: 1
	occurredOn: string
	unitSerial?: string
	unitExpiry?: string
	endReason?: 'planned'
}

export type ActiveUnit = {
	packageId: number
	serial?: string
	expiry?: string
}

export type PackageOpenInput = {
	packageId: number
	occurredOn: string
	previousUnitsRemaining: number
	startFirstUnit?: boolean
	leftoverResolution?: 'keep' | 'mark_used'
	overlapAllowed: boolean
	activeUnit?: ActiveUnit
	unitSerial?: string
	unitExpiry?: string
}

export type UnitStartInput = {
	packageId: number
	occurredOn: string
	overlapAllowed: boolean
	activeUnit?: ActiveUnit
	unitSerial?: string
	unitExpiry?: string
}

export type OpenPackageCandidate = {
	id: number
	containsProductId: number
	lot?: string
	expiry?: string
	receivedOn: string
	unitsRemaining: number
}

export type UnitScanIdentity = {
	productId: number
	gtin?: string
	lot?: string
	expiry?: string
	serial?: string
}

export type UnitPackageMatch =
	| {
			kind: 'matched'
			packageId: number
			matchedBy: 'lot_expiry' | 'expiry' | 'gtin'
			serialAlreadyUsed: boolean
	  }
	| { kind: 'implicit'; serialAlreadyUsed: boolean }

export type PackageOpenPlan =
	| {
			kind: 'confirmation_required'
			remainingUnits: number
			defaultStartFirstUnit: false
			choices: readonly ['keep', 'mark_used']
	  }
	| {
			kind: 'ready'
			startFirstUnit: boolean
			previousUnitsDisposition: 'none' | 'keep' | 'mark_used'
				previousUnitsToMarkUsed: number
			events: LedgerEventDraft[]
	  }

function isIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return false
	}
	const date = new Date(`${value}T00:00:00.000Z`)
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function validateInput(input: PackageOpenInput): void {
	if (!Number.isSafeInteger(input.packageId) || input.packageId <= 0) {
		throw new RangeError('packageId must be a positive integer')
	}
	if (!Number.isSafeInteger(input.previousUnitsRemaining) || input.previousUnitsRemaining < 0) {
		throw new RangeError('previousUnitsRemaining must be a non-negative integer')
	}
	if (!isIsoDate(input.occurredOn)) {
		throw new RangeError('occurredOn must be a valid YYYY-MM-DD date')
	}
	if (input.unitExpiry && !isIsoDate(input.unitExpiry)) {
		throw new RangeError('unitExpiry must be a valid YYYY-MM-DD date')
	}
	if (input.activeUnit) {
		if (!Number.isSafeInteger(input.activeUnit.packageId) || input.activeUnit.packageId <= 0) {
			throw new RangeError('activeUnit.packageId must be a positive integer')
		}
		if (input.activeUnit.expiry && !isIsoDate(input.activeUnit.expiry)) {
			throw new RangeError('activeUnit.expiry must be a valid YYYY-MM-DD date')
		}
	}
}

export function planUnitStart(input: UnitStartInput): LedgerEventDraft[] {
	if (!Number.isSafeInteger(input.packageId) || input.packageId <= 0) {
		throw new RangeError('packageId must be a positive integer')
	}
	if (!isIsoDate(input.occurredOn)) {
		throw new RangeError('occurredOn must be a valid YYYY-MM-DD date')
	}
	if (input.unitExpiry && !isIsoDate(input.unitExpiry)) {
		throw new RangeError('unitExpiry must be a valid YYYY-MM-DD date')
	}
	if (input.activeUnit) {
		if (!Number.isSafeInteger(input.activeUnit.packageId) || input.activeUnit.packageId <= 0) {
			throw new RangeError('activeUnit.packageId must be a positive integer')
		}
		if (input.activeUnit.expiry && !isIsoDate(input.activeUnit.expiry)) {
			throw new RangeError('activeUnit.expiry must be a valid YYYY-MM-DD date')
		}
	}

	const events: LedgerEventDraft[] = []
	if (input.activeUnit && !input.overlapAllowed) {
		events.push({
			packageId: input.activeUnit.packageId,
			type: 'unit_ended',
			qty: 1,
			occurredOn: input.occurredOn,
			unitSerial: input.activeUnit.serial,
			unitExpiry: input.activeUnit.expiry,
			endReason: 'planned',
		})
	}
	events.push({
		packageId: input.packageId,
		type: 'unit_started',
		qty: 1,
		occurredOn: input.occurredOn,
		unitSerial: input.unitSerial,
		unitExpiry: input.unitExpiry,
	})
	return events
}

function oldestPackage(packages: readonly OpenPackageCandidate[]): OpenPackageCandidate | undefined {
	return [...packages].sort(
		(first, second) => first.receivedOn.localeCompare(second.receivedOn) || first.id - second.id,
	)[0]
}

export function matchUnitScan(
	scan: UnitScanIdentity,
	packages: readonly OpenPackageCandidate[],
	usedSerials: readonly string[] = [],
): UnitPackageMatch {
	const eligible = packages.filter(
		(candidate) => candidate.containsProductId === scan.productId && candidate.unitsRemaining > 0,
	)
	const serialAlreadyUsed = Boolean(scan.serial && usedSerials.includes(scan.serial))

	if (scan.lot && scan.expiry) {
		const match = oldestPackage(eligible.filter(
			(candidate) => candidate.lot === scan.lot && candidate.expiry === scan.expiry,
		))
		if (match) return { kind: 'matched', packageId: match.id, matchedBy: 'lot_expiry', serialAlreadyUsed }
	}

	if (scan.expiry) {
		const match = oldestPackage(eligible.filter((candidate) => candidate.expiry === scan.expiry))
		if (match) return { kind: 'matched', packageId: match.id, matchedBy: 'expiry', serialAlreadyUsed }
	}

	if (scan.gtin) {
		const match = oldestPackage(eligible)
		if (match) return { kind: 'matched', packageId: match.id, matchedBy: 'gtin', serialAlreadyUsed }
	}

	return { kind: 'implicit', serialAlreadyUsed }
}

export function planPackageOpen(input: PackageOpenInput): PackageOpenPlan {
	validateInput(input)

	const startFirstUnit = input.startFirstUnit ?? input.previousUnitsRemaining <= 1
	if (startFirstUnit && input.previousUnitsRemaining > 1 && !input.leftoverResolution) {
		return {
			kind: 'confirmation_required',
			remainingUnits: input.previousUnitsRemaining,
			defaultStartFirstUnit: false,
			choices: ['keep', 'mark_used'],
		}
	}
	if ((!startFirstUnit || input.previousUnitsRemaining <= 1) && input.leftoverResolution) {
		throw new RangeError('leftoverResolution is only valid when starting with more than one unit remaining')
	}

	const events: LedgerEventDraft[] = [{ packageId: input.packageId, type: 'opened', qty: 1, occurredOn: input.occurredOn }]
	if (startFirstUnit) {
		events.push(...planUnitStart({
			packageId: input.packageId,
			occurredOn: input.occurredOn,
			overlapAllowed: input.overlapAllowed,
			activeUnit: input.activeUnit,
			unitSerial: input.unitSerial,
			unitExpiry: input.unitExpiry,
		}))
	}

	const previousUnitsDisposition = input.previousUnitsRemaining === 0
		? 'none'
		: startFirstUnit ? input.leftoverResolution ?? 'keep' : 'keep'

	return {
		kind: 'ready',
		startFirstUnit,
		previousUnitsDisposition,
		previousUnitsToMarkUsed: previousUnitsDisposition === 'mark_used' ? input.previousUnitsRemaining : 0,
		events,
	}
}