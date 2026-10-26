// Weekly compatibility check against the live Continente.pt website.
// Runs the built server signed out, with an empty temporary data folder: public pages only,
// no account and no credentials. Exits 1 and prints what broke when the site no longer parses.
// Run `npm run build` first.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface PriceTag { amount: { minorUnits: number }; per: string }
interface Product { productId: string; name: string; price: PriceTag | null }
interface Quantity { value: number; unit: string }
interface WeightedRules { saleUnit: string; storefrontUnit: string; minimum: Quantity | null; maximum: Quantity | null; step: Quantity | null }
interface ToolResult { status: string; data?: Record<string, unknown>; error?: { code: string; message: string } }
interface Application {
  dispatchToolCall(name: string, args: Record<string, unknown>, options: { timeoutMs: number }): Promise<{ structuredContent?: { result?: ToolResult } }>;
  close(): Promise<void>;
}

const runtime = await import(new URL('../../dist/runtime.js', import.meta.url).href) as {
  createShoppingApplication(options: { version: string; env: Record<string, string>; logger: (message: string) => void }): Application;
};

const { ENTREGA_ZERO_FREE_FROM } = await import(new URL('../../dist/domain/checkout.js', import.meta.url).href) as { ENTREGA_ZERO_FREE_FROM: { minorUnits: number } };
const { minimumOrderOf } = await import(new URL('../../dist/parsers/cart.js', import.meta.url).href) as { minimumOrderOf(message: unknown): { minorUnits: number } | null };
const ORIGIN = 'https://www.continente.pt';
const fetchText = async (path: string, headers: Record<string, string> = {}) => {
  const response = await fetch(ORIGIN + path, { headers: { 'Accept-Language': 'pt-PT', 'User-Agent': 'Mozilla/5.0 (continentept-mcp site check)', ...headers } });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.text();
};

const dataDir = mkdtempSync(join(tmpdir(), 'continente-site-check-'));
const app = runtime.createShoppingApplication({
  version: 'site-check', logger: () => {},
  env: { HOME: dataDir, CONTINENTE_DATA_DIR: dataDir, CONTINENTE_CREDENTIALS_FILE: join(dataDir, 'none.env'),
    CONTINENTE_EMAIL: '', CONTINENTE_PASSWORD: '', CONTINENTE_UPDATE_CHECK: '0' },
});

const failures: string[] = [];
const report = (ok: boolean, label: string, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
};
async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const response = await app.dispatchToolCall(name, args, { timeoutMs: 60000 });
  return response.structuredContent?.result ?? { status: 'error', error: { code: 'invalid_result', message: 'No structured result' } };
}
const describe = (result: ToolResult) => result.error ? `${result.error.code}: ${result.error.message}` : `status ${result.status}`;
const products = (result: ToolResult) => (result.data?.products ?? []) as Product[];

async function search(label: string, query: string, limit: number, expect: (found: Product[], data: Record<string, unknown>) => string | null) {
  const result = await call('search_products', { query, limit });
  if (result.status === 'error' || !result.data) return report(false, label, describe(result));
  const problems = (result.data.failures as unknown[] | undefined)?.length ?? 0;
  const issue = expect(products(result), result.data) ?? (problems ? `${problems} result(s) could not be read` : null);
  report(issue === null, label, issue ?? `${products(result).length} products, ${String(result.data.scanned)} scanned`);
}

