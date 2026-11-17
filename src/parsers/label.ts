import { load } from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { ProductLabelSchema, failure, success } from '../domain/index.js';
import type { ProductLabel, Result, ToolError } from '../domain/index.js';
import { storefrontUrl } from './catalog.js';

const LABEL_PATH = '/Product-ProductNutritionalInfoTab';
const text = (value: string) => value.replace(/\s+/g, ' ').trim();
/** The label request a product page links to; it needs the product's EAN, which only that page shows. */
export function productLabelUrl(html: string, productId: string): string | null {
  const urls = [...new Set(load(html)('a.js-nutritional-tab-anchor[data-url]').map((_, node) => load(node)('a').attr('data-url') ?? '').get())]
    .map(value => storefrontUrl(value)).filter((value): value is string => value !== null);
  const valid = urls.filter(value => { const url = new URL(value); return url.pathname.endsWith(LABEL_PATH) && url.searchParams.get('pid') === productId; });
  return valid.length === 1 ? valid[0]! : null;
}
export function isProductLabelUrl(value: string, productId: string): boolean {
  const href = storefrontUrl(value);
  if (!href) return false;
  const url = new URL(href);
  return url.pathname.endsWith(LABEL_PATH) && url.searchParams.get('pid') === productId;
}

/** The value paragraph that follows a field's caption, such as the ingredients after "Declaração de Ingredientes:". */
function field($: CheerioAPI, selector: string): string | null {
  const block = $(selector).first();
  if (!block.length) return null;
  const parts = block.children('p, span').toArray().map(node => text($(node).text()));
  const value = parts.length > 1 ? parts.slice(1).join(' ') : '';
  return value && value !== '.' ? value : null;
}
const UNITS: Record<string, string> = { KJO: 'kJ', E14: 'kcal', GRM: 'g', KGM: 'kg', MGM: 'mg', MC: 'µg', MLT: 'ml', LTR: 'l' };
const UNIT_NAMES: Record<string, string> = { grama: 'g', quilograma: 'kg', miligrama: 'mg', micrograma: 'µg', quilojoule: 'kJ', quilocaloria: 'kcal', mililitro: 'ml', litro: 'l' };
/** "(GRM) Grama" or "Grama" to g; anything else is kept as printed. */
function unit(label: string): string {
  const code = /^\((\w+)\)/.exec(label)?.[1];
  return (code && UNITS[code]) ?? UNIT_NAMES[label.replace(/^\(\w+\)\s*/, '').toLowerCase()] ?? label;
}
const KEYS: Record<string, NonNullable<ProductLabel['nutrition']>['nutrients'][number]['key']> = {
  'lípidos': 'fat', 'lípidos > saturados': 'saturated_fat', 'hidratos de carbono': 'carbohydrates',
  'hidratos de carbono > açúcares': 'sugars', 'fibra': 'fibre', 'proteínas': 'protein', 'sal': 'salt',
};
function nutrition($: CheerioAPI): ProductLabel['nutrition'] {
  const rows = $('.nutrients-table .nutrients-row').toArray().map(row => $(row).find('.nutriInfo-details').toArray().map(cell => text($(cell).text())))
    .filter(cells => cells.length === 3);
  const nutrients = rows.flatMap(([name = '', raw = '', printed = '']) => {
    const amount = /^\d+(?:,\d+)?$/.test(raw) ? Number(raw.replace(',', '.')) : null;
    if (!name || amount === null) return [];
    const normalised = unit(printed);
    const key = name.toLowerCase() === 'energia' ? (normalised === 'kJ' ? 'energy_kj' : normalised === 'kcal' ? 'energy_kcal' : null) : KEYS[name.toLowerCase()] ?? null;
    return [{ name, key, amount, unit: normalised }];
  });
  if (!nutrients.length) return null;
  const size = field($, '.serving-size'); const sizeUnit = field($, '.serving-size--uom');
  const perUnit = sizeUnit ? unit(sizeUnit) : null;
  const per = size && /^\d+(?:,\d+)?$/.test(size) && (perUnit === 'g' || perUnit === 'ml') ? { value: Number(size.replace(',', '.')), unit: perUnit as 'g' | 'ml' } : null;
  return { per, nutrients };
}
/** Capitalised words in the ingredients: SOJA, TRIGO, LEITE. Meaningless when everything is in capitals. */
function emphasised(ingredients: string | null): string[] | null {
  if (!ingredients || !/\p{Ll}/u.test(ingredients)) return null;
  // Two-letter capitals are abbreviations such as UE or PT; allergen names are longer (OVO, SOJA, LEITE).
  return [...new Set(ingredients.match(/\p{Lu}{2,}(?:[ -]\p{Lu}{2,})*/gu) ?? [])].filter(word => word.length >= 3);
}
const TRACES = /\b(?:pode conter|vest[ií]gios)/i;
/**
 * The sentence that declares traces ("Pode conter…", "…vestígios de…"). The phrase is found first and the
 * sentence is then cut at the full stops around it, so a long label with no such phrase is read once.
 */
