import { describe, expect, it } from 'vitest'
import { calculateSupplyForecast, type ForecastEvent, type ForecastProduct } from './forecast'

const products: ForecastProduct[] = [
	{
		id: 1,
		categoryId: 1,
		categoryName: 'CGM sensor',
		name: 'Instinct',
		containsProductId: null,
		ratedWearDays: 10,
		minSamples: 3,
		expiryRule: 'finish_by',
		expiryStrictness: 'hard',
	},
	{
		id: 2,
		categoryId: 1,
		categoryName: 'CGM sensor',
		name: 'G4',
		containsProductId: null,
		ratedWearDays: 7,
		minSamples: 3,
		expiryRule: 'finish_by',
		expiryStrictness: 'soft',
	},
	{
		id: 11,
		categoryId: 1,
		categoryName: 'CGM sensor',
		name: 'Instinct box',
		containsProductId: 1,
		ratedWearDays: null,
		minSamples: 3,
		expiryRule: 'finish_by',
		expiryStrictness: 'hard',
	},
	{
		id: 12,
		categoryId: 1,
		categoryName: 'CGM sensor',
		name: 'G4 box',
		containsProductId: 2,
		ratedWearDays: null,
		minSamples: 3,
		expiryRule: 'finish_by',
		expiryStrictness: 'hard',
	},
]

