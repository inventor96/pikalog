import { describe, expect, it } from 'vitest'
import { formatShortDate, formatShortDateTime } from './date-format'

describe('formatShortDate', () => {
	it('formats ISO dates as short localized calendar dates', () => {
		const expected = new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
		}).format(new Date(2026, 0, 2))

		expect(formatShortDate('2026-01-02')).toBe(expected)
	})

	it('leaves invalid date values unchanged', () => {
		expect(formatShortDate('2026-02-30')).toBe('2026-02-30')
		expect(formatShortDate('unknown')).toBe('unknown')
	})

	it('formats ISO timestamps as short localized date and time', () => {
		const timestamp = '2026-10-14T00:00:00.000Z'
		const expected = new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		}).format(new Date(timestamp))

		expect(formatShortDateTime(timestamp)).toBe(expected)
		expect(formatShortDateTime('unknown')).toBe('unknown')
	})
})