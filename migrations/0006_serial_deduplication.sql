CREATE TRIGGER packages_serial_unique_insert
BEFORE INSERT ON packages
WHEN NEW.serial IS NOT NULL AND NEW.implicit = 0
	AND EXISTS (SELECT 1 FROM packages WHERE serial = NEW.serial AND implicit = 0)
BEGIN
	SELECT RAISE(ABORT, 'duplicate_package_serial');
END;

CREATE TRIGGER events_unit_serial_unique_insert
BEFORE INSERT ON events
WHEN NEW.type = 'unit_started' AND NEW.unit_serial IS NOT NULL
	AND EXISTS (SELECT 1 FROM events WHERE type = 'unit_started' AND unit_serial = NEW.unit_serial)
BEGIN
	SELECT RAISE(ABORT, 'duplicate_unit_serial');
END;