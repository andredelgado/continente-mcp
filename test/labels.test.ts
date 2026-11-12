import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductIdSchema } from '../src/domain/index.js';
import { labelStatus, parseProductLabel, productLabelUrl } from '../src/parsers/label.js';
import { CatalogService } from '../src/services/catalog.js';
import type { FavoritesService } from '../src/services/catalog.js';
import { LabelsData } from '../src/mcp/contracts.js';
import { double, dataOf, textOf } from '../test-support/assertions.js';
import { fixture, ok, present, valueOf } from '../test-support/helpers.js';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';

const label = (name: string) => readFileSync(new URL(`../../test/fixtures/labels/${name}.html`, import.meta.url), 'utf8');
const parsed = (name: string) => valueOf(parseProductLabel(label(name)));
const LABEL_URL = 'https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/Product-ProductNutritionalInfoTab?pid=00123&ean=5600000000001&supplierid=1&enabledce=true';
const productPage = (url = LABEL_URL) => fixture('product') + `<a href="#collapsible-description-nutritional" class="js-details-header js-nutritional-tab-anchor d-none" data-url="${url.replace(/&/g, '&amp;')}">Informação Nutricional</a>`;

test('labels give ingredients, capitalised words, allergen statements and nutrition as declared', () => {
  const tofu = parsed('tofu');
  assert.equal(tofu?.ingredients, 'Água, SOJA, nigari (cloreto de magnésio natural).');
  assert.deepEqual(tofu?.emphasised, ['SOJA']); assert.equal(tofu?.allergenStatement, null); assert.equal(tofu?.mayContain, null);
  assert.deepEqual(tofu?.nutrition?.per, { value: 100, unit: 'g' });
  assert.deepEqual(tofu?.nutrition?.nutrients.filter(item => item.key).map(item => [item.key, item.amount, item.unit]), [
    ['energy_kj', 560.66, 'kJ'], ['energy_kcal', 134, 'kcal'], ['fat', 7.9, 'g'], ['saturated_fat', 1.3, 'g'], ['carbohydrates', 1.2, 'g'],
    ['sugars', 0, 'g'], ['fibre', 0.8, 'g'], ['protein', 14, 'g'], ['salt', 0.03, 'g']]);
  const soy = parsed('soy-granules');
  assert.match(soy?.allergenStatement ?? '', /^Pode conter vestígios de Cereais que contêm glúten/);
  assert.equal(soy?.mayContain, soy?.allergenStatement);
  assert.ok(soy?.nutrition?.nutrients.some(item => item.key === null && item.name === 'tiamina' && item.unit === 'mg'));
  const milk = parsed('milk');
  assert.equal(milk?.allergenStatement, 'Contém Leite.'); assert.deepEqual(milk?.nutrition?.per, { value: 100, unit: 'ml' });
  assert.equal(milk?.ingredients, null);
  assert.deepEqual(parsed('yoghurt')?.emphasised, ['LEITE', 'LÁCTEOS']);
  assert.deepEqual(parsed('cereal')?.emphasised, ['TRIGO', 'LEITE', 'SOJA', 'FRUTOS DE CASCA RIJA']);
});

test('a label that does not capitalise its allergens still shows them in the ingredients and traces', () => {
  const biscuits = parsed('biscuits');
  assert.deepEqual(biscuits?.emphasised, []);
  assert.match(biscuits?.ingredients ?? '', /^Farinha de trigo/);
  assert.equal(biscuits?.mayContain, 'Pode conter leite, ovos, amêndoas, avelãs.');
});

test('products without label information, and pages that are not labels, are told apart', () => {
  const banana = parsed('banana');
  assert.deepEqual([banana?.regulatedName, banana?.ingredients, banana?.nutrition, banana?.emphasised], ['Banana', null, null, null]);
  assert.equal(parsed('diapers')?.nutrition, null);
  assert.equal(valueOf(parseProductLabel('<div class="ct-pdp--description-content"></div>')), null);
  assert.equal(parseProductLabel('<main>Something else</main>').ok, false);
});

test('a product page links to its own label only', () => {
  const id = ProductIdSchema.parse('00123');
  assert.equal(productLabelUrl(productPage(), id), LABEL_URL);
  assert.equal(productLabelUrl(productPage(LABEL_URL.replace('pid=00123', 'pid=999')), id), null);
  assert.equal(productLabelUrl(productPage(LABEL_URL.replace('https://www.continente.pt', 'https://other.invalid')), id), null);
  assert.equal(productLabelUrl(fixture('product'), id), null);
});

