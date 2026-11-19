import type { PromptHandler } from './server.js';

// The basket-planner guide, served as the `basket-planner` prompt. Keep it identical to the body of
// skills/basket-planner/SKILL.md; a test fails when they differ.
export const BASKET_PLANNER_GUIDE = `# Basket planner

Turn the user's shopping intent into a product list or a verified basket using the **continentept-mcp** tools. A request for a plan authorizes research only; a request to add, remove or set items authorizes those basket changes. Keep the user's existing choices and constraints. Ask only about choices that change the result, such as an unspecified substitute or whether a quantity means "more" or "in total".

## Choose products and quantities

1. Use \`search_products\` with \`query\` (and \`limit\` when useful). Treat results as candidates: match size, brand, dietary constraints and intended use before choosing. Keep \`productId\` as a string, including leading zeros.
2. Use \`get_product\` when price, availability or sale rules matter. Quantities are in the returned sale unit. Respect minimum, maximum and step; never assume a weighted product is sold by the kilogram and never silently round a requested amount.
3. Before changing the basket, read \`get_cart\` for current quantities and line identities. If several lines share a product ID, use the intended line's \`cartItemId\`, or ask the user which line they mean. For a list, call \`preview_cart_changes\` with the totals you plan: it shows what each line would change, what would be refused and the estimated cost, without changing anything. Show that to the user before applying it.
4. Show unresolved choices. Settle what you can from favorites, past orders and unit price; for the choices the user must make, call \`choose_products\` once with all of them (at most 10, each with 2 to 4 candidates and your suggestion) instead of asking item by item. Missing prices, availability, quantities or sale rules stay unknown. Money is EUR in integer \`minorUnits\` (129 means €1.29). Keep product prices, basket totals and estimated list costs distinct. The current cart total is \`get_cart\`'s \`totals.grandTotal\`, which includes bags. Delivery fees may still be added at checkout.

Searches read a bounded number of result pages; respect \`completeness\` and \`failures\` and do not claim a search was exhaustive.

## Change the basket

- \`set_cart_item_quantity({ productId, quantity, cartItemId? })\` makes the basket hold exactly \`quantity\`, adding the product if needed. Zero removes it. Prefer this whenever the user states a desired total; repeating it is safe.
- \`add_cart_item({ productId, quantity, cartItemId? })\` adds \`quantity\` on top of what is already there (default one sale unit). Use it only for "add more".
- \`remove_cart_item({ productId, cartItemId? })\` removes a line. An already absent item is confirmed without a write.

If the basket holds two units, "add two more" is \`add_cart_item\` with 2, while "I need two" is \`set_cart_item_quantity\` with 2 (which changes nothing). Process a list one item at a time and read each result before continuing. To empty the whole basket when the user asks, use \`clear_cart\` with \`confirm: true\` rather than removing lines one by one. To use Cartão Continente coupons, read \`list_coupons\` and, only when the user asks, set the whole selection with \`set_cart_coupons\`. There is no checkout or payment tool; checkout happens on the website.

## Read outcomes before reporting success

Read \`structuredContent.result\` rather than inferring success from prose.

- \`status: success\`, \`empty\` or \`partial\` carries \`data\`. Report partial-result warnings and unavailable data.
- A confirmed change has \`data.outcome: "confirmed"\`. For an item, report \`confirmedQuantity\` in its sale unit. For a cleared cart, report \`removedLines\`. For coupons, report \`selectedCouponIds\`.
- \`status: error\` carries \`error\`. For basket changes also read \`mutation\`: \`not_applied\` means nothing was submitted or the change was rejected; fix the reported cause before trying again.
- \`mutation.outcome: "unknown"\` means the change may have happened. Stop dependent changes and follow \`mutation.recovery.action\`. Use \`get_cart\` for items and \`list_coupons\` for coupon selections. Compare the result with the state before the change. Never repeat the original request automatically. If it is still unclear what happened, ask the user before trying again.

A timeout, cancellation or lost connection during a change is not evidence that the basket stayed the same. Apply the same reconciliation when no structured result arrives.

## Use account context when it helps

For "my usual items", \`list_favorites\` and \`list_frequently_bought_products\` can inform a proposed list. Past purchases are evidence, not permission to buy them again.

\`list_favorites\` returns a local snapshot with \`source\` and \`freshness\`; pass \`refresh: true\` when the user wants the current website list or the snapshot is stale. An empty list is a valid result, and a failed refresh does not mean favorites disappeared.

\`list_orders\` supports \`limit\`, \`includeLines\`, \`detailLimit\` and \`cursor\` (the returned \`nextCursor\`). Use the internal \`orderId\` with \`get_order\`, not the displayed order number. \`list_frequently_bought_products\` has separate \`orderLimit\` and \`limit\`; its scan counts and failures show how representative the ranking is. Never add quantities expressed in different units.

\`get_session_status\` reports local state only; it does not verify that the login still works. Do not include credentials or account details in summaries.

Finish with the chosen or changed items, confirmed quantities and units, and any unresolved choices or failures. Keep planned items separate from changes the server confirmed.

For exact schemas and limits, see the [tool reference](https://github.com/andredelgado/continente-mcp/blob/main/docs/tools.md).`;


