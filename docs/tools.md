# Tool reference

Continente MCP exposes 21 tools, server instructions and one prompt. Every tool has a strict
input schema (unknown fields are rejected), an output schema, a title and the four MCP
behaviour annotations.

| Tool | Login | Changes the cart | Inputs |
| --- | --- | --- | --- |
| `search_products` | No | No | `query`, `limit` (1–50, default 10), `cursor?`, `favoritesFirst` (default `false`), `category?`, `excludeCategory?`, `brand?`, `sort` (default `relevance`) |
| `get_product` | No | No | `productId` |
| `get_product_labels` | No | No | `productIds` (1–20) |
| `choose_products` | No | No | `decisions` (1–10 of `question`, `productIds` (2–4), `suggested?`) |
| `list_favorites` | Yes | No | `refresh` (default `false`) |
| `get_cart` | Yes | No | — |
| `preview_cart_changes` | Yes | No | `items` (1–30 of `productId`, `quantity` ≥ 0, `cartItemId?`) |
| `get_checkout_summary` | Yes | No | — |
| `list_coupons` | Yes | No | — |
| `set_cart_coupons` | Yes | Yes | `couponIds` (IDs returned by `list_coupons`) |
| `list_pickup_stores` | No | No | `postalCode`, `latitude`, `longitude`, optional `city` |
| `list_pickup_slots` | Yes | No | `fromDate`, `toDate` (ISO dates, at most 31 days inclusive) |
| `set_pickup_store` | Yes | Yes (store context) | `storeId`, `fromDate`, `toDate` (recovery window, at most 31 days inclusive) |
| `add_cart_item` | Yes | Yes | `productId`, `quantity` (> 0, default 1), `cartItemId?` |
| `set_cart_item_quantity` | Yes | Yes | `productId`, `quantity` (≥ 0), `cartItemId?` |
| `remove_cart_item` | Yes | Yes | `productId`, `cartItemId?` |
| `clear_cart` | Yes | Yes | `confirm` (must be `true`) |
| `list_orders` | Yes | No | `limit` (1–50, default 5), `includeLines` (default `true`), `detailLimit?` (0–50), `cursor?` |
| `get_order` | Yes | No | `orderId` |
| `list_frequently_bought_products` | Yes | No | `orderLimit` (1–50, default 10), `limit` (1–50, default 25) |
| `get_session_status` | No | No | — |

"Login" means the tool reads the account. If the saved session has expired, the server signs in
again once with the configured credentials before reporting `not_authenticated`.

## Identifiers

| Field | Meaning |
| --- | --- |
| `productId` | Numeric product ID as a string. Leading zeroes matter (`"00123"`). Inputs also accept a product slug ending in the ID, such as `leite-meio-gordo-00123`, optionally with `-master` or `.html`. Full URLs are not accepted. |
| `cartItemId` | One cart line, from `get_cart`. Needed only when a product has more than one line. |
| `orderId` | Internal order ID from `list_orders`, used by `get_order`. |
| `orderNumber` | The order number shown on the website. Display only. |

## Results

Every call returns text content and `structuredContent.result`:

```json
{ "result": { "status": "success", "data": { "...": "..." } } }
```

| `status` | Meaning |
| --- | --- |
| `success` | The request completed. |
| `empty` | The request completed with nothing to return. |
| `partial` | Some work failed; the data that was read is included along with the failures. |
| `error` | `isError` is `true` and `result.error` has `code`, `message` and `retryable`. |

The text content is a readable summary that includes every identifier needed for follow-up
calls, for clients that do not pass structured content to the model.

### Values

- **Money** is `{ "currency": "EUR", "minorUnits": 129 }` (€1.29).
- **Catalogue prices** (search, favorites, `get_product`) are `{ amount, per }`, saying what the
  price is for: `item` (one pack or article), `piece` (one unit, often approximate for
  produce), `kg` or `l`. Produce and meat show their main `price` per kg, with an approximate
  per-piece `secondaryPrice`; packaged goods show the pack price with a per-kg or per-litre
  `secondaryPrice`. A price per kg or per litre is not the price of one pack. An unknown or
  unrecognised price is `null`.
- **Cart prices** use the same `{ amount, per }` price tags: `per` is `item`, or `kg` for
  products sold by the piece but priced by weight. Each cart line also has `lineTotal`.
