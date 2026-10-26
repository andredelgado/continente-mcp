# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.12.0] - 2026-10-26

### Added

- `preview_cart_changes` lines have the product's `promotions`, and the text says what a multi-buy or nth-unit offer means for the planned number of units: "Leve 3 Por 1€: 2 more make it 3 for €1.00", or "applies: 3 for €1.00 in the cart" once it does. The line's estimate stays at the shelf price, as the cart applies these offers.
- `npm run sync:server-json` brings the repository's `server.json` up to the published release (version, extension URL and checksum), and a test checks it names one release throughout. It listed 0.3.0 until now; the MCP Registry itself was always current.

### Dependencies

- Playwright 1.64.1. The server downloads the matching Chromium once, the first time it starts after updating.
- undici 7.30.1 (through cheerio), which fixes several security advisories. The server does not use the affected code, but `npm audit` flagged it.

## [0.11.0] - 2026-10-17

### Added

- [docs/stability.md](docs/stability.md) says what 1.0 will promise: the tool contract, what counts as a breaking change, the two lists that can grow (error codes and promotion kinds), and how something is deprecated.
- `get_cart` and `preview_cart_changes` have `checkout`: the minimum order the cart states (`minimumOrder`, `meetsMinimum`), whether the account has EntregaZero, and `deliveryFee`, which is `free` when EntregaZero applies (orders of €50 or more) and otherwise `set_at_checkout`, as the fee depends on the day, slot and area chosen at checkout. `preview_cart_changes` also gives `productsAfter`, the cart's products total once its lines are applied, and judges the minimum order and delivery on it. The text says, for example, "Minimum order: €20.00, reached." and "Delivery: free with your EntregaZero (orders of €50.00 or more).", or how much is still to go. The weekly site check confirms the €50 EntregaZero threshold on Continente's help pages.

### Changed

Contract review before 1.0. These change field names and shapes; clients that read `structuredContent` need updating.

- `preview_basket` is now `preview_cart_changes` (title "Preview cart changes"): it shows what `set_cart_item_quantity` would do to the cart.
- Unknown values are always `null` rather than left out: `cartItemId` and `disposition` on cart-change results, order `rawDate`, a quantity's `reason`, and `unknownQuantityLines` (0 when none) on frequently bought products.
- `list_orders` has one `failures` list, each with `stage`, `orderId`, `orderNumber` and `error`; `scanFailures` is gone.
- `list_frequently_bought_products` no longer returns `nextCursor`, which no input could use. When no order detail can be read, its statistics are in `result.scan`, inside the result envelope, instead of beside it.
- `observedAt` is on every result that reads the website: also `list_orders`, `get_order`, `list_frequently_bought_products` and the cart-change tools.

## [0.10.0] - 2026-10-16

### Added