describe('calculateSupplyForecast', () => {
	it('maps package stock to its unit product and includes measured and active wear', () => {
		const events: ForecastEvent[] = [{
			id: 1,
			packageId: 201,
			categoryId: 1,
			productId: 1,
			productName: 'Instinct',
			overlapAllowed: false,
			type: 'unit_started',
			occurredOn: '2026-10-09',
			inferred: false,
		}]
		const forecast = calculateSupplyForecast({
			today: '2026-10-14',
			products,
			packages: [
				{ id: 201, productId: 11, expiry: '2027-01-31', receivedOn: '2026-10-01', unitsRemaining: 2 },
				{ id: 202, productId: 12, expiry: null, receivedOn: '2026-10-02', unitsRemaining: 1 },
			],
			events,
			durationStatistics: [{
				productId: 1,
				productName: 'Instinct',
				sampleCount: 3,
				meanDays: 8,
				medianDays: 8,
				lastTenMeanDays: 8,
				lastTenMedianDays: 8,
				loggedSampleCount: 3,
				inferredSampleCount: 0,
				earlyFailureCount: 0,
				endedCount: 3,
				earlyFailureRate: 0,
			}],
		})[0]!

		expect(forecast).toMatchObject({
			categoryName: 'CGM sensor',
			stockUnits: 3,
			activeUnits: 1,
			stockDays: 26,
			runOutDate: '2026-11-09',
			nextPick: 'filler',
			nextPickProduct: 'G4',
		})
	})

	it('reports preferred finish-by waste and excludes past-date hard-expiry stock', () => {
		const productsWithHardG4 = products.map((product) => product.id === 2
			? { ...product, expiryStrictness: 'hard' as const }
			: product)
		const [forecast] = calculateSupplyForecast({
			today: '2026-10-14',
			products: productsWithHardG4,
			packages: [
				{ id: 301, productId: 11, expiry: '2026-10-22', receivedOn: '2026-10-01', unitsRemaining: 1 },
				{ id: 302, productId: 12, expiry: '2026-10-13', receivedOn: '2026-10-01', unitsRemaining: 1 },
			],
			events: [],
			durationStatistics: [],
		})

		expect(forecast).toMatchObject({
			stockUnits: 1,
			expiredUnits: 1,
			excludedUnits: 1,
			nextPick: 'hard',
			nextPickProduct: 'Instinct',
			wasteForecast: { preferred: 1, tolerated: 0 },
		})
	})

	it('keeps soft-expiry stock available as an at-risk filler', () => {
		const forecasts = calculateSupplyForecast({
			today: '2026-10-14',
			products,
			packages: [
				{ id: 401, productId: 11, expiry: '2026-10-18', receivedOn: '2026-10-01', unitsRemaining: 1 },
				{ id: 402, productId: 12, expiry: '2026-10-17', receivedOn: '2026-10-01', unitsRemaining: 1 },
			],
			events: [{
				id: 1,
				packageId: 402,
				categoryId: 1,
				productId: 2,
				productName: 'G4',
				overlapAllowed: false,
				type: 'unit_started',
				occurredOn: '2026-10-12',
				inferred: false,
			}],
			durationStatistics: [],
		})

		expect(forecasts[0]).toMatchObject({
			nextPick: 'filler',
			nextPickProduct: 'G4',
			nextPickAtRisk: true,
			softExpiryRiskUnits: 1,
			fillerSlotsSafe: 1,
		})
	})

	it('keeps past-date stock forecast-eligible when expiry is not a planning constraint', () => {
		const productsWithoutExpiryConstraint = products.map((product) => product.id === 1
			? { ...product, expiryRule: 'none' as const }
			: product)
		const [forecast] = calculateSupplyForecast({
			today: '2026-10-14',
			products: productsWithoutExpiryConstraint,
			packages: [{ id: 451, productId: 11, expiry: '2026-10-13', receivedOn: '2026-10-01', unitsRemaining: 1 }],
			events: [],
			durationStatistics: [],
		})

		expect(forecast).toMatchObject({
			stockUnits: 1,
			expiredUnits: 1,
			excludedUnits: 0,
			nextPick: 'filler',
			nextPickProduct: 'Instinct',
		})
	})

	it('withholds dates and picks when a stock product has no usable wear estimate', () => {
		const productsWithoutRating = products.map((product) =>
			product.id === 1 ? { ...product, ratedWearDays: null } : product,
		)
		const forecast = calculateSupplyForecast({
			today: '2026-10-14',
			products: productsWithoutRating,
			packages: [{ id: 501, productId: 11, expiry: '2027-01-31', receivedOn: '2026-10-01', unitsRemaining: 1 }],
			events: [],
			durationStatistics: [],
		})[0]!

		expect(forecast).toMatchObject({
			stockUnits: 1,
			stockDays: null,
			runOutDate: null,
			nextPick: 'none',
			nextPickProduct: null,
		})
		expect(forecast.assumptions).toContain(
			'Some units lack both rated wear and enough completed samples for a duration estimate.',
		)
	})

	it('plans projected hard-expiry units from their estimated arrival date', () => {
		const forecast = calculateSupplyForecast({
			today: '2026-10-14',
			products,
			packages: [],
			events: [],
			durationStatistics: [],
			projectedReceipts: [{
				productId: 1,
				arrivalOn: '2026-10-20',
				expiry: '2026-10-30',
				quantity: 1,
				intervalDays: 30,
			}],
		})[0]!

		expect(forecast).toMatchObject({
			projectedReceipts: [{
				productName: 'Instinct',
				arrivalOn: '2026-10-20',
				expiry: '2026-10-30',
				quantity: 1,
			}],
			wasteForecast: { preferred: 1, tolerated: 0 },
			stockDays: 0,
		})
	})

	it('includes projected soft stock in stock days and flags its expiry risk', () => {
		const forecast = calculateSupplyForecast({
			today: '2026-10-14',
			products,
			packages: [],
			events: [],
			durationStatistics: [],
			projectedReceipts: [{
				productId: 2,
				arrivalOn: '2026-10-15',
				expiry: '2026-10-18',
				quantity: 1,
				intervalDays: 30,
			}],
		})[0]!

		expect(forecast).toMatchObject({
			stockDays: 7,
			softExpiryRiskUnits: 1,
		})
		expect(forecast.assumptions).toContain(
			'Projected soft-expiry receipts are included in stock days but are not yet on-hand filler slots.',
		)
	})

	it('reports quarterly over-supply from inferred arrival cadence', () => {
		const forecast = calculateSupplyForecast({
			today: '2026-10-14',
			products,
			packages: [],
			events: [],
			durationStatistics: [],
			projectedReceipts: [{
				productId: 1,
				arrivalOn: '2026-11-13',
				expiry: null,
				quantity: 5,
				intervalDays: 30,
			}],
		})[0]!

		expect(forecast.surplusPerQuarter).toBe(6)
	})
})