- **Quantities** are `{ value, unit }` with unit `un`, `kg`, `g`, `l` or `ml`. Quantities read
  from the website are either `{ status: "known", quantity }` or
  `{ status: "unknown", value, rawText, reason }`; an unknown unit is never guessed, and
  `reason` is `null` when the server cannot tell why.
- **Unknown values** are `null`, never left out: every field a tool lists is always present.
- **`observedAt`** says when the website was read, on every result that reads it (all tools
  except `get_session_status` and `list_favorites`, which has `fetchedAt`).
- **Completeness** (`complete`, `partial`, `unknown`) describes the pages that were read, not
  the whole catalogue or account history. Searches read at most five result pages and order
  listings at most ten.

## Catalogue

### `search_products`

Searches the public catalogue. Results keep the website's order, which reflects relevance to
the query, except that products in your saved favorites move to the front (`favorite: true`).
Search uses the local favorites snapshot and never signs in to refresh it.

Each product has `productId`, `productSlug`, `name`, `url`, `price`, `secondaryPrice`,
`packageText` (the pack size as shown, such as `940 gr`, `2 x 52 gr` or
`400 gr (peso escorrido 260 gr)`), `package`, `minimumText` (a minimum purchase such as
`600 gr (3 un)`), `recommendedPrice`, `availability`, `brand`, `category`, `drainedPrice`,
`unitPrice`, `promotions`, `imageUrl` (the product photo on the website) and `favorite`.

- `category` is the website's category path, such as
  `Supermercado/Congelados/Frutas e Legumes/Legumes`, and `brand` its brand; either is `null`
  when the results page does not give it.
- `unitPrice` is the price to compare products by, with its `basis`: `drained` (per kg of drained
  weight), `website` (the website's own price per kg or litre) or `pack` (the pack price divided
  by its net quantity, when the website gives no price per kg or litre). It is `null` for packs
  counted in units, such as `12 un`.
- `drainedPrice` is the price per kg of drained weight (`peso escorrido`), worked out from the
  pack price and the label's drained weight. It is given only for a single pack whose label
  states one, such as a can of tuna. For preserves the website's own `secondaryPrice` per kg is
  often already per drained kg; the two differ when the website works from another weight than
  the label (seen on one can of tuna: €13.53/kg against €14.74/kg from its 78 g drained).

Filters narrow a search to what is asked for. `category` keeps products whose category path
contains the text (`Congelados/Frutas e Legumes`, `Mercearia`), `excludeCategory` leaves out
those that do (`Animais`, so "tofu" does not return cat litter), and `brand` keeps products whose
brand contains it (`Continente`). Case and accents are ignored. A product whose category or brand
is unknown is left out by `category` and `brand`, and kept by `excludeCategory`; `unknownToFilter`
counts the products left out only for that reason, so a search without the filter can show them.
Filtered searches read further pages, up to five, to fill `limit`.

`sort: "unit_price"` orders the returned products cheapest first by `unitPrice`, those per kg
before those per litre; products without one come last in their original order. Sorting reorders
only the products this call returns, not the whole catalogue, so cursors still continue exactly;
raise `limit` to compare more candidates.

`availability` is what the results page offers: `available` when the product has an add button
and no "Indisponível" badge, `unavailable` when it has the badge and no button, and `unknown`
when the two disagree or are missing. Check `get_product` before relying on it for a cart change.

`package` is the pack label read into numbers, or `null` when any part of the label is not a
known pattern:

| Field | Meaning | `6 x 1 lt` | `400 gr (peso escorrido 260 gr)` | `12 rolos` |
| --- | --- | --- | --- | --- |
| `count` | Items in the pack | 6 | 1 | 12 |
| `each` | Quantity of one item | 1 l | 400 g | `null` |
| `net` | Total quantity, including any free extra | 6 l | 400 g | `null` |
| `drained` | Drained weight of preserves | `null` | 260 g | `null` |
| `approximate` | The weight is approximate, as for produce sold by the piece | `false` | `false` | `false` |

Centilitres are given in millilitres (`75 cl` is 750 ml), and a free extra such as
`120 gr + 30 gr GRÁTIS` counts in `net` (150 g).

`recommendedPrice` is the recommended retail price (PVPR) the website shows beside the price
on many promotions, or `null` when it shows none. Compare it with `price` rather than treating
its presence as a discount.

#### Promotions

`promotions` lists the promotions the website shows for a product, and is empty when there are
none. Each has the website's own `label` and a `kind`:

| `kind` | Label | Structured fields |
| --- | --- | --- |
| `recommended_price` | `PVP Recomendado: 2,71€/un` | `previousPrice`: the PVPR |
| `immediate_discount` | `Desconto Imediato: 6%` or `Desconto Imediato: 3€` | `percentOff` or `amountOff`; `previousPrice`: the struck-through price |
| `multi_buy` | `Leve 3 Por 1€` | `bundle`: `{ quantity, total }` |
| `nth_unit_discount` | `20% na 2ª un` | `percentOff` and `nthUnit` (2 for the second unit) |
| `other` | anything else | none |

Fields that do not apply, or that the label does not state, are `null`. `previousPrice` is for
the same unit as `price`. The price shown already includes a recommended price or an immediate
discount; a multi-buy or nth-unit offer is applied by the cart, so `price` does not include it.
`validFrom` and `validTo` are the promotion's first and last days (Lisbon dates). Product pages
and the cart give them; search results do not. A product page gives a single date line, so the
dates are kept only when the product has one promotion.

```json
{ "kind": "multi_buy", "label": "Leve 3 Por 1€", "previousPrice": null, "percentOff": null,
  "amountOff": null, "bundle": { "quantity": 3, "total": { "currency": "EUR", "minorUnits": 100 } },
  "nthUnit": null, "validFrom": "2026-09-29", "validTo": "2026-10-18" }
```

A result the server cannot read does not fail the search. It is skipped, or kept with an
unknown price when only the price is unreadable, and described in `failures`; the result is
then `partial`.

`data`: `observedAt`, `catalogView`, `products`, `scanned`, `returned`, `favoritesLoaded`,
`completeness`, `failures`, `nextCursor`, `unknownToFilter`.

`catalogView` says whose view of the catalogue the result is, from the server's last sign-in
check: `signed_in`, `signed_out` (also when there is no saved session at all) or `unknown`.
Availability, and whether a product page opens at all, can differ between the two.
`get_product` and `preview_cart_changes` return it too.

Results keep the website's relevance order. Products in your saved favorites are marked
`favorite: true`; pass `favoritesFirst: true` to move them to the top of the returned products.

To see more results, call `search_products` again with the same `query` and `cursor` set to
`nextCursor`. It continues right after the last product returned, so following cursors never
skips or repeats a result. `nextCursor` is `null` when there is nothing more, and a cursor
only works with the query it came from.

### `get_product`

Returns `productId`, `productSlug`, `name`, `url`, `price`, `secondaryPrice`, `recommendedPrice`,
`promotions` (with their dates), `packageText`, `package`, `minimumText` and `drainedPrice` (as in `search_products`), `availability`
(`available`, `unavailable` or `unknown`) and `saleRules`:

```json
{ "status": "available", "rules": { "saleUnit": "un", "storefrontUnit": "un", "storefrontUnitsPerSaleUnit": 1,
  "minimum": { "value": 1, "unit": "un" }, "maximum": { "value": 10, "unit": "un" }, "step": { "value": 1, "unit": "un" } } }
```

Cart quantities are always in `saleUnit`. Products priced per kilogram but sold by the piece
(fruit, meat, fish) have `saleUnit: "un"` and `storefrontUnit: "kg"`: their minimum, maximum and
step are whole pieces, and `storefrontUnitsPerSaleUnit` is the approximate weight of one piece.
If the website's rules cannot be interpreted safely, `saleRules` is
`{ "status": "unavailable", "error": ... }` and the result is `partial`. Availability follows the
product page's own add button: a disabled button means `unavailable`, even when the page's
structured data still says in stock. It reflects the page as the server's session sees it, not
delivery-slot stock: signed in, the
website can show a different availability than in the public catalogue, so the same product can
read `available` signed out and `unavailable` in your account. A product page the website does
not show to this session returns `not_found`: the product may not be sold in your area, or no
longer be sold. Signed in and signed out can differ here too.

### `choose_products`

Lets the user pick between candidate products, for the choices an assistant should not make on
its own: two brands of milk, 500 g against 1 kg. It takes all the open choices of a request at
once, at most 10, each with a short `question`, 2 to 4 `productIds` and an optional `suggested`
one, and changes nothing.

