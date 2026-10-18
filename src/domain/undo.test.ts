import { describe, expect, it } from 'vitest'
import { isUndoNote, planEventUndo, type EventUndoContext, type UndoTargetEvent } from './undo'

function context(overrides: Partial<EventUndoContext> = {}): EventUndoContext {
	return {
		occurredOn: '2026-10-17',
		isUndone: false,
		pairedEnd: null,
		packageContainsQty: null,
		packageEventCount: 1,
		...overrides,
	}
}

function target(overrides: Partial<UndoTargetEvent> = {}): UndoTargetEvent {
	return {
		id: 10,
		packageId: 3,
		type: 'discarded',
		qty: 1,
		occurredOn: '2026-10-15',
		...overrides,
	}
}

describe('isUndoNote', () => {
	it('recognizes undo markers and rejects other notes', () => {
		expect(isUndoNote('undo:12')).toBe(true)
		expect(isUndoNote('undo:')).toBe(false)
		expect(isUndoNote('manual correction')).toBe(false)
		expect(isUndoNote(null)).toBe(false)
		expect(isUndoNote(undefined)).toBe(false)
	})
})

describe('planEventUndo', () => {
	it('reverses a discard with a positive adjustment', () => {
		const plan = planEventUndo(target({ type: 'discarded', qty: 3 }), context())
		expect(plan).toEqual({
			kind: 'ready',
			events: [{
				packageId: 3,
				type: 'adjusted',
				qty: 3,
				occurredOn: '2026-10-17',
				note: 'undo:10',
			}],
		})
	})

	it('zeros out a receipt only when the package has no other events', () => {
		const plan = planEventUndo(target({ type: 'received', qty: 1 }), context({ packageContainsQty: 5 }))
		expect(plan).toMatchObject({
			kind: 'ready',
			events: [{ type: 'adjusted', qty: -5, note: 'undo:10' }],
		})
		const unitPlan = planEventUndo(target({ type: 'received' }), context({ packageContainsQty: null }))
		expect(unitPlan).toMatchObject({ kind: 'ready', events: [{ qty: -1 }] })
	})

	it('refuses to undo a receipt once the package has any other history', () => {
		const plan = planEventUndo(target({ type: 'received' }), context({ packageEventCount: 2 }))
		expect(plan).toEqual({ kind: 'not_reversible', reason: 'package_has_history' })
	})

	it('restores stock and voids the paired auto-end when the start switched away from another unit', () => {
		const plan = planEventUndo(
			target({ type: 'unit_started', qty: 1, occurredOn: '2026-10-12' }),
			context({ pairedEnd: { id: 7, packageId: 2 } }),
		)
		expect(plan).toEqual({
			kind: 'ready',
			events: [
				{ packageId: 3, type: 'adjusted', qty: 1, occurredOn: '2026-10-17', note: 'undo:10' },
				{ packageId: 2, type: 'adjusted', qty: 0, occurredOn: '2026-10-17', note: 'undo:7' },
			],
		})
	})

	it('only restores stock when the started unit has no paired auto-end', () => {
		const plan = planEventUndo(target({ type: 'unit_started' }), context())
		expect(plan).toMatchObject({ kind: 'ready', events: [{ type: 'adjusted', qty: 1 }] })
		if (plan.kind === 'ready') expect(plan.events).toHaveLength(1)
	})

	it('negates a previous adjustment', () => {
		const plan = planEventUndo(target({ type: 'adjusted', qty: -4 }), context())
		expect(plan).toMatchObject({ kind: 'ready', events: [{ type: 'adjusted', qty: 4, note: 'undo:10' }] })
	})

	it('rejects structural events, undo events and repeated undos', () => {
		expect(planEventUndo(target({ type: 'opened' }), context()))
			.toEqual({ kind: 'not_reversible', reason: 'structural_event' })
		expect(planEventUndo(target({ type: 'unit_ended' }), context()))
			.toEqual({ kind: 'not_reversible', reason: 'structural_event' })
		expect(planEventUndo(target({ note: 'undo:4' }), context()))
			.toEqual({ kind: 'not_reversible', reason: 'undo_event' })
		expect(planEventUndo(target(), context({ isUndone: true })))
			.toEqual({ kind: 'not_reversible', reason: 'already_undone' })
	})

	it('rejects an invalid correction date', () => {
		expect(() => planEventUndo(target(), context({ occurredOn: '2026-02-30' }))).toThrow(RangeError)
	})
})
