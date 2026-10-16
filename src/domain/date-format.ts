const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
	month: 'short',
	day: 'numeric',
	year: 'numeric',
})
const shortDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
	month: 'short',
	day: 'numeric',
	year: 'numeric',
	hour: 'numeric',
	minute: '2-digit',
})

export function formatShortDate(value: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
	if (!match) return value

	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const date = new Date(0)
	date.setFullYear(year, month - 1, day)
	date.setHours(12, 0, 0, 0)
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return value

	return shortDateFormatter.format(date)
}

export function formatShortDateTime(value: string): string {
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return value

	return shortDateTimeFormatter.format(date)
}