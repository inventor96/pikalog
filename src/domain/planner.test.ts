import { describe, expect, it } from 'vitest'
import { plan, type PlannerInput } from './planner'

const baseInput: PlannerInput = {
	today: 0,
	wearDays: 10,
	hardUnits: [],
	fillerStock: 0,
	constrainBy: 'preferred',
}

describe('plan', () => {
	it('allows all fillers when there is no hard-expiry stock', () => {
		const result = plan({ ...baseInput, fillerStock: 3 })

		expect(result.fillerSlotsSafe).toBe(3)
		expect(result.nextPick).toBe('filler')
		expect(result.wasteForecast).toEqual({ preferred: 0, tolerated: 0 })
	})

	it('uses hard-expiry slack before recommending a filler', () => {
		const result = plan({
			...baseInput,
			hardUnits: [{ availableOn: 0, preferredDeadline: 20, toleratedDeadline: 25 }],
			fillerStock: 1,
		})

		expect(result.fillerSlotsSafe).toBe(1)
		expect(result.wasteForecast.preferred).toBe(0)
	})

	it('uses the selected preferred or tolerated deadline for filler decisions', () => {
		const hardUnits = [{ availableOn: 0, preferredDeadline: 9, toleratedDeadline: 19 }]
		const preferred = plan({ ...baseInput, hardUnits, fillerStock: 1, constrainBy: 'preferred' })
		const tolerated = plan({ ...baseInput, hardUnits, fillerStock: 1, constrainBy: 'tolerated' })

		expect(preferred.fillerSlotsSafe).toBe(0)
		expect(tolerated.fillerSlotsSafe).toBe(1)
		expect(preferred.wasteForecast).toEqual({ preferred: 0, tolerated: 0 })
	})

	it('reports over-supply when receipt history is available', () => {
		const result = plan({
			...baseInput,
			receiptsPerQuarter: 6,
			consumptionPerQuarter: 4,
		})

		expect(result.surplusPerQuarter).toBe(2)
	})

	it('rejects invalid wear durations', () => {
		expect(() => plan({ ...baseInput, wearDays: 0 })).toThrow(RangeError)
	})
})