---
name: basket-planner
description: Plan shopping lists and manage a Continente.pt basket with the continentept-mcp tools. Use for choosing products, checking sale quantities, changing the basket, or building a list from favorites and past orders. Covers structured results, cart line identities and recovery from uncertain cart changes.
---

# Basket planner

Turn the user's shopping intent into a product list or a verified basket using the **continentept-mcp** tools. A request for a plan authorizes research only; a request to add, remove or set items authorizes those basket changes. Keep the user's existing choices and constraints. Ask only about choices that change the result, such as an unspecified substitute or whether a quantity means "more" or "in total".

## Choose products and quantities

1. Use `search_products` with `query` (and `limit` when useful). Treat results as candidates: match size, brand, dietary constraints and intended use before choosing. Keep `productId` as a string, including leading zeros.
2. Use `get_product` when price, availability or sale rules matter. Quantities are in the returned sale unit. Respect minimum, maximum and step; never assume a weighted product is sold by the kilogram and never silently round a requested amount.
3. Before changing the basket, read `get_cart` for current quantities and line identities. If several lines share a product ID, use the intended line's `cartItemId`, or ask the user which line they mean. For a list, call `preview_cart_changes` with the totals you plan: it shows what each line would change, what would be refused and the estimated cost, without changing anything. Show that to the user before applying it.
4. Show unresolved choices. Settle what you can from favorites, past orders and unit price; for the choices the user must make, call `choose_products` once with all of them (at most 10, each with 2 to 4 candidates and your suggestion) instead of asking item by item. Missing prices, availability, quantities or sale rules stay unknown. Money is EUR in integer `minorUnits` (129 means €1.29). Keep product prices, basket totals and estimated list costs distinct. The amount to pay is `get_cart`'s `totals.grandTotal`, which includes the bags the website adds.

Searches read a bounded number of result pages; respect `completeness` and `failures` and do not claim a search was exhaustive.

## Change the basket

- `set_cart_item_quantity({ productId, quantity, cartItemId? })` makes the basket hold exactly `quantity`, adding the product if needed. Zero removes it. Prefer this whenever the user states a desired total; repeating it is safe.
- `add_cart_item({ productId, quantity, cartItemId? })` adds `quantity` on top of what is already there (default one sale unit). Use it only for "add more".
- `remove_cart_item({ productId, cartItemId? })` removes a line. An already absent item is confirmed without a write.

If the basket holds two units, "add two more" is `add_cart_item` with 2, while "I need two" is `set_cart_item_quantity` with 2 (which changes nothing). Process a list one item at a time and read each result before continuing. To empty the whole basket when the user asks, use `clear_cart` with `confirm: true` rather than removing lines one by one. To use Cartão Continente coupons, read `list_coupons` and, only when the user asks, set the whole selection with `set_cart_coupons`. There is no checkout or payment tool; checkout happens on the website.

## Read outcomes before reporting success

Read `structuredContent.result` rather than inferring success from prose.

- `status: success`, `empty` or `partial` carries `data`. Report partial-result warnings and unavailable data.
- A confirmed change has `data.outcome: "confirmed"` and `confirmedQuantity`, the quantity now in the basket. Report that observed quantity.
- `status: error` carries `error`. For basket changes also read `mutation`: `not_applied` means nothing was submitted or the change was rejected; fix the reported cause before trying again.
- `mutation.outcome: "unknown"` means the change may have happened. Stop dependent basket changes, call `get_cart`, and compare with the state before the change. Never repeat the original request just because the response was lost. If the basket state cannot settle the intent, explain the uncertainty and ask the user.

A timeout, cancellation or lost connection during a change is not evidence that the basket stayed the same. Apply the same reconciliation when no structured result arrives.

## Use account context when it helps

For "my usual items", `list_favorites` and `list_frequently_bought_products` can inform a proposed list. Past purchases are evidence, not permission to buy them again.

`list_favorites` returns a local snapshot with `source` and `freshness`; pass `refresh: true` when the user wants the current website list or the snapshot is stale. An empty list is a valid result, and a failed refresh does not mean favorites disappeared.

`list_orders` supports `limit`, `includeLines`, `detailLimit` and `cursor` (the returned `nextCursor`). Use the internal `orderId` with `get_order`, not the displayed order number. `list_frequently_bought_products` has separate `orderLimit` and `limit`; its scan counts and failures show how representative the ranking is. Never add quantities expressed in different units.

`get_session_status` reports local state only; it does not verify that the login still works. Do not include credentials or account details in summaries.

Finish with the chosen or changed items, confirmed quantities and units, and any unresolved choices or failures. Keep planned items separate from changes the server confirmed.

For exact schemas and limits, see the [tool reference](https://github.com/andredelgado/continente-mcp/blob/main/docs/tools.md).