// The label-check guide, served as the `label-check` prompt. Keep it identical to the body of
// skills/label-check/SKILL.md; a test fails when they differ.
export const LABEL_CHECK_GUIDE = `# Label check

Answer dietary and allergen questions about Continente.pt products from what each product's label declares, using the **continentept-mcp** tools. A wrong "safe" answer can harm someone, so report what the label says and what it leaves unknown. Never promise that a product is safe to eat.

## Read the labels

1. Take the candidates from the conversation, \`get_cart\`, \`list_favorites\` or \`search_products\`. Keep \`productId\` as a string, including leading zeros.
2. Call \`get_product_labels\` for every candidate, up to 20 products per call. Never answer from the product name, the category or a claim in the name such as "sem glúten" alone; read the label as well.
3. Check each label's \`status\`. \`complete\` and \`partial\` labels can support an answer. For \`none\` or \`error\`, say the website has no readable label for that product and that the packaging decides. When \`missing\` includes \`ingredients\` or \`allergenStatement\`, an allergen question for that product stays unknown.

## Allergens

- Look in \`ingredients\` (verbatim), \`allergenStatement\` and \`mayContain\`. \`emphasised\` helps but is typography, not an allergen list: not every label capitalises its allergens, and it also catches abbreviations.
- Labels are in Portuguese. The 14 EU allergens appear as: cereais com glúten (trigo, centeio, cevada, aveia, espelta, kamut), crustáceos, ovo, peixe, amendoim, soja, leite (also lactose, soro de leite, caseína, natas, manteiga, queijo), frutos de casca rija (amêndoa, avelã, noz, caju, pistácio, noz-pecã, castanha-do-brasil, macadâmia), aipo, mostarda, sésamo, dióxido de enxofre e sulfitos, tremoço and moluscos.
- \`mayContain\` ("pode conter vestígios de") is a cross-contamination warning. For an allergy, treat the product as not suitable unless the user says traces are acceptable.
- An allergen the label does not mention is not a "free from" claim. Say "the label does not mention it", never "X-free", unless the label itself says so (for example "sem glúten" or "isento de lactose").

## Vegan and vegetarian

No field certifies a product as vegan or vegetarian. Read \`ingredients\` for animal-derived ones such as leite, natas, manteiga, queijo, soro de leite, ovo, mel, gelatina, carne, peixe, banha, colagénio and carmim (E120). Some ingredients can come from either source, such as aromas, E471 or vitamina D3, and the label rarely says which; report those as unknown. The most you can say is "no animal ingredients are listed".

## Nutrition

\`nutrition.per\` is the basis, such as 100 g or 100 ml. For a pack or a serving, scale by the label's \`netContent\` or the serving the user names. When \`issues\` includes \`nutrition_basis_mismatch\`, do not convert between grams and millilitres; report the values as given. Only add up nutrients that share a basis.

## Report

For each product, give its name, one verdict and the label text it rests on, quoted briefly:

- **The label mentions it**: the allergen or animal ingredient is in the ingredients or the allergen statement.
- **May contain traces**: only \`mayContain\` mentions it.
- **Not mentioned**: the label was read and does not mention it.
- **Unknown**: no readable label, a missing field, or an ingredient of uncertain origin.

Group the products by verdict. When the user wants alternatives, search for them and read their labels too before suggesting any. Change the cart only when the user asks. End by noting that the website's copy of a label can lag behind the packaging, which prevails, so anyone with a severe allergy should check the package.

For the label fields, see the [tool reference](https://github.com/andredelgado/continente-mcp/blob/main/docs/tools.md#get_product_labels).`;

