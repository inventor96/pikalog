import { describe, expect, it } from 'vitest'
import { estimateProjectedReceipts, type ReceiptObservation } from './receipts'

describe('estimateProjectedReceipts', () => {
	it('projects median intervals, grouped quantities, and observed shelf life', () => {
		const observations: ReceiptObservation[] = [
			{ productId: 1, receivedOn: '2026-08-01', expiry: '2026-11-09', quantity: 2 },
			{ productId: 1, receivedOn: '2026-08-01', expiry: '2026-11-09', quantity: 3 },
			{ productId: 1, receivedOn: '2026-09-01', expiry: '2026-12-30', quantity: 4 },
			{ productId: 1, receivedOn: '2026-10-01', expiry: '2027-01-19', quantity: 3 },
		]

		expect(estimateProjectedReceipts(observations, '2026-10-14')).toEqual([
			{ productId: 1, arrivalOn: '2026-11-01', expiry: '2027-02-14', quantity: 4, intervalDays: 31 },
			{ productId: 1, arrivalOn: '2026-12-02', expiry: '2027-03-17', quantity: 4, intervalDays: 31 },
			{ productId: 1, arrivalOn: '2027-01-02', expiry: '2027-04-17', quantity: 4, intervalDays: 31 },
		])
	})

	it('requires two past receipt dates and leaves expiry unknown without shelf-life history', () => {
		const observations: ReceiptObservation[] = [
			{ productId: 1, receivedOn: '2026-08-01', expiry: null, quantity: 1 },
			{ productId: 1, receivedOn: '2026-09-01', expiry: null, quantity: 1 },
		]

		expect(estimateProjectedReceipts(observations.slice(0, 1), '2026-10-14')).toEqual([])
		expect(estimateProjectedReceipts(observations, '2026-10-14')).toEqual([
			{ productId: 1, arrivalOn: '2026-11-02', expiry: null, quantity: 1, intervalDays: 31 },
			{ productId: 1, arrivalOn: '2026-12-03', expiry: null, quantity: 1, intervalDays: 31 },
			{ productId: 1, arrivalOn: '2027-01-03', expiry: null, quantity: 1, intervalDays: 31 },
		])
	})

	it('skips overdue cadence dates and rejects invalid projection dates', () => {
		const observations: ReceiptObservation[] = [
			{ productId: 1, receivedOn: '2026-08-01', expiry: null, quantity: 1 },
			{ productId: 1, receivedOn: '2026-09-01', expiry: null, quantity: 1 },
		]

		expect(estimateProjectedReceipts(observations, '2026-10-15')[0]?.arrivalOn).toBe('2026-11-02')
		expect(() => estimateProjectedReceipts(observations, '2026-02-30')).toThrow(RangeError)
	})
})