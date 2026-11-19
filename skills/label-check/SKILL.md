---
name: label-check
description: Answer allergen, gluten, lactose, vegan, vegetarian and nutrition questions about Continente.pt products from what each product label declares, with the continentept-mcp tools. Use before calling a product safe for an allergy or a diet, or when adding up protein, sugar or other nutrients.
---

# Label check

Answer dietary and allergen questions about Continente.pt products from what each product's label declares, using the **continentept-mcp** tools. A wrong "safe" answer can harm someone, so report what the label says and what it leaves unknown. Never promise that a product is safe to eat.

## Read the labels

1. Take the candidates from the conversation, `get_cart`, `list_favorites` or `search_products`. Keep `productId` as a string, including leading zeros.
2. Call `get_product_labels` for every candidate, up to 20 products per call. Never answer from the product name, the category or a claim in the name such as "sem glúten" alone; read the label as well.
3. Check each label's `status`. `complete` and `partial` labels can support an answer. For `none` or `error`, say the website has no readable label for that product and that the packaging decides. When `missing` includes `ingredients` or `allergenStatement`, an allergen question for that product stays unknown.

## Allergens

- Look in `ingredients` (verbatim), `allergenStatement` and `mayContain`. `emphasised` helps but is typography, not an allergen list: not every label capitalises its allergens, and it also catches abbreviations.
- Labels are in Portuguese. The 14 EU allergens appear as: cereais com glúten (trigo, centeio, cevada, aveia, espelta, kamut), crustáceos, ovo, peixe, amendoim, soja, leite (also lactose, soro de leite, caseína, natas, manteiga, queijo), frutos de casca rija (amêndoa, avelã, noz, caju, pistácio, noz-pecã, castanha-do-brasil, macadâmia), aipo, mostarda, sésamo, dióxido de enxofre e sulfitos, tremoço and moluscos.
- `mayContain` ("pode conter vestígios de") is a cross-contamination warning. For an allergy, treat the product as not suitable unless the user says traces are acceptable.
- An allergen the label does not mention is not a "free from" claim. Say "the label does not mention it", never "X-free", unless the label itself says so (for example "sem glúten" or "isento de lactose").

## Vegan and vegetarian

No field certifies a product as vegan or vegetarian. Read `ingredients` for animal-derived ones such as leite, natas, manteiga, queijo, soro de leite, ovo, mel, gelatina, carne, peixe, banha, colagénio and carmim (E120). Some ingredients can come from either source, such as aromas, E471 or vitamina D3, and the label rarely says which; report those as unknown. The most you can say is "no animal ingredients are listed".

## Nutrition

`nutrition.per` is the basis, such as 100 g or 100 ml. For a pack or a serving, scale by the label's `netContent` or the serving the user names. When `issues` includes `nutrition_basis_mismatch`, do not convert between grams and millilitres; report the values as given. Only add up nutrients that share a basis.

## Report

For each product, give its name, one verdict and the label text it rests on, quoted briefly:

- **The label mentions it**: the allergen or animal ingredient is in the ingredients or the allergen statement.
- **May contain traces**: only `mayContain` mentions it.
- **Not mentioned**: the label was read and does not mention it.
- **Unknown**: no readable label, a missing field, or an ingredient of uncertain origin.

Group the products by verdict. When the user wants alternatives, search for them and read their labels too before suggesting any. Change the cart only when the user asks. End by noting that the website's copy of a label can lag behind the packaging, which prevails, so anyone with a severe allergy should check the package.

For the label fields, see the [tool reference](https://github.com/andredelgado/continente-mcp/blob/main/docs/tools.md#get_product_labels).
