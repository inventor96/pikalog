import { describe, expect, it } from 'vitest'
import {
	matchUnitScan,
	planPackageOpen,
	planUnitStart,
	type OpenPackageCandidate,
	type PackageOpenInput,
} from './ledger'

const baseInput: PackageOpenInput = {
	packageId: 20,
	occurredOn: '2026-10-13',
	previousUnitsRemaining: 0,
	overlapAllowed: false,
}

describe('planPackageOpen', () => {
	it('starts the first unit immediately when none remain', () => {
		const plan = planPackageOpen(baseInput)

		expect(plan).toMatchObject({ kind: 'ready', startFirstUnit: true, previousUnitsDisposition: 'none' })
		if (plan.kind === 'ready') {
			expect(plan.events.map((event) => event.type)).toEqual(['opened', 'unit_started'])
		}
	})

	it('defaults to starting the first unit when one remains', () => {
		const plan = planPackageOpen({ ...baseInput, previousUnitsRemaining: 1 })

		expect(plan).toMatchObject({ kind: 'ready', startFirstUnit: true, previousUnitsDisposition: 'keep' })
	})

	it('leaves previous units in stock by default when more than one remains', () => {
		const plan = planPackageOpen({ ...baseInput, previousUnitsRemaining: 3 })

		expect(plan).toMatchObject({ kind: 'ready', startFirstUnit: false, previousUnitsDisposition: 'keep' })
		if (plan.kind === 'ready') {
			expect(plan.events.map((event) => event.type)).toEqual(['opened'])
		}
	})

	it('requires a leftover choice when starting with more than one previous unit', () => {
		const plan = planPackageOpen({ ...baseInput, previousUnitsRemaining: 3, startFirstUnit: true })

		expect(plan).toEqual({
			kind: 'confirmation_required',
			remainingUnits: 3,
			defaultStartFirstUnit: false,
			choices: ['keep', 'mark_used'],
		})
	})

	it.each(['keep', 'mark_used'] as const)('records the %s choice for leftovers', (leftoverResolution) => {
		const plan = planPackageOpen({
			...baseInput,
			previousUnitsRemaining: 3,
			startFirstUnit: true,
			leftoverResolution,
		})

		expect(plan).toMatchObject({
			kind: 'ready',
			previousUnitsDisposition: leftoverResolution,
			previousUnitsToMarkUsed: leftoverResolution === 'mark_used' ? 3 : 0,
		})
	})

	it('ends the active unit before starting another when overlap is disabled', () => {
		const plan = planPackageOpen({
			...baseInput,
			activeUnit: { packageId: 19, serial: 'OLD-1', expiry: '2026-11-01' },
			unitSerial: 'NEW-1',
			unitExpiry: '2026-12-01',
		})

		expect(plan).toMatchObject({ kind: 'ready' })
		if (plan.kind === 'ready') {
			expect(plan.events).toEqual([
				{ packageId: 20, type: 'opened', qty: 1, occurredOn: '2026-10-13' },
				{
					packageId: 19,
					type: 'unit_ended',
					qty: 1,
					occurredOn: '2026-10-13',
					unitSerial: 'OLD-1',
					unitExpiry: '2026-11-01',
					endReason: 'planned',
				},
				{
					packageId: 20,
					type: 'unit_started',
					qty: 1,
					occurredOn: '2026-10-13',
					unitSerial: 'NEW-1',
					unitExpiry: '2026-12-01',
				},
			])
		}
	})

	it('does not end the active unit when overlap is enabled', () => {
		const plan = planPackageOpen({
			...baseInput,
			overlapAllowed: true,
			activeUnit: { packageId: 19 },
		})

		expect(plan).toMatchObject({ kind: 'ready' })
		if (plan.kind === 'ready') {
			expect(plan.events.map((event) => event.type)).toEqual(['opened', 'unit_started'])
		}
	})

	it('rejects invalid event dates and leftover counts', () => {
		expect(() => planPackageOpen({ ...baseInput, occurredOn: '2026-02-30' })).toThrow(RangeError)
		expect(() => planPackageOpen({ ...baseInput, previousUnitsRemaining: -1 })).toThrow(RangeError)
	})
})

describe('planUnitStart', () => {
	it('ends the active unit before starting a new unit unless overlap is allowed', () => {
		expect(planUnitStart({
			packageId: 20,
			occurredOn: '2026-10-13',
			overlapAllowed: false,
			activeUnit: { packageId: 19 },
		})).toMatchObject([
			{ packageId: 19, type: 'unit_ended', endReason: 'planned' },
			{ packageId: 20, type: 'unit_started' },
		])
	})

	it('starts without ending when overlap is allowed', () => {
		expect(planUnitStart({
			packageId: 20,
			occurredOn: '2026-10-13',
			overlapAllowed: true,
			activeUnit: { packageId: 19 },
		})).toMatchObject([{ packageId: 20, type: 'unit_started' }])
	})
})

describe('matchUnitScan', () => {
	const packages: OpenPackageCandidate[] = [
		{ id: 1, containsProductId: 4, lot: 'LOT-A', expiry: '2027-01-01', receivedOn: '2026-01-02', unitsRemaining: 2 },
		{ id: 2, containsProductId: 4, lot: 'LOT-B', expiry: '2027-01-01', receivedOn: '2026-01-01', unitsRemaining: 1 },
		{ id: 3, containsProductId: 4, lot: 'LOT-C', expiry: '2027-02-01', receivedOn: '2025-12-01', unitsRemaining: 0 },
		{ id: 4, containsProductId: 5, lot: 'LOT-A', expiry: '2027-01-01', receivedOn: '2025-01-01', unitsRemaining: 5 },
	]

	it('prefers an exact lot and expiry match', () => {
		expect(matchUnitScan({ productId: 4, lot: 'LOT-A', expiry: '2027-01-01' }, packages)).toMatchObject({
			kind: 'matched',
			packageId: 1,
			matchedBy: 'lot_expiry',
		})
	})

	it('falls back to expiry when the lot does not match', () => {
		expect(matchUnitScan({ productId: 4, lot: 'LOT-MISSING', expiry: '2027-01-01' }, packages)).toMatchObject({
			kind: 'matched',
			packageId: 2,
			matchedBy: 'expiry',
		})
	})

	it('uses the oldest eligible package for a GTIN-only scan', () => {
		expect(matchUnitScan({ productId: 4, gtin: '00000000000001' }, packages)).toMatchObject({
			kind: 'matched',
			packageId: 2,
			matchedBy: 'gtin',
		})
	})

	it('returns an implicit package when no eligible package matches', () => {
		expect(matchUnitScan({ productId: 4, gtin: '00000000000001' }, [packages[2]!])).toMatchObject({
			kind: 'implicit',
		})
	})

	it('flags a serial that has already appeared in the ledger', () => {
		expect(matchUnitScan({ productId: 4, gtin: '00000000000001', serial: 'S-1' }, packages, ['S-1']))
			.toMatchObject({ serialAlreadyUsed: true })
	})
})