test('labels reuse the product page already read, and say when there is none', async () => {
  let pages = 0; const labelsRead: string[] = []; let page = productPage();
  const client = {
    async fetchProductDetails() { pages++; return ok({ html: page, url: 'https://www.continente.pt/produto/leite-00123.html' }); },
    async fetchProductLabel(url: string) { labelsRead.push(url); return ok(label('tofu')); },
    async searchProducts() { return ok({ pages: [], failures: [] }); },
  };
  const service = new CatalogService(client, double<FavoritesService>({ async loadCachedFavorites() { return null; } }));
  assert.equal(valueOf(await service.getProduct('00123')).productId, '00123'); assert.equal(pages, 1);
  const first = valueOf(await service.getProductLabel('00123'));
  assert.deepEqual([first.name, first.label?.emphasised, pages], ['Leite', ['SOJA'], 1]);
  assert.deepEqual(labelsRead, [LABEL_URL]);
  const fresh = new CatalogService(client, double<FavoritesService>({ async loadCachedFavorites() { return null; } }));
  await fresh.getProductLabel('00123'); assert.equal(pages, 2);
  page = fixture('product');
  const none = new CatalogService(client, double<FavoritesService>({ async loadCachedFavorites() { return null; } }));
  assert.equal(valueOf(await none.getProductLabel('00123')).label, null); assert.equal(labelsRead.length, 2);
});

test('get_product_labels reports each product, with errors per product', async t => {
  const { services } = injectedServices();
  services.catalog.getProductLabel = async reference => reference === '00123'
    ? ok({ productId: ProductIdSchema.parse('00123'), name: 'Tofu', label: parsed('tofu') })
    : { ok: false as const, error: { code: 'not_found' as const, message: 'The website does not show this product to this session', retryable: false } };
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'get_product_labels', arguments: { productIds: ['00123', '999'] } });
  const data = dataOf(result, LabelsData);
  assert.deepEqual(data.labels.map(item => [item.productId, item.error?.code ?? null]), [['00123', null], ['999', 'not_found']]);
  const text = textOf(result);
  assert.match(text, /the packaging prevails/);
  assert.match(text, /Tofu \[00123\] \(complete; not on the website: allergen statement\)\n   Ingredients: Água, SOJA, nigari/);
  assert.deepEqual(data.labels.map(item => [item.status, item.missing]), [['complete', ['allergenStatement']], ['error', []]]);
  assert.match(text, /In capitals in the ingredients: SOJA\n   Nutrition per 100 g: energy 134 kcal, fat 7\.9 g, of which saturates 1\.3 g/);
  assert.match(text, /\[999\] — could not be read: The website does not show this product/);
});

test('an allergen statement is shown even when the label has no ingredients or nutrition', async t => {
  const { services } = injectedServices();
  const tofu = parsed('tofu');
  const only = { ...tofu!, ingredients: null, emphasised: [], nutrition: null, allergenStatement: 'Contém Leite.', mayContain: 'Pode conter vestígios de frutos de casca rija.' };
  services.catalog.getProductLabel = async () => ok({ productId: ProductIdSchema.parse('00123'), name: 'Queijo', label: only });
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'get_product_labels', arguments: { productIds: ['00123'] } });
  assert.equal(present(dataOf(result, LabelsData).labels[0]).status, 'none');
  const text = textOf(result);
  assert.match(text, /Queijo \[00123\] — the website shows no ingredients or nutrition for it\n   Allergen statement: Contém Leite\.\n   May contain: Pode conter vestígios/);
});

test('a nutrition basis that contradicts the net content is flagged and kept as given', () => {
  const lentils = parsed('lentils');
  assert.deepEqual([lentils?.netContent, lentils?.nutrition?.per, lentils?.issues], [{ value: 100, unit: 'g' }, { value: 100, unit: 'ml' }, ['nutrition_basis_mismatch']]);
  assert.ok(lentils?.nutrition?.nutrients.some(item => item.key === 'protein'));
  // The website files a nutrition claim as the allergen statement here; it is passed on as given.
  assert.equal(lentils?.allergenStatement, 'Alto teor de fibra e de proteína.');
  assert.deepEqual([parsed('tofu')?.netContent, parsed('tofu')?.issues], [{ value: 100, unit: 'g' }, []]);
  // The website gives the 6 x 1 l milk a net content of 6 g, with nutrients per 100 ml.
  assert.deepEqual([parsed('milk')?.netContent, parsed('milk')?.issues], [{ value: 6, unit: 'g' }, ['nutrition_basis_mismatch']]);
  assert.deepEqual(parsed('soy-granules')?.issues, []);
});

test('label status says whether the website gives ingredients and nutrition', () => {
  assert.deepEqual(labelStatus(parsed('tofu')), { status: 'complete', missing: ['allergenStatement'] });
  assert.deepEqual(labelStatus(parsed('milk')), { status: 'partial', missing: ['ingredients'] });
  assert.deepEqual(labelStatus(parsed('banana')), { status: 'none', missing: ['ingredients', 'allergenStatement', 'nutrition'] });
  // The oat flakes' label tab is empty on the website.
  assert.equal(parsed('oats'), null);
  assert.deepEqual(labelStatus(null), { status: 'none', missing: ['ingredients', 'allergenStatement', 'nutrition'] });
});

test('two-letter capitals such as UE are not reported as emphasised', () => {
  const html = label('tofu').replace('&Aacute;gua, SOJA, nigari (cloreto de magn&eacute;sio natural).', '&Aacute;gua, SOJA*, nigari. *Agricultura UE. EDTA.');
  assert.notEqual(html, label('tofu'));
  assert.deepEqual(valueOf(parseProductLabel(html))?.emphasised, ['SOJA', 'EDTA']);
});