- Promotions ([#6](https://github.com/andredelgado/continente-mcp/issues/6)). Search results, `get_product` and cart lines have `promotions`, each with the website's label and a `kind`: `recommended_price` (PVPR), `immediate_discount` (with `percentOff` or `amountOff` and the struck-through `previousPrice`), `multi_buy` (`Leve 3 Por 1€` as a `bundle` of 3 for €1.00), `nth_unit_discount` (`20% na 2ª un`), or `other` for a label not recognised. Product pages and the cart give `validFrom` and `validTo`. Cart lines also have `lineTotalBeforeDiscount` when the cart discounts the line, as for a multi-buy. The text output shows each offer beside the price. Built from 1,384 real tiles and a live cart check; card-only offers did not appear signed in or out.

### Changed

- The order tools read a settled order's details only once while the server runs. An order dated 14 or more days ago no longer changes, so its product lines are kept in memory for the signed-in account and reused by `list_frequently_bought_products`, `list_orders` and `get_order`; a different sign-in clears them. Recent orders and the order list are always read from the website. For a weekly shopper, a repeated frequently-bought scan of 10 orders loads about 3 pages instead of 11.

### Fixed

- A product that appears twice in search results, inside a tile for a family of pack sizes and in its own tile, now takes its prices, `recommendedPrice` and promotions from its own tile. Family tiles show "Desde" (from) prices and can carry another pack size's badge, which could give the wrong PVPR; a badge is now kept only when the product's own prices agree with it.

## [0.9.0] - 2026-10-16

### Added

- `choose_products` lets the user pick between candidate products for the choices an assistant should not make alone. All open choices of a request go into one call (at most 10, 2 to 4 candidates each, with a suggestion). Clients that support MCP Apps, such as Claude and ChatGPT desktop, show a picker with photos, pack, price per kg or litre and availability, in the client's own colours and fonts and usable with the keyboard, and send all the choices back as one chat message, after which it folds into a short list of what was chosen; other clients get a numbered text list. It changes nothing.
- Search results and `get_product` return `imageUrl`, the product photo on the website.
- Search results and `get_product` return `unitPrice`, the price to compare products by, with its `basis`: per drained kg, the website's own price per kg or litre, or the pack price divided by its net quantity.
- `get_product_labels` returns `status` (`complete`, `partial`, `none` or `error`) and `missing` per product, and each label has `netContent` and `issues`. `nutrition_basis_mismatch` flags nutrients per 100 ml for a product whose net content is in grams, or the other way round; the values are kept as given, not converted.

### Fixed

- `sort: "unit_price"` put packs without a website price per kg or litre last, so a 1 l soy drink at €0.79 came after others at €3.32/l. They are now compared on their pack price over the net quantity. The search text says the sort covers the products returned.
- `emphasised` no longer lists two-letter capitals such as `UE`, and the docs say plainly that it is typography, not an allergen list.

## [0.8.0] - 2026-10-16

### Added

- `clear_cart` empties the whole cart in one step with the website's own "remove all" action, instead of removing lines one by one, and confirms that no product lines remain. It needs `confirm: true`, does not write to an empty cart, and reports an unknown outcome, never retried, when the result cannot be confirmed.

## [0.7.1] - 2026-10-16

### Changed

- The server runs on the MCP server package (`@modelcontextprotocol/server` 2.x) instead of the full SDK, which also installed an HTTP server stack this stdio server never used. Installing it now brings 26 packages instead of 113, and the Claude Desktop extension is about 1.6 MB smaller. Tools, prompts and protocol versions are unchanged; task-augmented tool calls are still refused before they run.

## [0.7.0] - 2026-10-16

### Fixed

- `get_product` reported some products as available that could not be bought: the page's structured data said in stock while its add button was disabled. Availability now follows the page's own add button, with the structured data as a fallback.
- A product page the website redirects to its home page was reported as "no longer sold". It may only be hidden from this session: the same product can open signed in and redirect signed out, or not be sold in your area. The `not_found` message now says so.

- Some products sold by the piece but priced per kg, such as onions, were shown in the cart with the wrong number of pieces: 4 onions read as 1, so setting them to 4 always ended with an unknown outcome. For these products the cart's JSON does not count pieces; the quantity is now read from the kilograms on the cart page, and stays unknown when that is not a whole number of pieces.

### Changed

- **Breaking:** `search_products` keeps the website's relevance order. Saved favorites are still marked `favorite: true`, but only move to the top with the new `favoritesFirst: true`, and then only within the returned products.

### Added

- `search_products` filters by `category`, `excludeCategory` and `brand`, and sorts by `unit_price`. Results have `brand` and `category` (the website's category path), filtered searches read further pages to fill `limit`, and `unknownToFilter` counts products left out only because the results page gave no category or brand for them.
- `search_products` and `get_product` return `drainedPrice`, the price per kg of drained weight, for packs whose label states a drained weight.
- `get_product_labels`: ingredients, allergens and nutrition for up to 20 products, as the website's copy of each label declares them. It returns the ingredients verbatim, the words they print in capitals, the allergen and "may contain traces" statements, and nutrients per 100 g or ml. Nothing is inferred.
- Cart and `preview_basket` lines have `storefrontQuantity` for products sold by the piece but priced by weight: the kilograms in the cart, which are also the estimated weight. `get_cart` text shows it, as in "4 un (about 1.16 kg)".
- `search_products`, `get_product` and `preview_basket` return `catalogView`: whether the result is the signed-in or the signed-out catalogue, which can differ in availability and in which products open.
- Search results have `availability`, from the results page: `available` or `unavailable` when its "Indisponível" badge and add button agree, `unknown` otherwise. Unavailable results are marked in the text.
- `preview_basket`: for a list of products and desired totals, what the cart holds now, what `set_cart_item_quantity` would do, what would be refused and why, availability, pack details and the estimated cost. It changes nothing.
- `search_products` accepts `cursor`: pass `nextCursor` back with the same query to continue right after the last product returned. Following cursors never skips or repeats a result. Before, products read beyond `limit` were dropped and `nextCursor` could not be used.
- `search_products`, `get_product` and `get_cart` return `observedAt`, when the website was read.
- Cart lines and totals have `estimated`: products sold by the piece but priced by weight are charged by the weight picked, so their line total, and then the cart totals, are estimates. `get_cart` text says "about" for them.

- `search_products` and `get_product` return `package`, the pack label read into numbers: `count`, `each`, `net` (including any free extra), `drained` and `approximate`. For example, `6 x 1 lt` is 6 items of 1 l, 6 l in total. A label with an unknown part gives `null`.
- `get_product` returns `packageText` and `minimumText`, like `search_products`, and shows the pack size in its text.
- A `not_authenticated` error before any cart write carries `signIn`: whether credentials are configured, what to do next, the settings and command involved, and which tools work without signing in.

## [0.6.1] - 2026-10-15

### Fixed

- The first request after the browser started could fail with "The order history page was not recognised", or a search error, while the website was still setting up its session. A page that does not show what it should is now loaded once more.
- Order dates with abbreviated months, as the website now shows them ("01 Set 26"), are read. They were all `null`.
- `get_product` reports a product the website no longer sells as `not_found`, instead of `invalid_data`.
- After an upgrade, the update check no longer reports an older version as the latest one.

## [0.6.0] - 2026-10-15

### Changed

- **Breaking:** `get_cart` returns `totals` instead of `total`: `products`, `bags`, `deposit`, `delivery`, `discounts` and `grandTotal`, the amount to pay. The old `total` left out the bags, so it was less than the amount to pay.
- **Breaking:** cart line prices are `{ amount, per }` price tags, like catalogue prices, plus a `lineTotal`. Products sold by the piece but priced by weight were shown as a price "each" when it was the price per kg.

### Added

- Cart lines have a `kind`, `bag` for the shopping bags the website adds by itself and `product` for everything else.
- `search_products` and `get_product` return `recommendedPrice`, the recommended retail price (PVPR) the website shows beside the price on many promotions, so assistants can compare it with the selling price. ([#4](https://github.com/andredelgado/continente-mcp/pull/4), thanks [@Lozano-Miguel](https://github.com/Lozano-Miguel))

### Fixed

- Products sold by the piece but priced per kilogram (fruit, vegetables, meat, fish, counter cheese and ham) had no sale rules, so they could not be added to the cart. Their maximum is now read in kilograms, like the minimum and step, and converted to whole pieces.
- Cart quantities now have a unit. They were all reported as `unknown`; each line's unit now comes from its own sale rules, so a weighted line reads as pieces. A cart change is no longer confirmed by a line that reports another unit.

## [0.5.0] - 2026-10-15

### Fixed

- Searching for produce, meat and other products priced per kilogram failed with "Invalid money amount". Prices now record what they are for: per item, per piece, per kg or per litre.
- One unreadable search result no longer fails the whole search; the other results are returned as a partial result, and the unreadable one is described.
- Search results keep the website's relevance order. Products whose names merely resembled a favorite no longer jump ahead of better matches; exact favorites still come first.
- Favorites priced per kilogram are read correctly, and an unrecognised favorite price is reported as unknown instead of failing the refresh.

### Changed

- **Breaking:** catalogue prices (`price` in search, favorites and `get_product`) are now `{ amount, per }`. `unitPriceText` is replaced by `secondaryPrice`, and the search field `similarity` is removed. Saved favorites are fetched again once after updating.
- Search results include `packageText`, the pack size as shown on the website.
- Sign-in errors say whether no credentials are configured or Continente did not accept them, with the next step for each case. The instructions present the `basket-planner` prompt as optional, for clients that support prompts.
- Browser engine updated to Playwright 1.64 (Chrome 156). After updating, the new Chromium downloads automatically on first use (about 150 MB, once).

## [0.4.0] - 2026-10-15

### Added

- Update notice: once a day the server checks npm for a newer release and, if there is one, tells the assistant and reports it in `get_session_status`. Offline-safe; turn it off with `CONTINENTE_UPDATE_CHECK=0`.

### Fixed

- Documentation: how the home folder is chosen on Windows, what "readable only by your user" covers, when the favorites snapshot is refetched, and what deleting the data directory removes.

### Security

- A failed sign-in could write the account password or session cookies to the server log, because browser automation errors include what was typed and the request headers. Sign-in errors are now reported as fixed messages naming only the failed step.

## [0.3.1] - 2026-10-15

### Added

- Listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.andredelgado/continente-mcp`, with both the npm package and the Claude Desktop extension. Every release updates the listing.

## [0.3.0] - 2026-10-15

### Added

- One-click Claude Desktop extension (`continente-mcp.mcpb`) attached to every release. It asks for your email and password at install time.
- Chromium downloads automatically the first time it is needed; `install-browser` is now optional. While it downloads, tools return a retryable `browser_unavailable` error explaining the wait.

## [0.2.0] - 2026-10-15

### Added

- Server instructions: assistants receive the cart rules (exact totals, one change at a time, check the cart after an uncertain change) as soon as they connect.
- A `basket-planner` prompt with the full shopping workflow, with an optional request to plan for. No skill install is needed.
- Documentation for supplying credentials from 1Password with `op run`.

### Changed

- The `basket-planner` skill links to the online tool reference, so it also works when uploaded on its own.

## [0.1.0] - 2026-10-15

### Added

- Catalogue search and product details with exact prices, availability and sale rules.
- Cart tools that confirm every change by reading the cart back and report uncertain changes instead of retrying them.
- Favorites, order history and a ranking of frequently bought products.
- Automatic sign-in from environment variables or a private credentials file, and a `login` command.
- The `basket-planner` skill for planning a shopping list and updating the basket.

[Unreleased]: https://github.com/andredelgado/continente-mcp/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/andredelgado/continente-mcp/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/andredelgado/continente-mcp/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/andredelgado/continente-mcp/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/andredelgado/continente-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/andredelgado/continente-mcp/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/andredelgado/continente-mcp/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/andredelgado/continente-mcp/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/andredelgado/continente-mcp/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/andredelgado/continente-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/andredelgado/continente-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/andredelgado/continente-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/andredelgado/continente-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/andredelgado/continente-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/andredelgado/continente-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/andredelgado/continente-mcp/releases/tag/v0.1.0
