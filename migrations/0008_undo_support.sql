DROP TRIGGER packages_serial_unique_insert;

CREATE TRIGGER packages_serial_unique_insert
BEFORE INSERT ON packages
WHEN NEW.serial IS NOT NULL AND NEW.implicit = 0
	AND EXISTS (
		SELECT 1 FROM packages AS existing
		JOIN events AS received ON received.package_id = existing.id AND received.type = 'received'
		WHERE existing.serial = NEW.serial AND existing.implicit = 0
			AND NOT EXISTS (SELECT 1 FROM events AS undoing WHERE undoing.note = 'undo:' || received.id)
	)
BEGIN
	SELECT RAISE(ABORT, 'duplicate_package_serial');
END;

DROP TRIGGER events_unit_serial_unique_insert;

CREATE TRIGGER events_unit_serial_unique_insert
BEFORE INSERT ON events
WHEN NEW.type = 'unit_started' AND NEW.unit_serial IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM events AS started
		WHERE started.type = 'unit_started' AND started.unit_serial = NEW.unit_serial
			AND NOT EXISTS (SELECT 1 FROM events AS undoing WHERE undoing.note = 'undo:' || started.id)
	)
BEGIN
	SELECT RAISE(ABORT, 'duplicate_unit_serial');
END;
