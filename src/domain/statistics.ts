export type DurationLedgerEvent = {
	id: number
	packageId: number
	categoryId: number
	productId: number
	productName: string
	overlapAllowed: boolean
	type: 'unit_started' | 'unit_ended'
	occurredOn: string
	inferred: boolean
	endReason?: 'planned' | 'extended' | 'early_failure' | 'other' | null
}

export type ProductDurationStatistics = {
	productId: number
	productName: string
	sampleCount: number
	meanDays: number | null
	medianDays: number | null
	lastTenMeanDays: number | null
	lastTenMedianDays: number | null
	loggedSampleCount: number
	inferredSampleCount: number
	earlyFailureCount: number
	endedCount: number
	earlyFailureRate: number | null
}

type DurationSample = {
	productId: number
	productName: string
	days: number
	inferred: boolean
	endReason: DurationLedgerEvent['endReason']
}

type ActiveUnit = {
	productId: number
	productName: string
	startedOn: string
	inferred: boolean
}

function dayNumber(value: string): number {
	return Math.floor(Date.parse(`${value}T00:00:00.000Z`) / 86_400_000)
}

function mean(values: readonly number[]): number | null {
	return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function median(values: readonly number[]): number | null {
	if (!values.length) return null
	const sorted = [...values].sort((first, second) => first - second)
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function calculateDurationStatistics(
	events: readonly DurationLedgerEvent[],
): ProductDurationStatistics[] {
	const activeUnits = new Map<string, ActiveUnit>()
	const samples: DurationSample[] = []

	const orderedEvents = [...events].sort(
		(first, second) => first.occurredOn.localeCompare(second.occurredOn) || first.id - second.id,
	)

	for (const event of orderedEvents) {
		const activeKey = event.overlapAllowed
			? `${event.categoryId}:${event.packageId}`
			: String(event.categoryId)

		if (event.type === 'unit_started') {
			const active = activeUnits.get(activeKey)
			if (active) {
				const days = dayNumber(event.occurredOn) - dayNumber(active.startedOn)
				if (days > 0) {
					samples.push({
						productId: active.productId,
						productName: active.productName,
						days,
						inferred: active.inferred || event.inferred,
						endReason: 'planned',
					})
				}
			}
			activeUnits.set(activeKey, {
				productId: event.productId,
				productName: event.productName,
				startedOn: event.occurredOn,
				inferred: event.inferred,
			})
			continue
		}

		const active = activeUnits.get(activeKey)
		if (!active) continue
		activeUnits.delete(activeKey)
		const days = dayNumber(event.occurredOn) - dayNumber(active.startedOn)
		if (days > 0) {
			samples.push({
				productId: active.productId,
				productName: active.productName,
				days,
				inferred: active.inferred || event.inferred,
				endReason: event.endReason,
			})
		}
	}

	const productIds = [...new Set(samples.map((sample) => sample.productId))]
	return productIds.map((productId) => {
		const productSamples = samples.filter((sample) => sample.productId === productId)
		const typicalSamples = productSamples.filter((sample) => sample.endReason !== 'early_failure')
		const durations = typicalSamples.map((sample) => sample.days)
		const recentDurations = durations.slice(-10)
		const earlyFailureCount = productSamples.filter((sample) => sample.endReason === 'early_failure').length
		const endedCount = productSamples.length

		return {
			productId,
			productName: productSamples[0]!.productName,
			sampleCount: durations.length,
			meanDays: mean(durations),
			medianDays: median(durations),
			lastTenMeanDays: mean(recentDurations),
			lastTenMedianDays: median(recentDurations),
			loggedSampleCount: typicalSamples.filter((sample) => !sample.inferred).length,
			inferredSampleCount: typicalSamples.filter((sample) => sample.inferred).length,
			earlyFailureCount,
			endedCount,
			earlyFailureRate: endedCount ? earlyFailureCount / endedCount : null,
		}
	})
}