/** Added to the instructions when the server runs with CONTINENTE_READ_ONLY. */
export const READ_ONLY_NOTICE = 'Read-only mode: this server was started with CONTINENTE_READ_ONLY, so it has no tools that change the cart or the coupon selection. ' +
  'Search, compare, preview and read the account as usual, and tell the user to make the changes on the website.';

/** Sent to every client on connect; the essential rules for working with the cart safely. */
export const SERVER_INSTRUCTIONS = `Continente MCP shops at Continente.pt for one account. Checkout and payment always happen on the website.

- Quantities are in the product's sale unit. Call get_product before choosing a quantity for weighted or bulk products, and respect its minimum, maximum and step.
- Before applying a list, preview_cart_changes shows what each change would do and cost, and what would be refused; it changes nothing.
- When the user must choose between products, call choose_products once with all open choices (it shows photos where the client supports it); never one call per item, and not for choices you can settle yourself.
- Narrow searches with category, excludeCategory or brand when results stray ("tofu" also finds cat litter), sort by unit_price to find the cheapest per kg or litre, and pass promotion for products on offer.
- For dietary needs (vegan, allergens, gluten, protein), read get_product_labels for the candidates. Report what the label declares; an allergen not mentioned is not a "free from" claim.
- set_cart_item_quantity sets an exact total (adding the product if needed; 0 removes it). add_cart_item adds on top of what is already there. When the user says how many they need, use set_cart_item_quantity.
- Change the cart one item at a time and read structuredContent.result before reporting success. confirmedQuantity is what the cart now holds.
- To empty the whole cart when the user asks, use clear_cart with confirm: true instead of removing lines one by one.
- If a cart change returns mutation.outcome "unknown", the cart may have changed. Call the tool named in mutation.recovery (get_cart, or list_coupons for coupons) and decide from what it shows. Never repeat the change automatically.
- For Cartão Continente coupons, list_coupons shows the account's coupons and which are selected in the cart. Use set_cart_coupons only when the user asks to use or stop using coupons; it sets the whole selection.
- Money is EUR in integer minorUnits (129 means €1.29). Each price says what it is for: per item, per piece, per kg or per l. A price per kg or per l is not the price of one pack; check packageText, package (count, each and net quantity) and secondaryPrice before comparing. Missing prices, quantities or completeness stay unknown; do not guess them.
- If your client supports MCP prompts, the basket-planner prompt has the full workflow for planning a shopping list or basket, and the label-check prompt the workflow for dietary and allergen questions.`;

export const basketPlannerPrompt: PromptHandler = {
  name: 'basket-planner',
  title: 'Plan a Continente basket',
  description: 'Workflow for choosing products, checking sale quantities and changing the cart safely.',
  arguments: { request: 'What to plan or buy, for example "weekly basket for two" or "add milk and eggs".' },
  render: ({ request }) => ({
    description: 'Continente basket planning workflow',
    messages: [{ role: 'user', content: { type: 'text',
      text: request?.trim() ? `${BASKET_PLANNER_GUIDE}\n\n## Request\n\n${request.trim()}` : BASKET_PLANNER_GUIDE } }],
  }),
};

export const labelCheckPrompt: PromptHandler = {
  name: 'label-check',
  title: 'Check product labels',
  description: 'Workflow for allergen, vegan and nutrition questions, answered from what each product label declares.',
  arguments: { request: 'What to check, for example "gluten-free pasta" or "is my cart safe for a nut allergy".' },
  render: ({ request }) => ({
    description: 'Continente label check workflow',
    messages: [{ role: 'user', content: { type: 'text',
      text: request?.trim() ? `${LABEL_CHECK_GUIDE}\n\n## Request\n\n${request.trim()}` : LABEL_CHECK_GUIDE } }],
  }),
};
