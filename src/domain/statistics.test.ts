import { describe, expect, it } from 'vitest'
import { calculateDurationStatistics, type DurationLedgerEvent } from './statistics'

const events: DurationLedgerEvent[] = [
	{
		id: 1,
		packageId: 10,
		categoryId: 1,
		productId: 3,
		productName: 'Sensor A',
		overlapAllowed: false,
		type: 'unit_started',
		occurredOn: '2026-01-01',
		inferred: false,
	},
	{
		id: 2,
		packageId: 10,
		categoryId: 1,
		productId: 3,
		productName: 'Sensor A',
		overlapAllowed: false,
		type: 'unit_ended',
		occurredOn: '2026-01-10',
		inferred: false,
		endReason: 'early_failure',
	},
	{
		id: 3,
		packageId: 11,
		categoryId: 1,
		productId: 3,
		productName: 'Sensor A',
		overlapAllowed: false,
		type: 'unit_started',
		occurredOn: '2026-01-10',
		inferred: true,
	},
	{
		id: 4,
		packageId: 11,
		categoryId: 1,
		productId: 3,
		productName: 'Sensor A',
		overlapAllowed: false,
		type: 'unit_ended',
		occurredOn: '2026-01-20',
		inferred: false,
		endReason: 'planned',
	},
]

describe('calculateDurationStatistics', () => {
	it('excludes early failures from typical duration and tracks inferred samples', () => {
		expect(calculateDurationStatistics(events)).toEqual([{
			productId: 3,
			productName: 'Sensor A',
			sampleCount: 1,
			meanDays: 10,
			medianDays: 10,
			lastTenMeanDays: 10,
			lastTenMedianDays: 10,
			loggedSampleCount: 0,
			inferredSampleCount: 1,
			earlyFailureCount: 1,
			endedCount: 2,
			earlyFailureRate: 0.5,
		}])
	})

	it('closes an active unit at the next category start when no end event exists', () => {
		const result = calculateDurationStatistics([
			...events.slice(0, 1),
			{ ...events[2]!, id: 2, occurredOn: '2026-01-08' },
		])

		expect(result[0]).toMatchObject({ sampleCount: 1, meanDays: 7, medianDays: 7 })
	})

	it('does not include an active unit as a completed duration sample', () => {
		expect(calculateDurationStatistics(events.slice(0, 1))).toEqual([])
	})
})