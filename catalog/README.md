# Catalog data

Catalog files contain public product facts, not household inventory or user overrides. Use source URLs for packaging, instructions, or manufacturer support material. Set `verified` only when the cited source confirms the corresponding facts. GTINs, pack quantities, and rated wear values affect matching and forecasts; do not guess them.

## Categories

Each item in `categories.json` describes a product category.

| Field | Purpose |
| --- | --- |
| `key` | Stable lowercase identifier used by products as `categoryKey`. Do not rename it after products reference it. |
| `name` | Human-readable category label shown in the app. |
| `overlapAllowed` | Whether multiple units in this category may be active at once. When false, starting a new unit ends the current active unit in that category. |

## Products

Each item in `products.json` describes a catalog product or package. Keys and non-null GTINs must be unique; `categoryKey` and `containsProductKey` must reference existing records. A package and its contained single product must also match on `manufacturer`, `ratedWearDays`, `minSamples`, `expiryRule`, and `expiryStrictness`, because those fields describe the individual usable item. Package-specific fields such as `key`, `name`, `gtin`, `containsQty`, `sourceUrl`, and `verified` may differ.

| Field | Purpose |
| --- | --- |
| `key` | Stable lowercase identifier for this catalog record. Other catalog records refer to it; changing it can break those references. |
| `categoryKey` | The `key` of the category this product belongs to. |
| `manufacturer` | Manufacturer name. |
| `name` | Product name displayed in the app. Add a pack-size qualifier when needed to distinguish package variants. |
| `gtin` | 14-digit product/package GTIN, including leading zeroes. Use `null` when unknown. Non-null values must have a valid check digit and cannot be reused by another product. |
| `containsProductKey` | Optional key of the single product contained in this package, such as a five-pack pointing to its single-item product. The child must be in the same category and cannot itself be a package. Use `null` when this is not a package of another catalog product. |
| `containsQty` | Number of usable units represented by one package. For a package linked with `containsProductKey`, this is the count of contained products; it must be positive. Use `null` only when the quantity is unknown and no contained-product link requires it. |
| `ratedWearDays` | Manufacturer-rated intended use duration in days. It is the forecast fallback until enough measured duration samples exist; `null` means no rated fallback is known. |
| `minSamples` | Number of completed measured durations required before the forecast uses the product's observed median wear duration instead of `ratedWearDays`. |
| `expiryRule` | How expiry constrains planning: `finish_by` means a unit should be started early enough to finish by expiry; `start_by` means it should be started by expiry; `none` adds no planner deadline. Actual expired stock is still excluded. |
| `expiryStrictness` | `hard` makes an expiry deadline a planner constraint. `soft` treats dated stock as flexible filler rather than a hard deadline and is reported with forecast caveats. |
| `sourceUrl` | HTTP(S) link to the source used for the product facts, preferably the package, instructions, or manufacturer support page. |
| `verified` | Whether the source has been checked against the catalog facts. Keep false when a GTIN, quantity, or other detail still needs confirmation. |

## Barcode formats

Each item in `barcode_formats.json` describes a non-GS1 barcode layout associated with a product. GS1 barcodes use the app's general GS1 parser instead.

| Field | Purpose |
| --- | --- |
| `key` | Stable lowercase identifier for this format rule. |
| `productKey` | The product `key` this barcode layout identifies. |
| `pattern` | Regular expression that recognizes the barcode text. |
| `fields` | Mapping from regex capture-group names to semantic values: `gtin`, `expiry`, `lot`, or `serial`. Use the same group names in the regex and this map. |
| `sourceUrl` | HTTP(S) reference documenting the barcode layout, preferably packaging or manufacturer documentation. |
| `verified` | Whether the pattern and field mapping have been checked against a real barcode and its source. |

The app currently validates and syncs these rules, but barcode decoding does not yet consume them.

## Manifest

`manifest.json` describes a catalog release and the exact data files it contains.

| Field | Purpose |
| --- | --- |
| `version` | Release identifier in `YYYY.MM.DD` or `YYYY.MM.DD.N` format. Bump it whenever any catalog data file changes; sync skips downloads when this version already succeeded. |
| `schemaVersion` | Version of the catalog data structure, not the release. The app rejects versions newer than it supports. |
| `files` | Required map of data filenames to lowercase SHA-256 checksums of their exact file contents. |
| `files.categories.json` | Checksum for `categories.json`. |
| `files.products.json` | Checksum for `products.json`. |
| `files.barcode_formats.json` | Checksum for `barcode_formats.json`. |

`$schema` at the top of each schema file selects the JSON Schema 2020-12 vocabulary; it is schema metadata, not a catalog data field. The other schema keywords (`type`, `required`, `additionalProperties`, and so on) define structure and constraints. Unknown data fields are rejected.

## Validation

Run `npm run catalog:validate` after changing catalog data. After editing any of the three data files, update the manifest release version and regenerate hashes with `npm run catalog:checksums`, then run the validator again. Schema changes may also require a `schemaVersion` increase and matching app support.