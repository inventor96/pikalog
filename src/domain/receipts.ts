export type ReceiptObservation = {
	productId: number
	receivedOn: string
	expiry: string | null
	quantity: number
}

export type ProjectedReceipt = {
	productId: number
	arrivalOn: string
	expiry: string | null
	quantity: number
	intervalDays: number
}

type ReceiptGroup = {
	day: number
	quantity: number
}

function dateDay(value: string): number | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
	const timestamp = Date.parse(`${value}T00:00:00.000Z`)
	if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null
	return Math.floor(timestamp / 86_400_000)
}

function dateString(day: number): string {
	return new Date(day * 86_400_000).toISOString().slice(0, 10)
}

function median(values: readonly number[]): number | null {
	if (!values.length) return null
	const sorted = [...values].sort((first, second) => first - second)
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function estimateProjectedReceipts(
	observations: readonly ReceiptObservation[],
	today: string,
	options: { horizonDays?: number; maxReceiptsPerProduct?: number } = {},
): ProjectedReceipt[] {
	const todayDay = dateDay(today)
	if (todayDay === null) throw new RangeError('today must be a valid ISO date')
	const horizonDays = options.horizonDays ?? 180
	const maxReceiptsPerProduct = options.maxReceiptsPerProduct ?? 3
	if (!Number.isInteger(horizonDays) || horizonDays < 1
		|| !Number.isInteger(maxReceiptsPerProduct) || maxReceiptsPerProduct < 1) {
		throw new RangeError('projection bounds must be positive integers')
	}

	const receiptsByProduct = new Map<number, Array<{ day: number; quantity: number; shelfLife: number | null }>>()
	for (const observation of observations) {
		const day = dateDay(observation.receivedOn)
		if (day === null || day > todayDay || !Number.isSafeInteger(observation.quantity) || observation.quantity <= 0) continue
		const expiryDay = observation.expiry ? dateDay(observation.expiry) : null
		const history = receiptsByProduct.get(observation.productId) ?? []
		history.push({
			day,
			quantity: observation.quantity,
			shelfLife: expiryDay !== null && expiryDay >= day ? expiryDay - day : null,
		})
		receiptsByProduct.set(observation.productId, history)
	}

	const projections: ProjectedReceipt[] = []
	for (const [productId, history] of receiptsByProduct) {
		const grouped = new Map<number, number>()
		for (const receipt of history) grouped.set(receipt.day, (grouped.get(receipt.day) ?? 0) + receipt.quantity)
		const groups: ReceiptGroup[] = [...grouped.entries()]
			.map(([day, quantity]) => ({ day, quantity }))
			.sort((first, second) => first.day - second.day)
		if (groups.length < 3) continue

		const onboardingDay = groups[0]!.day
		const recurringHistory = history.filter((receipt) => receipt.day > onboardingDay)
		const recurringGroups = groups.slice(1)
		const intervals = recurringGroups.slice(1).map((group, index) => group.day - recurringGroups[index]!.day)
		const interval = median(intervals)
		if (interval === null || interval < 1) continue
		const quantity = Math.max(1, Math.round(median(recurringGroups.map((group) => group.quantity)) ?? 1))
		const shelfLife = median(recurringHistory.flatMap((receipt) => receipt.shelfLife === null ? [] : [receipt.shelfLife]))
		let arrivalDay = recurringGroups.at(-1)!.day + Math.round(interval)
		while (arrivalDay <= todayDay) arrivalDay += Math.round(interval)
		const horizonEnd = todayDay + horizonDays
		let projectedCount = 0
		while (arrivalDay <= horizonEnd && projectedCount < maxReceiptsPerProduct) {
			projections.push({
				productId,
				arrivalOn: dateString(arrivalDay),
				expiry: shelfLife === null ? null : dateString(arrivalDay + Math.round(shelfLife)),
				quantity,
				intervalDays: Math.max(1, Math.round(interval)),
			})
			projectedCount += 1
			arrivalDay += Math.round(interval)
		}
	}

	return projections.sort((first, second) =>
		first.arrivalOn.localeCompare(second.arrivalOn) || first.productId - second.productId,
	)
}