function traceSentence(source: string | null): string | null {
  const found = source ? TRACES.exec(source) : null;
  if (!source || !found) return null;
  const end = source.indexOf('.', found.index);
  return text(source.slice(source.lastIndexOf('.', found.index - 1) + 1, end === -1 ? undefined : end + 1)) || null;
}
const mayContain = (...sources: (string | null)[]) => sources.map(traceSentence).find(Boolean) ?? null;

const DIMENSIONS: Record<string, 'mass' | 'volume'> = { g: 'mass', kg: 'mass', ml: 'volume', l: 'volume' };
/** "100" with "(GRM) Grama" as a quantity; null unless both are recognised. */
function netContent($: CheerioAPI): ProductLabel['netContent'] {
  const value = field($, '.net-content'); const printed = field($, '.net-content--uom');
  const normalised = printed ? unit(printed) : null;
  return value && /^\d+(?:,\d+)?$/.test(value) && normalised && normalised in DIMENSIONS
    ? { value: Number(value.replace(',', '.')), unit: normalised as 'g' | 'kg' | 'ml' | 'l' } : null;
}
/** Parse the label tab. A page without any label field is reported as missing rather than as an empty label. */
export function parseProductLabel(html: string): Result<ProductLabel | null, ToolError> {
  const $ = load(html);
  if (!$('.ct-pdp--description-content, .tab-row-details').length) return failure('invalid_data', 'The product label was not recognised');
  const ingredients = field($, '.ingredients');
  const allergenStatement = field($, '.allergen-statement');
  const facts = nutrition($); const net = netContent($);
  const mismatch = facts?.per && net && DIMENSIONS[facts.per.unit] !== DIMENSIONS[net.unit];
  const label = { regulatedName: field($, '.regulated-product-name'), ingredients, emphasised: emphasised(ingredients), allergenStatement,
    mayContain: mayContain(allergenStatement, ingredients), storage: field($, '.storage-instruction'), netContent: net,
    issues: mismatch ? ['nutrition_basis_mismatch' as const] : [], nutrition: facts };
  if (!label.ingredients && !label.allergenStatement && !label.nutrition && !label.regulatedName) return success(null);
  const parsed = ProductLabelSchema.safeParse(label);
  return parsed.success ? success(parsed.data) : failure('invalid_data', 'The product label was not recognised');
}

/** How much of a label the website gives: complete with ingredients and nutrition, partial with one of them, none with neither. */
export function labelStatus(label: ProductLabel | null): { status: 'complete' | 'partial' | 'none'; missing: ('ingredients' | 'allergenStatement' | 'nutrition')[] } {
  const missing = label ? (['ingredients', 'allergenStatement', 'nutrition'] as const).filter(key => label[key] === null) : ['ingredients' as const, 'allergenStatement' as const, 'nutrition' as const];
  const core = label ? [label.ingredients, label.nutrition].filter(value => value !== null).length : 0;
  return { status: core === 2 ? 'complete' : core === 1 ? 'partial' : 'none', missing: [...missing] };
}
