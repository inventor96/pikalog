import { plan } from './planner'
import type { ProjectedReceipt } from './receipts'
import type { DurationLedgerEvent, ProductDurationStatistics } from './statistics'

export type ForecastProduct = {
	id: number
	categoryId: number
	categoryName: string
	name: string
	containsProductId: number | null
	ratedWearDays: number | null
	minSamples: number
	expiryRule: 'finish_by' | 'start_by' | 'none'
	expiryStrictness: 'hard' | 'soft'
}

export type ForecastPackage = {
	id: number
	productId: number
	expiry: string | null
	receivedOn: string
	unitsRemaining: number
}

export type ForecastEvent = DurationLedgerEvent & {
	unitExpiry?: string | null
}

export type CategoryForecast = {
	categoryId: number
	categoryName: string
	stockUnits: number
	activeUnits: number
	expiredUnits: number
	surplusPerQuarter: number | null
	projectedReceipts: Array<{
		productName: string
		arrivalOn: string
		expiry: string | null
		quantity: number
	}>
	stockDays: number | null
	runOutDate: string | null
	nextPick: 'filler' | 'hard' | 'none'
	nextPickProduct: string | null
	fillerSlotsSafe: number
	wasteForecast: { preferred: number; tolerated: number }
	assumptions: string[]
}

type StockUnit = {
	product: ForecastProduct
	package: ForecastPackage
	expiryDay: number | null
}

type ActiveUnit = {
	event: ForecastEvent
	product: ForecastProduct
	startedDay: number
}

function dayNumber(value: string): number {
	return Math.floor(Date.parse(`${value}T00:00:00.000Z`) / 86_400_000)
}

function isoDate(day: number): string {
	return new Date(day * 86_400_000).toISOString().slice(0, 10)
}

function effectiveWearDays(
	product: ForecastProduct,
	statistics: ReadonlyMap<number, ProductDurationStatistics>,
): number | null {
	const statistic = statistics.get(product.id)
	if (statistic && statistic.sampleCount >= product.minSamples && statistic.medianDays !== null) {
		return Math.max(1, Math.round(statistic.medianDays))
	}
	return product.ratedWearDays
}

function currentActiveUnits(events: readonly ForecastEvent[], products: ReadonlyMap<number, ForecastProduct>): ActiveUnit[] {
	const active = new Map<string, ActiveUnit>()
	const orderedEvents = [...events].sort(
		(first, second) => first.occurredOn.localeCompare(second.occurredOn) || first.id - second.id,
	)

	for (const event of orderedEvents) {
		const product = products.get(event.productId)
		if (!product) continue
		const key = event.overlapAllowed ? `${event.categoryId}:${event.packageId}` : String(event.categoryId)
		if (event.type === 'unit_started') {
			active.set(key, { event, product, startedDay: dayNumber(event.occurredOn) })
		} else {
			active.delete(key)
		}
	}

	return [...active.values()]
}

