ALTER TABLE categories ADD COLUMN origin TEXT NOT NULL DEFAULT 'custom'
	CHECK (origin IN ('catalog', 'custom'));
ALTER TABLE categories ADD COLUMN catalog_version INTEGER;
ALTER TABLE categories ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0
	CHECK (hidden IN (0, 1));
ALTER TABLE products ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0
	CHECK (hidden IN (0, 1));

UPDATE categories
SET origin = 'catalog';

CREATE TABLE category_overrides (
	category_id INTEGER NOT NULL REFERENCES categories(id),
	field TEXT NOT NULL CHECK (field IN ('name', 'overlap_allowed')),
	value TEXT NOT NULL,
	PRIMARY KEY (category_id, field)
);

CREATE VIEW effective_categories AS
SELECT categories.id, categories.key,
	COALESCE((SELECT value FROM category_overrides WHERE category_id = categories.id AND field = 'name'), categories.name) AS name,
	CAST(COALESCE((SELECT value FROM category_overrides WHERE category_id = categories.id AND field = 'overlap_allowed'), CAST(categories.overlap_allowed AS TEXT)) AS INTEGER) AS overlap_allowed,
	categories.origin, categories.catalog_version, categories.hidden
FROM categories;

CREATE VIEW effective_products AS
SELECT products.id,
	CAST(COALESCE((SELECT value FROM product_overrides WHERE product_id = products.id AND field = 'category_id'), CAST(products.category_id AS TEXT)) AS INTEGER) AS category_id,
	COALESCE((SELECT value FROM product_overrides WHERE product_id = products.id AND field = 'manufacturer'), products.manufacturer) AS manufacturer,
	COALESCE((SELECT value FROM product_overrides WHERE product_id = products.id AND field = 'name'), products.name) AS name,
	products.gtin, products.contains_product_id, products.contains_qty, products.rated_wear_days,
	CAST(COALESCE((SELECT value FROM product_overrides WHERE product_id = products.id AND field = 'min_samples'), CAST(products.min_samples AS TEXT)) AS INTEGER) AS min_samples,
	COALESCE((SELECT value FROM product_overrides WHERE product_id = products.id AND field = 'expiry_rule'), products.expiry_rule) AS expiry_rule,
	COALESCE((SELECT value FROM product_overrides WHERE product_id = products.id AND field = 'expiry_strictness'), products.expiry_strictness) AS expiry_strictness,
	products.origin, products.catalog_key, products.catalog_version, products.hidden
FROM products;