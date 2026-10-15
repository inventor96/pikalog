export type HardExpiryUnit = {
	availableOn: number
	preferredDeadline: number
	toleratedDeadline: number
}

export type PlannerInput = {
	today: number
	wearDays: number
	hardUnits: readonly HardExpiryUnit[]
	fillerStock: number
	constrainBy: 'preferred' | 'tolerated'
	receiptsPerQuarter?: number
	consumptionPerQuarter?: number
}

export type PlannerResult = {
	fillerSlotsSafe: number
	nextPick: 'filler' | 'hard' | 'none'
	wasteForecast: {
		preferred: number
		tolerated: number
	}
	surplusPerQuarter: number | null
	assumptions: string[]
}

type DeadlineField = 'preferredDeadline' | 'toleratedDeadline'

function simulate(
	today: number,
	wearDays: number,
	units: readonly HardExpiryUnit[],
	fillersFirst: number,
	deadlineField: DeadlineField,
): number {
	let day = today + fillersFirst * wearDays
	const pending = [...units].sort(
		(first, second) => first[deadlineField] - second[deadlineField],
	)
	let wasted = 0

	while (pending.length > 0) {
		const availableIndex = pending.findIndex((unit) => unit.availableOn <= day)
		if (availableIndex === -1) {
			day += wearDays
			continue
		}

		const [unit] = pending.splice(availableIndex, 1)
		if (unit === undefined) {
			continue
		}
		if (day > unit[deadlineField]) {
			wasted += 1
		} else {
			day += wearDays
		}
	}

	return wasted
}

function validateInput(input: PlannerInput): void {
	if (!Number.isInteger(input.today)) {
		throw new RangeError('today must be an integer day number')
	}
	if (!Number.isInteger(input.wearDays) || input.wearDays <= 0) {
		throw new RangeError('wearDays must be a positive integer')
	}
	if (!Number.isInteger(input.fillerStock) || input.fillerStock < 0) {
		throw new RangeError('fillerStock must be a non-negative integer')
	}
	for (const unit of input.hardUnits) {
		if (!Number.isInteger(unit.availableOn) || !Number.isInteger(unit.preferredDeadline) || !Number.isInteger(unit.toleratedDeadline)) {
			throw new RangeError('unit dates must be integer day numbers')
		}
	}
}

export function plan(input: PlannerInput): PlannerResult {
	validateInput(input)

	const preferredWaste = simulate(input.today, input.wearDays, input.hardUnits, 0, 'preferredDeadline')
	const toleratedWaste = simulate(input.today, input.wearDays, input.hardUnits, 0, 'toleratedDeadline')
	const constrainedDeadline = input.constrainBy === 'preferred' ? 'preferredDeadline' : 'toleratedDeadline'
	const baselineWaste = input.constrainBy === 'preferred' ? preferredWaste : toleratedWaste
	let fillerSlotsSafe = 0

	while (
		fillerSlotsSafe < input.fillerStock &&
		simulate(input.today, input.wearDays, input.hardUnits, fillerSlotsSafe + 1, constrainedDeadline) <= baselineWaste
	) {
		fillerSlotsSafe += 1
	}

	const surplusPerQuarter =
		typeof input.receiptsPerQuarter === 'number' && typeof input.consumptionPerQuarter === 'number'
			? input.receiptsPerQuarter - input.consumptionPerQuarter
			: null

	return {
		fillerSlotsSafe,
		nextPick: fillerSlotsSafe > 0 ? 'filler' : input.hardUnits.length > 0 ? 'hard' : 'none',
		wasteForecast: {
			preferred: preferredWaste,
			tolerated: toleratedWaste,
		},
		surplusPerQuarter,
		assumptions: [
			'Uses the effective wear duration supplied by the caller.',
			'Projected arrival handling depends on what the caller includes in the schedule.',
			surplusPerQuarter === null
				? 'Supply surplus is unavailable until receipt and consumption rates are known.'
				: 'Supply surplus is estimated from the receipt and consumption rates supplied by the caller.',
		],
	}
}