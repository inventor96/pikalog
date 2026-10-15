CREATE UNIQUE INDEX products_catalog_key_unique
	ON products(catalog_key)
	WHERE catalog_key IS NOT NULL;

CREATE TABLE catalog_barcode_formats (
	catalog_key TEXT PRIMARY KEY,
	product_id INTEGER NOT NULL REFERENCES products(id),
	pattern TEXT NOT NULL,
	fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
	source_url TEXT NOT NULL,
	verified INTEGER NOT NULL CHECK (verified IN (0, 1))
);