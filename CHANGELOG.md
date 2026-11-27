# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-11-27

The first stable release. From now on the tool contract follows [Semantic Versioning](docs/stability.md): a change that could break a client using it as documented needs a new major version. The project is feature-complete and in maintenance, so fixes for website changes, bugs and security issues continue and new features are unlikely.

### Added

- Read-only mode. With `CONTINENTE_READ_ONLY=1` (also allowed in the credentials file), or **Read-only** turned on in the Claude Desktop extension's settings, the server leaves out `add_cart_item`, `set_cart_item_quantity`, `remove_cart_item`, `clear_cart` and `set_cart_coupons`, so nothing can change the cart or the coupon selection. Every reading tool still works, `preview_cart_changes` included, and the server instructions tell the assistant to leave the changes to the user on the website. See [Read-only mode](docs/configuration.md#read-only-mode).
- An interactive `setup` command saves your Continente login in a private file, preserves its other settings and signs in once. Use `--no-login` to save the file only.
- A copyable install prompt and a [client guide](docs/clients.md) with manual setup, connection checks and an optional APM command.
- A `label-check` prompt and skill for allergen, gluten, vegan and nutrition questions. The assistant reads every candidate's label with `get_product_labels`, looks for the 14 EU allergens by their Portuguese names, treats "may contain traces" as a warning, never turns an unmentioned allergen into a "free from" claim, and reports what stays unknown. The server instructions mention it next to `basket-planner`. See [Instructions and prompts](docs/tools.md#instructions-and-prompts).
- One-click install buttons for VS Code, Cursor and LM Studio. They configure the npm command without adding credentials to the editor's settings.

### Changed

- Playwright 1.65.1, in the npm package and the Docker image. The server downloads the matching Chromium once, the first time it starts after updating.
- The README and the client guide point ChatGPT users to Continente's official ChatGPT app, and the README describes this project as a local, open-source server for Claude and the other MCP clients.
- The basket-planner prompt and skill now say what to report after emptying the cart or changing coupons, and to follow `mutation.recovery.action` after an uncertain change (`list_coupons` for coupons). They call `grandTotal` the current cart total, since a delivery fee can still be added at checkout.

### Fixed

