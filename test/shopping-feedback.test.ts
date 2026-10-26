// Regressions from real shopping sessions: produce priced per kg, partly unreadable result pages,
// favorites ranking and sign-in guidance.
import { injectedServices, connect } from '../test-support/mcp-fixture.js';
import { dataOf, statusOf, textOf, toolError } from '../test-support/assertions.js';
import { fixture, ok, pages, present, valueOf, fail } from '../test-support/helpers.js';
import { SearchData, FavoritesData } from '../src/mcp/contracts.js';
import { parseFavoritesPages } from '../src/parsers/catalog.js';
import { signInHelp, signInRecovery } from '../src/mcp/shopping.js';
import { CatalogService, FavoritesService } from '../src/services/catalog.js';

import assert from 'node:assert/strict';
import test from 'node:test';

test('produce priced per kg is searchable and keeps what each price is for', async t => {
  const { services } = injectedServices();
  services.catalog = new CatalogService({ async searchProducts() { return ok({ pages: [fixture('catalog')], failures: [] }); } }, services.favorites);
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'search_products', arguments: { query: 'banana' } });
  assert.equal(statusOf(result), 'success');
  const banana = present(dataOf(result, SearchData).products.find(product => product.productId === '456'));
  assert.deepEqual(banana.price, { amount: { currency: 'EUR', minorUnits: 119 }, per: 'kg' });
  assert.match(textOf(result), /Banana Madeira \(unavailable\) — €1\.19\/kg \(€0\.24 per piece\), minimum 600 gr \(3 un\)/);
  assert.match(textOf(result), /Leite Meio Gordo — €1\.29 \(€1\.29\/l\), PVPR €1\.49, pack 1 lt/);
});

test('a partly unreadable results page still returns its products as a partial result', async t => {
  const { services } = injectedServices();
  services.catalog = new CatalogService({ async searchProducts() { return ok({ pages: [fixture('catalog-mixed')], failures: [] }); } }, services.favorites);
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'search_products', arguments: { query: 'frango' } });
  assert.equal(result.isError, undefined); assert.equal(statusOf(result), 'partial');
  const data = dataOf(result, SearchData);
  assert.deepEqual(data.products.map(product => product.productId), ['7001', '7002', '7003']);
  assert.equal(data.failures.length, 2); assert.equal(data.completeness, 'partial');
  assert.match(textOf(result), /Queijo Fatiado — price unknown/);
  assert.match(textOf(result), /2 problem\(s\) reading results/);
});

test('favorites priced per kg are kept, and an unrecognised favorite price is only unknown', async t => {
  const weighted = fixture('favorites').replace('<a href="/produto/banana-456.html">Banana Madeira</a>',
    '<a href="/produto/banana-456.html">Banana Madeira</a><span class="pwc-tile--price-primary">1,19€/kg</span>');
  const favorites = valueOf(parseFavoritesPages([weighted]));
  assert.deepEqual(present(favorites[1]).price, { amount: { currency: 'EUR', minorUnits: 119 }, per: 'kg' });
  assert.equal(present(favorites[1]).name, 'Banana Madeira');
  const odd = valueOf(parseFavoritesPages([weighted.replace('1,19€/kg', 'Preço sob consulta')]));
  assert.equal(present(odd[1]).price, null);

  const { services } = injectedServices();
  services.favorites = new FavoritesService({ async fetchFavorites() { return ok(pages(weighted)); } },
    { async load() { return ok(null); }, async save() { return ok(); } }, { now: () => new Date('2026-10-15T12:00:00Z') }, 'test', () => {});
  const { client } = await connect(t, services);
  const listed = await client.callTool({ name: 'list_favorites', arguments: { refresh: true } });
  assert.equal(statusOf(listed), 'success');
  assert.equal(present(dataOf(listed, FavoritesData).favorites[1]).price?.per, 'kg');
  assert.match(textOf(listed), /Banana Madeira — €1\.19\/kg/);
});

test('sign-in errors say whether credentials are missing or were not accepted', async t => {
  assert.match(signInHelp(false), /no Continente email and password are configured.*extension's settings.*CONTINENTE_EMAIL/s);
  assert.match(signInHelp(true), /did not accept the configured email and password.*login --show-browser/s);
  for (const configured of [true, false, null]) {
    assert.match(signInHelp(configured), /Searching and product details work without signing in\./);
    assert.match(signInHelp(configured), /docs\/configuration\.md/);
  }
  const { services } = injectedServices();
  services.cart.getCart = async () => fail('not_authenticated');
  services.session.getStatus = async () => ({ browser: 'closed', credentials: { hasEmail: false, hasPassword: false },
    savedCookies: 'missing', authentication: { state: 'unknown', checkedAt: null } });
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'get_cart', arguments: {} });
  assert.equal(toolError(result).code, 'not_authenticated');
  assert.match(toolError(result).message, /no Continente email and password are configured/);
  const signIn = (result.structuredContent as { result: { signIn?: Record<string, unknown> } }).result.signIn;
  assert.deepEqual(signIn, { credentials: 'missing', action: 'configure_credentials', signInWindow: null,
    settings: { environment: ['CONTINENTE_EMAIL', 'CONTINENTE_PASSWORD'], claudeDesktopExtension: ['email', 'password'] },
    command: 'continentept-mcp login --show-browser', guide: 'https://github.com/andredelgado/continente-mcp/blob/main/docs/configuration.md',
    publicTools: ['search_products', 'get_product'] });
  assert.deepEqual([signInRecovery(true).credentials, signInRecovery(true).action], ['configured', 'check_credentials_or_sign_in']);
  assert.deepEqual([signInRecovery(null).credentials, signInRecovery(null).action], ['unknown', 'check_credentials_or_sign_in']);
  services.cart.getCart = async () => fail('upstream_unavailable');
  const other = await client.callTool({ name: 'get_cart', arguments: {} });
  assert.equal((other.structuredContent as { result: { signIn?: unknown } }).result.signIn, undefined);
});
