export type LedgerEventDraft = {
	packageId: number
	type: 'opened' | 'unit_started' | 'unit_ended' | 'discarded'
	qty: number
	occurredOn: string
	unitSerial?: string
	unitExpiry?: string
	inferred?: boolean
	endReason?: 'planned'
}

export type ActiveUnit = {
	packageId: number
	serial?: string
	expiry?: string
}

export type PackageOpenInput = {
	packageId: number
	previousPackageId?: number
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
	isOpen?: boolean
}

export type PackageScanCandidate = {
	id: number
	gtin: string | null
	lot: string | null
	serial?: string | null
	expiry: string | null
	receivedOn: string
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
			matchedBy: 'lot_expiry' | 'lot' | 'expiry' | 'gtin'
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
	if (input.previousPackageId !== undefined
		&& (!Number.isSafeInteger(input.previousPackageId) || input.previousPackageId <= 0)) {
		throw new RangeError('previousPackageId must be a positive integer')
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

export function matchPackageScan(
	scan: { gtin: string; lot?: string; serial?: string; expiry?: string },
	packages: readonly PackageScanCandidate[],
): PackageScanCandidate[] {
	const matches = packages.filter((candidate) => candidate.gtin === scan.gtin
		&& (!scan.serial || candidate.serial === scan.serial)
		&& (!scan.lot || candidate.lot === scan.lot)
		&& (!scan.expiry || candidate.expiry === scan.expiry))
	return [...matches].sort(
		(first, second) => first.receivedOn.localeCompare(second.receivedOn) || first.id - second.id,
	)
}

export function matchUnitScan(
	scan: UnitScanIdentity,
	packages: readonly OpenPackageCandidate[],
	usedSerials: readonly string[] = [],
): UnitPackageMatch {
	const eligible = packages.filter(
		(candidate) => candidate.containsProductId === scan.productId
			&& candidate.unitsRemaining > 0
			&& (!scan.lot || candidate.lot === scan.lot)
			&& (!scan.expiry || candidate.expiry === scan.expiry),
	)
	const serialAlreadyUsed = Boolean(scan.serial && usedSerials.includes(scan.serial))
	const matchedBy = scan.lot && scan.expiry ? 'lot_expiry'
		: scan.lot ? 'lot'
		: scan.expiry ? 'expiry'
		: scan.gtin ? 'gtin'
		: null
	if (matchedBy) {
		const match = oldestPackage(eligible)
		if (match) return { kind: 'matched', packageId: match.id, matchedBy, serialAlreadyUsed }
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
	if (input.leftoverResolution === 'mark_used' && input.previousUnitsRemaining > 0 && !input.previousPackageId) {
		throw new RangeError('previousPackageId is required to mark previous units used')
	}

	const events: LedgerEventDraft[] = []
	if (input.leftoverResolution === 'mark_used' && input.previousUnitsRemaining > 0) {
		events.push({
			packageId: input.previousPackageId!,
			type: 'discarded',
			qty: input.previousUnitsRemaining,
			occurredOn: input.occurredOn,
			inferred: true,
		})
	}
	events.push({ packageId: input.packageId, type: 'opened', qty: 1, occurredOn: input.occurredOn })
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