In clients that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (Claude,
ChatGPT desktop, VS Code and others) it shows a picker: each choice as a row of products with
photo, pack, price, price per kg or litre and availability, the suggestion preselected and a
"none of these" option. The user confirms once, and the picker sends all the choices as one chat
message, for example `My choices: 1. Leite meio gordo: Leite UHT Meio Gordo Mimosa (6 x 1 lt)
[4421406]`. Other clients get the same choices as a numbered text list, and the user replies in
the chat. Either way the assistant then changes the cart with `set_cart_item_quantity`.

Products already seen in a search or `get_product` are shown without reading them again; others
are read from their product page. `data`: `observedAt` and `decisions`, each with `question`,
`suggested`, `options` and `failures` (candidates that could not be shown).

The picker is a small page served as the resource `ui://continentept-mcp/choose-products.html`.
It loads photos only from `www.continente.pt` and needs no script from anywhere else.

### `get_product_labels`

Ingredients, allergens and nutrition for up to 20 products, as the website's copy of each label
declares them. Call it only when a task needs them, such as checking that a product is vegan or
free of an allergen, or adding up protein; `get_product` stays fast without it.

`data`: `observedAt` and `labels`, one per product with `productId`, `name`, `label`, `error`,
`status` and `missing`. `status` is `complete` (ingredients and nutrition), `partial` (one of
them), `none` (neither on the website, as for most fresh produce and some packaged goods) or
`error` (the label could not be read; see `error`). `missing` lists the fields the website does
not give: `ingredients`, `allergenStatement` or `nutrition`. `label` is `null` when the website
shows no label information at all. Otherwise:

| Field | Meaning |
| --- | --- |
| `regulatedName` | The product's legal name |
| `netContent` | The net content the label states, such as 500 g |
| `issues` | Inconsistencies in the website's data, kept as given: `nutrition_basis_mismatch` when nutrients are per 100 ml of a product whose net content is in grams, or the other way round |
| `ingredients` | The ingredient list, verbatim |
| `emphasised` | Words of three or more letters printed in capitals in the ingredients, such as `SOJA` or `TRIGO`. Labels mark allergens this way, but this is typography, not an allergen list: it also catches abbreviations such as `EDTA` |
| `allergenStatement` | What the website files as the allergen statement, such as `Contém Leite.`; sometimes another text, such as a nutrition claim |
| `mayContain` | The "may contain traces of" sentence, from the statement or the ingredients |
| `storage` | Storage instructions |
| `nutrition` | `per` (such as 100 g or 100 ml) and `nutrients`, each with `name`, `key`, `amount` and `unit` |

`key` is one of `energy_kj`, `energy_kcal`, `fat`, `saturated_fat`, `carbohydrates`, `sugars`,
`fibre`, `protein` and `salt`, or `null` for others such as vitamins.

Nothing is inferred. Not every label capitalises its allergens (one biscuit lists
`Farinha de trigo`), so read `ingredients` as well as `emphasised`, and an allergen missing from
these fields is not a "free from" claim. The website's copy can lag behind the packaging, which
prevails. Reading a label costs one small request once `get_product` has read the product,
otherwise also the product page.

## Favorites

### `list_favorites`

Returns the favorites saved on the account from a local snapshot. The snapshot is fetched
automatically when missing, is marked `stale` after 24 hours, and is replaced when you pass
`refresh: true`. A failed refresh keeps the previous snapshot.

`data`: `favorites`, `fetchedAt`, `expiresAt`, `source` (`cache` or `website`), `freshness`
(`fresh` or `stale`), `cacheState` (`empty` or `populated`), `completeness`.

Favorites can include products the website no longer shows, still with their last price. Check
with `get_product` before adding one to the cart; it returns `not_found` for those.

## Coupons

### `list_coupons`

Reads coupon cards already rendered on the signed-in account coupon page. Each result returns the
displayed coupon identifier, description, availability text and benefit badge when present.
`eligibility` is always `unknown` and `expiry` is `null`: the account card does not establish
cart-specific eligibility, expiry or stacking. A complete empty list is reported only when the
page shows its visible empty-state marker. `benefitQualifier` carries the displayed qualifier
when present.

`data`: `observedAt`, `coupons`, `completeness`.

### `set_cart_coupons`

Sets the cart's selected coupon set using IDs returned by `list_coupons`. The server freshly reads
the basket form and sends its current description, amount, unit and carousel flag; callers cannot
provide or override those fields. It reads the basket again and reports `outcome: confirmed` only
when the live checkbox state matches the requested set. `outcome: unknown` means the request may
have changed the cart; use `get_checkout_summary` before making another coupon change. The request is
never replayed automatically. An empty `couponIds` array requests clearing the selection.