- `add_cart_item`, and `set_cart_item_quantity` for a product not yet in the cart, refuse a product the website shows as unavailable with the new `product_unavailable` error before anything is sent (`outcome: not_applied`), so the assistant can say why and suggest an alternative ([#21](https://github.com/andredelgado/continente-mcp/issues/21)). They read the same add-button signal as `get_product`, and a missing or conflicting signal still leaves the decision to the website.
- A `cart_change_rejected` error now carries the website's own reason, as short plain text, when the website gives one.

## [0.16.1] - 2026-11-17

### Added

- The MCP Registry listing includes the Docker image as a third way to install, next to npm and the Claude Desktop extension. It gives clients the same `--init`, `--ipc=host` and `/data` volume settings as the [Docker](docs/configuration.md#docker) docs.

### Fixed

- A saved session replaced by another with the same modification time is now noticed. The server told sessions apart by the file's timestamp only, so a copy that kept its timestamp (`cp -p`, a restored backup) or a second save within the file system's time resolution left the previous session in use. It now compares the file's contents.
- A settled order read while the saved session was being replaced is no longer kept for the new session. The order cache took its account from the moment the page arrived rather than the moment it was requested, so a later `get_order` with the same ID could return the previous account's order from memory.
- A search result whose links point to different products is skipped and reported, instead of showing one product's name with another's ID. The ID came from the tile's first link and the name from the first link with text, without checking that both named the same product.
- `add_cart_item` on an existing line (one named by `cartItemId`, or a weighted line) no longer undoes a change made to that line on the website in the meantime. It worked out the new total from its first read of the cart and then set it, so an edit between its two reads was overwritten and the result was still reported as confirmed. The amount is now added to the line as it is read just before the write.
- `get_product_labels` reads a long label in one pass. Finding the "may contain" sentence took time that grew with the square of the label's length: over a second for 20 000 characters with no such sentence, and half a minute for 100 000, with the server busy throughout.

### Security

- Playwright's debug output no longer records the password or the session cookies. With `DEBUG=pw:api` (or `pw:*`, or `*`) set in the client's environment, Playwright logged each typed value, the password among them, and its protocol logs carried the cookies given to the browser. Those namespaces are now switched off before Playwright loads, and `pw:browser` and `pw:install` still work. See [Configuration](docs/configuration.md#sign-in-and-saved-session).
- Sign-in types the email and password only into a document on the Continente login page. The login frame was picked by its address once and then reused, so if it loaded another page before a field was filled, the value would have gone into that page. Each field is now held by its element and checked to be on `login.continente.pt` before anything is typed.
- The browser refuses cart and coupon writes (`Cart-AddProduct`, `Cart-UpdateQuantity`, the remove endpoints and `Cart-ApplyCustomerBenefits`) from the pages it opens to read products, orders or the cart. Script on those pages could otherwise have changed the cart with the account's cookies during a read-only tool. The cart tools' own requests are made outside the browser after their checks, so they are not affected.
- Chromium now starts with its own sandbox, which keeps a compromised page renderer away from the files your user can read. Playwright turns it off unless asked. On macOS and Windows it is always available. On Linux systems and containers that cannot provide it, the browser starts without it, and the server logs that once.
- The `choose_products` picker sends only each choice's number and the chosen product's ID as the user's message, for example `My choices (the product ID for each choice): 1. 4421406`. It used to include product names, pack sizes and the question text. Those come from the website and the tool call, and in a message sent as the user's own, any instruction hidden in them would read as the user's. The picker still shows them.
- The Windows setup in the README and [Configuration](docs/configuration.md#credentials-file) first resets the folder's permissions with `icacls /reset /T`. The earlier commands removed inherited permissions and set your own, but kept any permission given explicitly to another account, so a folder or credentials file from before could stay readable by others. A Windows CI test runs the documented commands on a folder and file that had extra grants.

## [0.16.0] - 2026-11-17

### Added

- A Docker image, `ghcr.io/andredelgado/continente-mcp`, published with each release for amd64 and arm64 and tagged with the version, the minor version and `latest` (prereleases only with their version). It is built from the `Dockerfile` contributed by [@andre0xFF](https://github.com/andre0xFF) in [#20](https://github.com/andredelgado/continente-mcp/pull/20), and checked to start and list every tool before it is pushed. [Docker](docs/configuration.md#docker) has the client configuration and how to sign in without a screen.

## [0.15.0] - 2026-11-12

### Added

- A `Dockerfile` that builds the server on the official Playwright image, running as a non-root user and keeping its data in `/data`, with a smoke check in CI that starts Chromium and lists the tools inside the container. The image is not published yet. Contributed by [@andre0xFF](https://github.com/andre0xFF) in [#20](https://github.com/andredelgado/continente-mcp/pull/20).

### Changed

- Sign-in errors and the `signIn.command` field now give `npx -y continentept-mcp login --show-browser`. Before, they gave `continentept-mcp login --show-browser`, which only works when the package is installed globally, not with the documented `npx` setup. A client that compares `signIn.command` with the old text needs updating.
- Where no sign-in window can open (Docker, Home Assistant, a server without a screen), the "Não sou um robô" answer now says to sign in with `login --show-browser` on a computer with a screen and copy `session.json` to the server's data directory. Before, it suggested running `login --show-browser` on the same machine, which cannot show a window there either. `login --show-browser` on Linux without a display now says the same instead of failing to start the browser.
- The Claude Desktop extension no longer requires an email and password to install. Without them, search, prices and product details work as they do with `npx`, and account tools ask you to add them in the extension's settings. A setting left empty is never used as a credential, even if it reaches the server as its unfilled `${user_config…}` placeholder.

### Fixed

- `preview_cart_changes` treats a product ID and that line's `cartItemId` as the same cart line. Before, listing both counted the line twice, so the products total after the changes could go negative and the preview failed. The second mention is now refused as listed more than once.
- A weighted cart line (sold by the piece, priced per kg) that omits its piece count no longer reads its kilograms as pieces. Before, a line holding 1 kg of 0.2 kg apples was read as 1 apple and could confirm a change to one. The count now comes only from the line's piece count, or from the cart page when that is missing or null, and otherwise stays unknown.
- `get_product_labels` text shows the allergen statement and "may contain" warning even when the website gives no ingredients or nutrition. Before, such a label read only as having no ingredients or nutrition, although the structured result kept the warning.
- `add_cart_item` takes the quantity rules from the product's own quantity control. Before, it used the first control on the product page, which could belong to a recommended product with another limit. Rules missing or contradicting each other for the product now refuse the add before anything is sent.
- `preview_cart_changes` keeps what the cart already charges for a line whose quantity stays the same. Before, it repriced the line at the unit price, so keeping three units on a multi-buy offer raised the preview's total.
- `set_cart_coupons` with an empty list no longer reports success while a coupon stays selected. Before, a checked coupon whose form fields were incomplete was left out of the cart's selection, so the clear sent nothing and was confirmed. Every checked coupon now counts as selected, `list_coupons` shows it as selected, and a clear is confirmed only when the cart then shows no checked coupon. Keeping such a coupon in a new selection is refused, as its fields cannot be sent. A checked box with a blank ID makes the selection unknown: a clear is still sent and confirmed only by an empty readback, and any other selection is refused before anything is sent. `list_coupons` then reports `cartSelection: "unknown"` (a new value) and leaves `selectedInCart` null for every coupon not known to be selected, instead of reporting 0 selected.
- A filtered `search_products` whose first five results pages hold no match now returns a cursor to the next pages when the website has more. Before, it returned no results, no cursor and `complete`, so a match on page six was never found. `scanned` now counts every product looked through, matched or not, instead of only those returned. The text then says no product matched in the products checked so far, instead of that none were found.
- `preview_cart_changes` previews a quantity of 0 from the cart line alone, as `set_cart_item_quantity` removes it. Before, it read the product page first, so a product still in the cart whose page no longer opens was refused and its total stayed in the products total after the changes. A 0 for a `cartItemId` no longer in the cart is now shown as no change, as applying it confirms, instead of refused.
- `set_cart_item_quantity` keeps its total when the product appears in the cart while it runs, for example added on the website. Before, it went on adding the requested amount on top and confirmed the sum (set to 2 could end at 5). The line is now set to the requested total, and only a readback of that total confirms it.

### Security

- The browser the server drives now checks every hop of a redirect before following it. Before, Playwright only checked the first request, so a redirect from an allowed page could still reach payment, order submission or another site. Each hop that would go there is now refused before it is sent. A regression test points real Chromium at a local server and asserts the forbidden destinations receive no request.
- Sign-in and cart checks made outside the browser no longer follow redirects.
- A window the website opens by itself (a form or link with a new-window target, or `window.open`) can no longer send a request before its redirect check is active. Before, its first request went out unchecked, so a redirect from an allowed address could deliver an order submission. Requests from such a window are now refused until it is guarded, and a regression test asserts the order endpoint receives none.
- Each cart tool now accepts only its own website operation. Before, any supported cart action with the right method was accepted, so a product form pointing at "remove all" could empty the cart from `add_cart_item`, and a quantity control pointing at remove could delete the line. Such a form or control is now refused before anything is sent, and the change is reported as not applied.
- A cart line whose quantity has an unknown or different unit no longer counts towards a change. Before, its raw amount was read as the requested unit, so a line reporting 2 with no unit could be confirmed as 2 un, or used as the starting point for an add. Such a line now refuses `add_cart_item` and `set_cart_item_quantity` before anything is sent (`sale_rules_unknown`), and a readback with an unknown unit leaves the change `unknown`. Removing the line still works.
- The saved session is now tied to the account that signed in. Before, a server configured with another email used the previous account's session, so its cart reads and writes went to that account's basket. A session saved for another account is now not used, and the configured account signs in instead. The session file records an opaque key, not the email. A session saved by an earlier version records no account, so with an email configured it is not used either, and the server signs in once to replace it. Without an email configured, as when a session is copied to a server with no credentials, any saved session is used as before.

## [0.14.0] - 2026-11-09

### Added

- `Leve 6 Pague 5` offers are recognised as `multi_buy`, with the new `takePay` field (`{ take: 6, pay: 5 }`). They were `other` before. `preview_cart_changes` says how many more units make the offer apply, as it does for `Leve 3 Por 1€`.
- Detergents are compared per wash: prices can be `per: "dose"`, and the website's `0,16€/dos` becomes the `unitPrice` and `secondaryPrice`. Before, they had no unit price and could not be sorted. `per` gains the value `dose`, so a client that lists the units should add it.
- `search_products` takes `promotion`, the website's own offer filter: `discount` for discounted products, including multi-buy offers, and `below_recommended_price` for products priced below the recommended price.

### Changed

- `search_products` with `sort: "unit_price"` now finds the cheapest products across the search, not just among those returned. It reads up to five results pages in the website's unit-price order and sorts them again by the prices read from each product, since the website's own order is not always right. The cursor pages through that sorted list. Before, it only reordered the products one call returned. A cursor now only continues a search with the same `sort` and `promotion`.
- `search_products` with `favoritesFirst: true` now finds favorites beyond the first page. A first page reads up to five results pages and returns the favorites found there before the other products, and the new `favoritesPromoted` says how many. Before, it only reordered the products already returned, so with the default `limit` of 10 a favorite further down was never moved up. Pages reached with the cursor leave out the favorites already returned, so following cursors still never skips or repeats a result.
- The browser now uses Lisbon time as well as the Portuguese locale, so dates on the website read as they do for a customer in Portugal wherever the server runs, including in a container that defaults to UTC.

## [0.13.0] - 2026-11-04

### Added

- `list_coupons` lists the Cartão Continente coupons on the account, with each one's `couponId`, description, benefit and availability as shown, and `selectedInCart`. `set_cart_coupons` makes exactly the given coupons the cart's selection, submitting the cart's own coupon form and confirming by reading the cart back; a coupon the cart does not offer is refused before anything is sent. An unconfirmed change is an error with `mutation.outcome: "unknown"` and `recovery.action: "list_coupons"`, never repeated automatically. Contributed by [@almeiduh](https://github.com/almeiduh) in [#11](https://github.com/andredelgado/continente-mcp/pull/11).
- `mutation.recovery.action` can now be `list_coupons` as well as `get_cart`: the tool to read before another change after an uncertain one.

### Security

- The browser the server drives refuses payment, order submission and delivery-slot reservation, whether the server or the website's own scripts ask for them, and never follows a page to another site. Cart changes are only sent to the website's known cart actions (add, update, remove, remove all) with their usual methods, so a changed or unexpected form action is refused instead of sent. Contributed by [@almeiduh](https://github.com/almeiduh) in [#11](https://github.com/andredelgado/continente-mcp/pull/11).

### Dependencies

- `@modelcontextprotocol/server` 2.4.0.

## [0.12.1] - 2026-10-26

### Fixed

- Signing in again works with Continente's new "Não sou um robô" check, which appears between the email and the password. Only a person can answer it, so the server never ticks it. When a tool needs to sign in and meets the check, it opens a Continente sign-in window on your computer with your email filled in and answers straight away; you tick the box and press "Avançar", and the window signs in, saves the session and closes. One window at a time, closing after 5 minutes. Where no window can be shown (Linux without a display, or `CONTINENTE_SIGN_IN_WINDOW=0`), the tool says to run `continentept-mcp login --show-browser`, which now waits for you to tick the box. Before, sign-in timed out on the password step. The `signIn` details of a sign-in error gain the `confirm_not_a_robot` action and a `signInWindow` field.
- The weekly site check opens the sign-in page, without signing in, and checks the email step our login relies on and whether the robot check is loaded. It runs signed out, so it could not see this change before.

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

[Unreleased]: https://github.com/andredelgado/continente-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/andredelgado/continente-mcp/compare/v0.16.1...v1.0.0
[0.16.1]: https://github.com/andredelgado/continente-mcp/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/andredelgado/continente-mcp/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/andredelgado/continente-mcp/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/andredelgado/continente-mcp/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/andredelgado/continente-mcp/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/andredelgado/continente-mcp/compare/v0.12.0...v0.12.1
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
