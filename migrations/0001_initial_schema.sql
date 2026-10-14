CREATE TABLE categories (
	id INTEGER PRIMARY KEY,
	key TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	overlap_allowed INTEGER NOT NULL DEFAULT 0 CHECK (overlap_allowed IN (0, 1))
);

INSERT INTO categories (key, name) VALUES
	('cgm_sensor', 'CGM sensor'),
	('infusion_set', 'Infusion set'),
	('cartridge', 'Cartridge'),
	('test_strip', 'Test strip');

CREATE TABLE products (
	id INTEGER PRIMARY KEY,
	category_id INTEGER NOT NULL REFERENCES categories(id),
	manufacturer TEXT NOT NULL,
	name TEXT NOT NULL,
	gtin TEXT UNIQUE,
	contains_product_id INTEGER REFERENCES products(id),
	contains_qty INTEGER CHECK (contains_qty IS NULL OR contains_qty > 0),
	rated_wear_days INTEGER CHECK (rated_wear_days IS NULL OR rated_wear_days > 0),
	min_samples INTEGER NOT NULL DEFAULT 3 CHECK (min_samples > 0),
	expiry_rule TEXT NOT NULL DEFAULT 'finish_by' CHECK (expiry_rule IN ('finish_by', 'start_by', 'none')),
	expiry_strictness TEXT NOT NULL DEFAULT 'hard' CHECK (expiry_strictness IN ('hard', 'soft')),
	origin TEXT NOT NULL DEFAULT 'custom' CHECK (origin IN ('catalog', 'custom')),
	catalog_key TEXT,
	catalog_version INTEGER
);

CREATE TABLE packages (
	id INTEGER PRIMARY KEY,
	product_id INTEGER NOT NULL REFERENCES products(id),
	lot TEXT,
	serial TEXT,
	expiry TEXT,
	raw_barcode TEXT,
	implicit INTEGER NOT NULL DEFAULT 0 CHECK (implicit IN (0, 1))
);

CREATE TABLE events (
	id INTEGER PRIMARY KEY,
	package_id INTEGER NOT NULL REFERENCES packages(id),
	type TEXT NOT NULL CHECK (type IN ('received', 'opened', 'unit_started', 'unit_ended', 'discarded', 'adjusted')),
	qty INTEGER NOT NULL DEFAULT 1,
	occurred_on TEXT NOT NULL,
	recorded_at TEXT NOT NULL,
	unit_serial TEXT,
	unit_expiry TEXT,
	inferred INTEGER NOT NULL DEFAULT 0 CHECK (inferred IN (0, 1)),
	end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('planned', 'extended', 'early_failure', 'other')),
	note TEXT,
	CHECK (type = 'adjusted' OR qty > 0)
);

CREATE INDEX events_package_id_idx ON events(package_id, occurred_on);
CREATE INDEX events_unit_serial_idx ON events(unit_serial) WHERE unit_serial IS NOT NULL;

CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN
	SELECT RAISE(ABORT, 'events are immutable; append a correction event');
END;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
	SELECT RAISE(ABORT, 'events are immutable; append a correction event');
END;

CREATE TABLE product_overrides (
	product_id INTEGER NOT NULL REFERENCES products(id),
	field TEXT NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (product_id, field)
);

CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE catalog_sync_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	version TEXT,
	last_synced_at TEXT,
	last_status TEXT,
	last_error TEXT
);