`data`: `observedAt`, `outcome`, `selectedCouponIds`. On an unknown outcome, `selectedCouponIds`
is `null` if the post-write selection could not be read. `lastObservedSelectedCouponIds` preserves
the last readable selection, which may predate the write, and `recovery` specifies
`{ action: "get_checkout_summary", automaticReplay: false }`. If readback succeeds but disagrees
with the requested set, `selectedCouponIds` contains that observed set while the outcome stays
unknown. An empty array means an observed empty selection; it never substitutes for missing data.

## Pickup stores

### `list_pickup_stores`

Uses the observed locator AJAX GET contract with a Portuguese postal code and public coordinates,
then parses pickup-capable store rows from the returned HTML. If the page exposes a next-chunk
continuation, `completeness` stays `unknown`; the tool reports only the returned page. Coordinates
must be provided by the caller; the server does not access a geocoding service or browser
geolocation. `city` is optional.
`selectedStoreChanged` is always `false`; this tool does not call the store-context endpoint. It
does not list fees or inventory.

`data`: `observedAt`, `stores`, `completeness`, `selectedStoreChanged`.

### `list_pickup_slots`

Reads the existing delivery page through a direct GET and parses the slot data already embedded
in its HTML. It requires an explicit upcoming date window within the next 31 inclusive dates and
confirms one primary pickup step, its selected radio, current store marker, and matching shipment
IDs before reporting slots. If this context cannot be verified, it returns no slots and
`completeness: "unknown"`. The website's date labels omit the year; the parser resolves a displayed
day and Portuguese month only against that bounded upcoming window. `dateYearBasis` records that
interpretation.

The result covers server-rendered days only, so it can list observed times but always reports
`partial` when slots are present. It does not execute page JavaScript, request additional dates,
expose shipment or reservation identifiers, change the store, reserve a slot, or open payment.
`selectedStoreChanged` and `slotReserved` are always `false`: the tool submits neither mutation.
These flags do not establish that the retailer's GET handler has no server-side effects.

`data`: `observedAt`, `catalogView`, `pickupMode`, `selectedStoreId`, `storePostalCode`, `dateWindow`, `dateYearBasis`, `coverage`, `slots`,
`completeness`, `selectedStoreChanged`, `slotReserved`.