export function calculateSupplyForecast(input: {
	today: string
	products: readonly ForecastProduct[]
	packages: readonly ForecastPackage[]
	events: readonly ForecastEvent[]
	durationStatistics: readonly ProductDurationStatistics[]
	projectedReceipts?: readonly ProjectedReceipt[]
}): CategoryForecast[] {
	const today = dayNumber(input.today)
	const productById = new Map(input.products.map((product) => [product.id, product]))
	const statistics = new Map(input.durationStatistics.map((statistic) => [statistic.productId, statistic]))
	const activeUnits = currentActiveUnits(input.events, productById)
	const categories = new Map<number, {
		name: string
		stock: StockUnit[]
		active: ActiveUnit[]
		projected: ProjectedReceipt[]
	}>()
	const getCategory = (product: ForecastProduct) => {
		let category = categories.get(product.categoryId)
		if (!category) {
			category = { name: product.categoryName, stock: [], active: [], projected: [] }
			categories.set(product.categoryId, category)
		}
		return category
	}

	for (const unit of activeUnits) getCategory(unit.product).active.push(unit)
	for (const projected of input.projectedReceipts ?? []) {
		const product = productById.get(projected.productId)
		if (product) getCategory(product).projected.push(projected)
	}
	for (const inventoryPackage of input.packages) {
		const packageProduct = productById.get(inventoryPackage.productId)
		const product = packageProduct?.containsProductId === null
			? packageProduct
			: packageProduct?.containsProductId === undefined
				? undefined
				: productById.get(packageProduct.containsProductId)
		if (!product) continue
		const category = getCategory(product)
		const expiryDay = inventoryPackage.expiry ? dayNumber(inventoryPackage.expiry) : null
		for (let count = 0; count < Math.max(0, inventoryPackage.unitsRemaining); count += 1) {
			category.stock.push({ product, package: inventoryPackage, expiryDay })
		}
	}

	return [...categories.entries()].map(([categoryId, category]) => {
		const allProducts = [
			...category.stock.map((unit) => unit.product),
			...category.active.map((unit) => unit.product),
			...category.projected.flatMap((receipt) => {
				const product = productById.get(receipt.productId)
				return product ? Array.from({ length: receipt.quantity }, () => product) : []
			}),
		]
		const durations = allProducts
			.map((product) => effectiveWearDays(product, statistics))
			.filter((days): days is number => days !== null && Number.isFinite(days) && days > 0)
		const hasUnknownWear = allProducts.some((product) => effectiveWearDays(product, statistics) === null)
		const fallbackWearDays = durations.length
			? Math.max(1, Math.round(durations.reduce((sum, days) => sum + days, 0) / durations.length))
			: null
		const stock = category.stock.filter((unit) => unit.expiryDay === null || unit.expiryDay >= today)
		const expiredUnits = category.stock.length - stock.length
		const unitsWithWear = stock.flatMap((unit) => {
			const wearDays = effectiveWearDays(unit.product, statistics)
			return wearDays === null ? [] : [{ ...unit, wearDays }]
		})
		const activeWithWear = category.active.flatMap((unit) => {
			const wearDays = effectiveWearDays(unit.product, statistics)
			return wearDays === null ? [] : [{ ...unit, wearDays }]
		})
		const activeRemainingDays = activeWithWear.reduce((sum, unit) =>
			sum + Math.max(0, unit.wearDays - (today - unit.startedDay)), 0)
		const stockDaysBeforeExpiry = unitsWithWear.reduce((sum, unit) => sum + unit.wearDays, 0)
			+ activeRemainingDays
		const projectedWithWear = category.projected.flatMap((receipt) => {
			const product = productById.get(receipt.productId)
			const wearDays = product ? effectiveWearDays(product, statistics) : null
			if (!product || wearDays === null) return []
			return [{ receipt, product, wearDays, expiryDay: receipt.expiry ? dayNumber(receipt.expiry) : null }]
		})
		const projectedStockDays = projectedWithWear.reduce((sum, projection) => {
			const arrivalDay = dayNumber(projection.receipt.arrivalOn)
			if (projection.expiryDay !== null && projection.expiryDay < arrivalDay) return sum
			if (projection.product.expiryStrictness === 'soft'
				&& projection.product.expiryRule === 'finish_by'
				&& projection.expiryDay !== null
				&& projection.expiryDay < arrivalDay + projection.wearDays) return sum
			return sum + projection.receipt.quantity * projection.wearDays
		}, 0)
		const receiptCadence = new Map<number, ProjectedReceipt>()
		for (const receipt of category.projected) {
			if (!receiptCadence.has(receipt.productId)) receiptCadence.set(receipt.productId, receipt)
		}
		const receiptsPerQuarter = receiptCadence.size
			? [...receiptCadence.values()].reduce((sum, receipt) =>
				sum + receipt.quantity * 90 / receipt.intervalDays, 0)
			: null
		const stockUnits = stock.length
		const nextUseDay = category.active.length
			? Math.max(today, ...activeWithWear.map((unit) => unit.startedDay + unit.wearDays))
			: today
		const hardUnits: Array<{
			availableOn: number
			preferredDeadline: number
			toleratedDeadline: number
		}> = []
		const fillerUnits = unitsWithWear.filter((unit) =>
			unit.product.expiryStrictness === 'soft'
			|| unit.product.expiryRule === 'none'
			|| unit.expiryDay === null,
		)
		for (const unit of unitsWithWear) {
			if (unit.product.expiryStrictness !== 'hard'
				|| unit.product.expiryRule === 'none'
				|| unit.expiryDay === null) continue
			hardUnits.push({
				availableOn: nextUseDay,
				preferredDeadline: unit.product.expiryRule === 'finish_by'
					? unit.expiryDay - unit.wearDays
					: unit.expiryDay,
				toleratedDeadline: unit.expiryDay,
			})
		}
		for (const projection of projectedWithWear) {
			if (projection.product.expiryStrictness !== 'hard'
				|| projection.product.expiryRule === 'none'
				|| projection.expiryDay === null) continue
			const availableOn = Math.max(nextUseDay, dayNumber(projection.receipt.arrivalOn))
			for (let count = 0; count < projection.receipt.quantity; count += 1) {
				hardUnits.push({
					availableOn,
					preferredDeadline: projection.product.expiryRule === 'finish_by'
						? projection.expiryDay - projection.wearDays
						: projection.expiryDay,
					toleratedDeadline: projection.expiryDay,
				})
			}
		}
		const usableFillers = fillerUnits.filter((unit) =>
			unit.expiryDay === null
			|| unit.product.expiryRule !== 'finish_by'
			|| unit.expiryDay >= nextUseDay + unit.wearDays,
		)

		const planner = fallbackWearDays === null || hasUnknownWear
			? null
			: plan({
				today: nextUseDay,
				wearDays: fallbackWearDays,
				hardUnits,
				fillerStock: usableFillers.length,
				constrainBy: 'preferred',
				receiptsPerQuarter: receiptsPerQuarter ?? undefined,
				consumptionPerQuarter: fallbackWearDays === null ? undefined : 90 / fallbackWearDays,
			})
		const chosenFiller = usableFillers.sort((first, second) =>
			(first.expiryDay ?? Number.MAX_SAFE_INTEGER) - (second.expiryDay ?? Number.MAX_SAFE_INTEGER)
			|| first.package.receivedOn.localeCompare(second.package.receivedOn)
			|| first.package.id - second.package.id,
		)[0]
		const chosenHard = unitsWithWear
			.filter((unit) => unit.product.expiryStrictness === 'hard'
				&& unit.product.expiryRule !== 'none'
				&& unit.expiryDay !== null
				&& unit.expiryDay >= nextUseDay)
			.sort((first, second) => first.expiryDay! - second.expiryDay!)[0]
		const nextPick = planner === null
			? 'none'
			: planner.nextPick === 'filler' && chosenFiller ? 'filler' : chosenHard ? 'hard' : 'none'
		const nextPickProduct = nextPick === 'filler'
			? chosenFiller?.product.name ?? null
			: nextPick === 'hard' ? chosenHard?.product.name ?? null : null
		const preferredWaste = planner?.wasteForecast.preferred ?? 0
		const stockDays = fallbackWearDays === null || hasUnknownWear
			? null
			: Math.max(0, stockDaysBeforeExpiry + projectedStockDays - preferredWaste * fallbackWearDays)
		const assumptions = planner?.assumptions ?? []
		if (category.active.length) assumptions.push('Run-out includes estimated remaining wear for active units.')
		if (category.projected.length) {
			assumptions.push('Projected arrivals use median historical intervals, quantities, and observed shelf life; they are not confirmed supply.')
			if (category.projected.some((receipt) => productById.get(receipt.productId)?.expiryStrictness === 'soft')) {
				assumptions.push('Future soft-expiry receipts are included in stock days but not safe filler slots.')
			}
		}
		if (expiredUnits) assumptions.push('Expired stock is excluded from stock days and pick recommendations.')
		if (hasUnknownWear) {
			assumptions.push('Some units lack both rated wear and enough completed samples for a duration estimate.')
		}
		if (category.stock.some((unit) => unit.product.expiryStrictness === 'soft' && unit.expiryDay !== null)) {
			assumptions.push('Future soft-expiry losses are not fully simulated in the run-out date.')
		}
		if (category.active.some((unit) => unit.event.overlapAllowed)) {
			assumptions.push('Overlapping active units are approximated as sequential wear for the run-out estimate.')
		}

		return {
			categoryId,
			categoryName: category.name,
			stockUnits,
			activeUnits: category.active.length,
			expiredUnits,
			surplusPerQuarter: planner?.surplusPerQuarter ?? null,
			projectedReceipts: category.projected.map((receipt) => ({
				productName: productById.get(receipt.productId)?.name ?? 'Unknown product',
				arrivalOn: receipt.arrivalOn,
				expiry: receipt.expiry,
				quantity: receipt.quantity,
			})),
			stockDays,
			runOutDate: stockDays === null ? null : isoDate(today + Math.ceil(stockDays)),
			nextPick,
			nextPickProduct,
			fillerSlotsSafe: planner?.fillerSlotsSafe ?? 0,
			wasteForecast: planner?.wasteForecast ?? { preferred: 0, tolerated: 0 },
			assumptions,
		}
	})
}