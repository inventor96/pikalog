import type { LedgerEventDraft } from './ledger'

export type UndoTargetType = 'received' | 'opened' | 'unit_started' | 'unit_ended' | 'discarded' | 'adjusted'

export type UndoTargetEvent = {
	id: number
	packageId: number
	type: UndoTargetType
	qty: number
	occurredOn: string
	unitExpiry?: string | null
	note?: string | null
}

export type EventUndoContext = {
	occurredOn: string
	isUndone: boolean
	isUnitActive: boolean
	packageContainsQty: number | null
	packageEventCount: number
}

export type EventUndoPlan =
	| { kind: 'ready'; events: LedgerEventDraft[] }
	| {
			kind: 'not_reversible'
			reason: 'structural_event' | 'already_undone' | 'undo_event' | 'package_has_history'
	  }

const undoNotePattern = /^undo:\d+$/

export function isUndoNote(note: string | null | undefined): boolean {
	return Boolean(note && undoNotePattern.test(note))
}

function isIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return false
	}
	const date = new Date(`${value}T00:00:00.000Z`)
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function planEventUndo(target: UndoTargetEvent, context: EventUndoContext): EventUndoPlan {
	if (isUndoNote(target.note)) {
		return { kind: 'not_reversible', reason: 'undo_event' }
	}
	if (context.isUndone) {
		return { kind: 'not_reversible', reason: 'already_undone' }
	}
	if (!isIsoDate(context.occurredOn)) {
		throw new RangeError('occurredOn must be a valid YYYY-MM-DD date')
	}

	const note = `undo:${target.id}`
	switch (target.type) {
		case 'received': {
			if (context.packageEventCount !== 1) {
				return { kind: 'not_reversible', reason: 'package_has_history' }
			}
			return {
				kind: 'ready',
				events: [{
					packageId: target.packageId,
					type: 'adjusted',
					qty: -(context.packageContainsQty ?? 1),
					occurredOn: context.occurredOn,
					note,
				}],
			}
		}
		case 'discarded':
			return {
				kind: 'ready',
				events: [{
					packageId: target.packageId,
					type: 'adjusted',
					qty: target.qty,
					occurredOn: context.occurredOn,
					note,
				}],
			}
		case 'unit_started': {
			const events: LedgerEventDraft[] = [{
				packageId: target.packageId,
				type: 'adjusted',
				qty: target.qty,
				occurredOn: context.occurredOn,
				note,
			}]
			if (context.isUnitActive) {
				events.push({
					packageId: target.packageId,
					type: 'unit_ended',
					qty: 1,
					occurredOn: target.occurredOn,
					unitExpiry: target.unitExpiry ?? undefined,
					endReason: 'other',
					note,
				})
			}
			return { kind: 'ready', events }
		}
		case 'adjusted':
			return {
				kind: 'ready',
				events: [{
					packageId: target.packageId,
					type: 'adjusted',
					qty: -target.qty,
					occurredOn: context.occurredOn,
					note,
				}],
			}
		case 'opened':
		case 'unit_ended':
			return { kind: 'not_reversible', reason: 'structural_event' }
	}
}