`catalogView` reports the session's last observed sign-in state (`signed_in`, `signed_out` or
`unknown`); it is not inferred from the presence of slot rows. This is a pickup-only subset of
[issue #7](https://github.com/andredelgado/continente-mcp/issues/7), not its complete delivery-slot
proposal. Home-delivery slots, explicit availability states and minimum-order/free-delivery
thresholds are not exposed by this tool. Live-account validation with redacted response fixtures
and confirmation that reading slots has no account or cart side effects remain follow-up work.

### `set_pickup_store`

Changes the selected primary pickup store to a `storeId` returned by `list_pickup_stores` only
when pickup mode is already selected and that ID is also a fresh selectable choice on the delivery page. It does not switch from home delivery to pickup; that transition is not supported by the verified current page contract. The server reads the exact
store coverage endpoint, then submits the observed store-context form once and fetches the delivery
page again to verify that both the current-store marker and selected radio match. It does not use
the multi-shipment address update path or locator's context-changing controls.

The result is `confirmed`, `not_applied`, or `unknown`. A confirmed change sets
`cartAndCouponsNeedRevalidation: true`; read the cart and coupons again because store context can
affect them. An unknown result is never replayed and includes `list_pickup_slots` recovery with the
caller-supplied date window. A no-op for the already selected store is confirmed without a write.
This operation does not reserve a slot or open payment. Slot auto-selection performed by the
retailer page itself is outside this operation; the MCP reads that page only through direct HTTP.

Every result includes `observedAt`, including confirmed no-ops and unknown outcomes. The time
records when the inspection finished; an unknown outcome remains unconfirmed.

## Cart

### `get_cart`

`data`: `observedAt`, `customerAuthenticated`, `items` (each with `productId`, `cartItemId`,
`name`, `kind`, `quantity`, `price`, `lineTotal`, `estimated`, `promotions`,
`lineTotalBeforeDiscount`) and `totals`.

- `kind` is `bag` for the shopping bags the website adds to the cart by itself, and `product`
  for everything else.
- `quantity` is in the line's sale unit, read from the line's own sale rules: pieces (`un`) for
  products sold by the piece but priced per kg, `un` for everything else. A line without
  recognisable sale rules keeps its amount with an unknown unit. For some weighted products the
  cart's JSON does not count pieces, so the server reads the kilograms in the cart from the cart
  page and divides them by the weight of one piece; when that is not a whole number, the quantity
  stays unknown.
- `price` is the unit price with what it is for: per item, or per kg for products sold by the
  piece (2 apples at €2.99/kg cost less than €5.98). `null` when the line does not say what its
  price is for. `lineTotal` is the line's total as the website reports it.
- `promotions` are the line's promotions, as in [`search_products`](#promotions), with their
  dates. When the cart discounts the line itself, as it does for a multi-buy (3 for €1.00),
  `lineTotal` is after the discount and `lineTotalBeforeDiscount` before it; otherwise
  `lineTotalBeforeDiscount` is `null`.
- `storefrontQuantity` is what the website holds in its own unit for products sold by the piece
  but priced by weight: the kilograms in the cart, such as 1.16 kg for 4 onions of 0.29 kg,
  which is also their estimated weight. It is `null` for other products. `preview_cart_changes` lines
  have it too, for the desired total.
- `estimated` is `true` for products sold by the piece but priced by weight: they are charged by
  the weight picked, so their `lineTotal` is an estimate. `totals.estimated` is `true` when any
  line is, and then `products` and `grandTotal` are estimates too.
- `totals` holds each amount as the website reports it, or `null` when it reports none:

  | Field | Meaning |
  | --- | --- |
  | `products` | Product lines only, without bags or deposit |
  | `bags` | The bag lines |
  | `deposit` | Bottle and can deposit (SDR) |
  | `delivery` | Delivery cost as the cart has it now: €0 until a delivery slot is chosen at checkout (see `checkout`) |
  | `discounts` | Amount taken off by order and delivery discounts |
  | `grandTotal` | The amount to pay as the website shows it. It includes the bags. |
  | `estimated` | Some lines are charged by weight, so `products` and `grandTotal` are estimates |

  Report `grandTotal` as the amount to pay, and don't add the other fields to it yourself.
- `checkout` says what checkout adds or requires beyond the lines, judged on `totals.products`:

  | Field | Meaning |
  | --- | --- |
  | `minimumOrder` | The website's minimum order value, as the cart states it (€20 in October 2026) |
  | `meetsMinimum` | Whether the products total reaches it; `null` when either is unknown |
  | `entregaZero` | Whether the account has an active EntregaZero subscription; `null` when signed out |
  | `freeDeliveryFrom` | With EntregaZero, delivery is free from this products total (€50); `null` without it |
  | `deliveryFee` | `free` when EntregaZero applies to this total; otherwise `set_at_checkout` |

  The delivery fee depends on the day, time slot and area chosen at checkout, so it is not in the
  totals until then. An order the website splits into several deliveries is charged only the
  highest of their fees. The €50 EntregaZero threshold is not in the cart's data: it comes from
  Continente's help pages, and the weekly site check confirms they still say so.

### `preview_cart_changes`

Shows what `set_cart_item_quantity` would do for a list of products and desired totals, without
changing anything. It reads the cart once and each product page once, so it takes about a
second per item.

`data`: `observedAt`, `lines`, `estimatedCost` (the sum of the lines that would be applied, or
`null` when any of their costs is unknown), `estimated`, `problems` (lines that would be
refused or whose product is not available), `productsAfter` (the cart's products total once the
lines are applied: the current total with these lines at their estimated cost, or `null` when any
part is unknown) and `checkout` (as in [`get_cart`](#get_cart), for `productsAfter`). Each line has:

| Field | Meaning |
| --- | --- |
| `productId`, `cartItemId`, `name` | The product, and the cart line it would change |
| `requested` | The desired total, in the sale unit |
| `storefrontQuantity` | The desired total in kg, for products sold by the piece but priced by weight |
| `current` | What the cart holds now; zero when the product is not in it |
| `change` | `add`, `increase`, `decrease`, `remove` or `none`; `null` when it would be refused |
| `error` | Why it would be refused, such as `quantity_below_minimum` or a fractional number of pieces |
| `availability`, `price`, `packageText`, `package`, `saleRules`, `promotions` | As in `get_product` |
| `estimatedCost`, `estimated` | The desired total at today's price, before any multi-buy or nth-unit offer (the cart applies those); `estimated` for products charged by weight |

The text adds what an offer means for the planned number of units, such as
`Leve 3 Por 1€: 2 more make it 3 for €1.00` or `Leve 3 Por 1€ applies: 3 for €1.00 in the cart`.

A preview is not a reservation: prices and stock can change before you apply it, and each change
is still confirmed by `set_cart_item_quantity`. `package` helps catch a mix-up such as six
cartons of milk instead of one pack of six.

### `get_checkout_summary`

Reads the basket-stage totals and the loyalty credit currently displayed under “Acumula em
Cartão”. `immediateDiscounts` mirrors the reported order and shipping discounts in the cart
totals; it is not a measure of all savings, and does not include discounts already embedded in
line prices. `loyaltyCredit` is a separate earned-credit amount and is never subtracted from
`grandTotal`. `selectedCouponIds` is
`null` when the basket page does not expose selected checkboxes. `stage` is `basket` and
`provisional` is always `true`: this is not a final delivery or checkout quote.

`data`: `observedAt`, `stage`, `provisional`, `totals`, `immediateDiscounts`, `loyaltyCredit`,
`selectedCouponIds`.

### Changing the cart

| Tool | Behaviour |
| --- | --- |
| `add_cart_item` | Adds `quantity` to whatever is already in the cart. Not idempotent. |
| `set_cart_item_quantity` | Makes the cart hold exactly `quantity`, adding the product if it is absent. Zero removes it. Repeating the same call makes no further change. |
| `remove_cart_item` | Removes the line. If it is already absent, succeeds without a write (`disposition: "already_absent"`). |
| `clear_cart` | Empties the cart with the website's own "remove all" action, then confirms that no product lines remain. Needs `confirm: true`. An empty cart is not written to (`disposition: "already_empty"`); otherwise `removedLines` says how many product lines it held. |

Quantities are validated against the product's sale rules (minimum, maximum, step and
three-decimal storefront precision) before anything is sent. An invalid amount fails with
`invalid_input` or `quantity_below_minimum` and is never rounded. Every successful change is
confirmed by reading the cart back:

```json
{ "result": { "status": "success", "data": { "outcome": "confirmed", "productId": "00123",
  "requested": { "value": 2, "unit": "un" }, "confirmedQuantity": { "value": 5, "unit": "un" },
  "cartItemId": null, "disposition": null, "observedAt": "2026-10-16T12:00:00.000Z" } } }
```

`requested` is the amount from the call (the increment for `add_cart_item`);
`confirmedQuantity` is the quantity now in the cart. `cartItemId` is the line the call named, or
`null`. `disposition` is `removed` or `already_absent` for a removal (including a quantity of 0),
and `null` otherwise.

#### Failed and uncertain changes

A failed change has `isError: true` and a `mutation` field:

- `{ "outcome": "not_applied" }`: nothing was submitted, or the website rejected the change.
- `{ "outcome": "unknown", "recovery": { "action": "get_cart", "automaticReplay": false } }`:
  the request was sent but could not be confirmed (timeout, cancellation, lost response or
  failed readback). **The cart may have changed.** Call `get_cart` and decide from the actual
  state. Never repeat the request automatically, including `add_cart_item`.

```json
{ "result": { "status": "error",
  "error": { "code": "cart_change_unconfirmed", "message": "cart_change_unconfirmed", "retryable": false },
  "mutation": { "outcome": "unknown", "recovery": { "action": "get_cart", "automaticReplay": false } } } }
```

## Orders

An order dated 14 or more days ago is settled, so its product lines no longer change. While the
server runs, these lines are kept in memory for the signed-in account, and the order tools read
each settled order's detail page only once. A different sign-in clears them. The order history
list and recent orders are always read from the website.

### `list_orders`

Returns recent order summaries, newest first. `limit` counts summaries; `detailLimit`
(default: `limit`) caps how many of them have their product lines read, and
`includeLines: false` skips lines entirely. Each order's `lines` is `available` (with
`items`), `unavailable` (with `error`) or `not_requested`. Pass `nextCursor` back as `cursor`
to continue; if the history changed in between, restart without a cursor.

`data`: `observedAt`, `orders`, `completeness`, `failures`, `nextCursor`, `hasMore`,
`detailBudget` and `detailsRead`. Each failure has `stage` (`listing` or `detail`), the
`orderId` and `orderNumber` it concerns (or `null`), and the `error`.

### `get_order`

Reads one order by `orderId`. `data`: `observedAt`, `order`, `unknownQuantityLines`.

### `list_frequently_bought_products`

Reads up to `orderLimit` recent orders and ranks products by the number of orders that
contained them, then by total units. Products are grouped by `productId`; lines without one
are grouped by name (`identityBasis: "name"`). Totals are kept separate per unit, and lines
with unknown quantities are counted in `unknownQuantityLines` instead of being guessed.

`data`: `observedAt`, `products` (each with `unknownQuantityLines`, 0 when none), `listed`,
`scanned`, `succeeded`, `failed`, `unscanned`, `unknownQuantityLines`, `failures` (as in
`list_orders`) and `completeness`. `orderLimit` sets how far back it reads; there is no cursor.
If no order details could be read at all, the result is an `order_details_unavailable` error
whose `result.scan` holds the same statistics.

## Session

### `get_session_status`

Reports local state without opening a browser or contacting the website: `browser`
(`closed`, `starting`, `ready`), `credentials` (`hasEmail`, `hasPassword`), `savedCookies`
(`available`, `missing`, `unavailable`), `authentication` (the last observed login state and
when it was observed), `favorites` (snapshot state and expiry) and `update` (`currentVersion`,
`latestVersion` and whether a newer release is `available`). It never returns
credentials, cookies or file paths.

## Error codes

| Code | Meaning |
| --- | --- |
| `invalid_input` | The request cannot be applied, for example an off-step quantity or an ambiguous cart line. |
| `quantity_below_minimum` | The resulting quantity is below the product minimum. |
| `sale_rules_unknown` | The product's sale rules could not be interpreted safely. |
| `not_found` | The product, cart line or order does not exist. |
| `not_authenticated` | Sign-in is required and automatic sign-in failed or is not configured. The message says which, and what to do; `signIn` says the same in fields (below). |
| `upstream_unavailable` | The website could not be reached or returned an error. |
| `invalid_data` | The website returned something the server does not recognise. |
| `order_details_unavailable` | Order details could not be read. |
| `cart_change_rejected` | The website rejected the cart change. |
| `cart_change_unconfirmed` | The cart change could not be confirmed. |
| `cache_unavailable` | The local favorites snapshot could not be read or written. |
| `browser_unavailable` | Chromium is still downloading for first use, or the download failed. Retryable. |
| `cancelled`, `deadline_exceeded`, `server_closed`, `queue_full` | The request stopped before completing. |
| `internal_error`, `invalid_result` | Unexpected server failure. Details are not exposed. |

A `not_authenticated` error that happens before any cart write also carries `signIn`, so an
assistant can guide the user without parsing the message:

```json
{ "credentials": "missing", "action": "configure_credentials",
  "settings": { "environment": ["CONTINENTE_EMAIL", "CONTINENTE_PASSWORD"], "claudeDesktopExtension": ["email", "password"] },
  "command": "continentept-mcp login --show-browser",
  "guide": "https://github.com/andredelgado/continente-mcp/blob/main/docs/configuration.md",
  "publicTools": ["search_products", "get_product"] }
```

`credentials` is `configured`, `missing` or `unknown`. With `configured`, the server has already
tried them, so `action` is `check_credentials_or_sign_in`: check the email and password, or run
`command` in a terminal to sign in once in a visible browser and complete any verification.

Invalid arguments and unknown tools are JSON-RPC errors (`-32602`), not tool results.

## Instructions and prompt

The server sends **instructions** when a client connects: the quantity, cart-change and
uncertain-outcome rules described above, in a few lines. Clients such as Claude include them
in the assistant's context automatically. When a newer release exists, the instructions also
say so, so the assistant can tell the user.

It also offers one **prompt**, `basket-planner` ("Plan a Continente basket"). It returns the
full shopping workflow as a user message. Its optional `request` argument, such as
`weekly basket for two`, is appended to the workflow. The text is the same as the
[`basket-planner` skill](../skills/basket-planner/SKILL.md).

## Limits and lifecycle

- Calls run one at a time. Each call has a 45-second budget, including time spent waiting.
  At most 32 calls can wait; more fail with `queue_full`.
- Cancelling a call before a cart change is sent reports `not_applied`; after that it reports
  `unknown`.
- The browser starts on first use and closes after five idle minutes
  (`CONTINENTE_BROWSER_IDLE_SECONDS`). Saved cookies and favorites are kept.
- Progress notifications are sent for multi-page reads when the client supplies a
  `progressToken`.