try {
  await search('Packaged product search', 'leite meio gordo', 5, found =>
    found.length < 3 ? `only ${found.length} products` : found.some(product => product.price?.per === 'item') ? null : 'no product with a per-item price');
  await search('Per-kilogram search', 'banana', 5, found =>
    found.some(product => product.price?.per === 'kg') ? null : 'no product priced per kg');
  await search('Meat search', 'peito de frango', 5, found => found.length ? null : 'no products');
  await search('Second results page', 'leite', 40, (_, data) =>
    Number(data.scanned) > 35 ? null : `only ${String(data.scanned)} products scanned; the next page was not read`);

  const milk = products(await call('search_products', { query: 'leite meio gordo', limit: 1 }))[0];
  if (!milk) report(false, 'Product page', 'no product to inspect');
  else {
    const detail = await call('get_product', { productId: milk.productId });
    const data = detail.data as { price?: PriceTag | null; availability?: string; saleRules?: { status: string } } | undefined;
    const issue = !data ? describe(detail) : !data.price ? 'price missing' : data.availability === 'unknown' ? 'availability unknown'
      : data.saleRules?.status !== 'available' ? 'sale rules unavailable' : null;
    report(issue === null, 'Product page', issue ?? `product ${milk.productId}, ${data?.availability}, sale rules available`);
  }

  // Produce is sold by the piece but priced per kg; its sale rules must convert to whole pieces.
  const apple = products(await call('search_products', { query: 'maçã', limit: 10 })).find(product => product.price?.per === 'kg');
  if (!apple) report(false, 'Weighted product page', 'no product priced per kg to inspect');
  else {
    const detail = await call('get_product', { productId: apple.productId });
    const rules = (detail.data as { saleRules?: { status: string; rules?: WeightedRules } } | undefined)?.saleRules;
    const whole = (quantity: { value: number; unit: string } | null | undefined) => quantity?.unit === 'un' && Number.isInteger(quantity.value);
    const issue = !detail.data ? describe(detail) : rules?.status !== 'available' || !rules.rules ? 'sale rules unavailable'
      : rules.rules.saleUnit !== 'un' || rules.rules.storefrontUnit !== 'kg' ? `sold in ${rules.rules.saleUnit}, priced in ${rules.rules.storefrontUnit}`
        : !whole(rules.rules.minimum) || !whole(rules.rules.maximum) || !whole(rules.rules.step) ? 'minimum, maximum or step is not a whole number of pieces' : null;
    report(issue === null, 'Weighted product page', issue ?? `product ${apple.productId}, minimum ${rules?.rules?.minimum?.value} un, maximum ${rules?.rules?.maximum?.value} un`);
  }

  // The cart states the minimum order; the EntregaZero free-delivery threshold is only on the help pages.
  const minicart = JSON.parse(await fetchText('/on/demandware.store/Sites-continente-Site/default/Cart-MiniCartShow', { 'X-Requested-With': 'XMLHttpRequest' })) as { resources?: { minimumOrderValueWarning?: unknown } };
  const minimum = minimumOrderOf(minicart.resources?.minimumOrderValueWarning);
  report(minimum !== null, 'Minimum order', minimum ? `€${(minimum.minorUnits / 100).toFixed(2)}` : `message not recognised: ${JSON.stringify(minicart.resources?.minimumOrderValueWarning ?? null)}`);
  // The sign-in form our login relies on, without submitting anything: the check runs signed out,
  // so it never signs in, and Continente's robot check only appears after an email is entered.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ locale: 'pt-PT' })).newPage();
    await page.goto(`${ORIGIN}/login/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('button', { name: /^permitir todos$/i }).click({ timeout: 5000 }).catch(() => {});
    const fromLogin = () => page.frames().find(frame => { try { return new URL(frame.url()).origin === 'https://login.continente.pt'; } catch { return false; } });
    const frame = fromLogin() ?? await page.waitForEvent('framenavigated', { predicate: frame => frame === fromLogin(), timeout: 15000 }).catch(() => undefined);
    const email = frame ? await frame.locator('#userNameCC').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false) : false;
    const submit = frame ? await frame.getByRole('button', { name: /avançar/i }).count() > 0 : false;
    const robotCheck = frame ? /altcha/i.test(await frame.content()) : false;
    report(Boolean(frame) && email && submit, 'Sign-in page', !frame ? 'no login frame from login.continente.pt'
      : !email ? 'the email field (#userNameCC) is missing' : !submit ? 'the "Avançar" button is missing'
        : `email step present; robot check ${robotCheck ? 'loaded (a person ticks it during sign-in)' : 'not loaded'}`);
  } finally { await browser.close(); }

  const help = (await fetchText('/loja-online/ajuda/entregazero/existe-valor-minimo-de-compra-para-utilizar-o-servico-entregazero/')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const stated = /valor m[ií]nimo de (\d+)\s*€/i.exec(help)?.[1];
  report(stated !== undefined && Number(stated) * 100 === ENTREGA_ZERO_FREE_FROM.minorUnits, 'EntregaZero threshold',
    stated === undefined ? 'the help page no longer states a minimum' : `help page says €${stated}, the server assumes €${ENTREGA_ZERO_FREE_FROM.minorUnits / 100}`);
} catch (error) {
  report(false, 'Check run', error instanceof Error ? error.message : String(error));
} finally {
  await app.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed. The website may have changed; see docs/troubleshooting.md.`);
  process.exitCode = 1;
} else console.log('\nAll checks passed.');
