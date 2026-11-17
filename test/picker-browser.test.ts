import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { PICKER_HTML } from '../src/mcp/picker.js';

const decisions = [
  { question: 'Leite meio gordo', suggested: '8504295', failures: [], options: [
    { productId: '4421406', name: 'Leite UHT Meio Gordo Mimosa', packageText: '6 x 1 lt', price: { amount: { currency: 'EUR', minorUnits: 534 }, per: 'item' },
      unitPrice: { amount: { currency: 'EUR', minorUnits: 89 }, per: 'l', basis: 'pack' }, availability: 'available', imageUrl: null },
    { productId: '8504295', name: 'Leite UHT Meio Gordo Continente', packageText: '6 x 1 lt', price: { amount: { currency: 'EUR', minorUnits: 510 }, per: 'item' },
      unitPrice: null, availability: 'available', imageUrl: null }] },
  { question: 'Manteiga de amendoim', suggested: null, failures: [], options: [
    { productId: '8167238', name: 'Manteiga de Amendoim Continente', packageText: '500 gr', price: { amount: { currency: 'EUR', minorUnits: 249 }, per: 'item' },
      unitPrice: null, availability: 'available', imageUrl: null },
    { productId: '6403609', name: 'Manteiga de Amendoim Prozis', packageText: '1 kg', price: { amount: { currency: 'EUR', minorUnits: 799 }, per: 'item' },
      unitPrice: null, availability: 'unavailable', imageUrl: null }] },
];

/** A host page that speaks the MCP Apps protocol to the picker in an iframe and records what it sends. */
const host = (locale: string, acceptMessage: boolean, sendResult = true) => `<!DOCTYPE html><html><body><iframe id="view" style="width:700px;height:900px"></iframe><script>
  window.received = [];
  const view = document.getElementById('view');
  const result = { content: [{ type: 'text', text: 'choices' }], structuredContent: { result: { status: 'success', data: { decisions: ${JSON.stringify(decisions)} } } } };
  window.addEventListener('message', event => {
    const message = event.data; if (!message || message.jsonrpc !== '2.0') return;
    window.received.push(message);
    const reply = body => view.contentWindow.postMessage(Object.assign({ jsonrpc: '2.0', id: message.id }, body), '*');
    if (message.method === 'ui/initialize') reply({ result: { protocolVersion: '2026-01-26', hostInfo: { name: 'test', version: '1' }, hostCapabilities: {}, hostContext: { theme: 'light', locale: '${locale}' } } });
    if (message.method === 'ui/notifications/initialized' && ${sendResult}) view.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
    if (message.method === 'ui/message') reply(${acceptMessage} ? { result: {} } : { result: { isError: true } });
  });
  view.srcdoc = ${JSON.stringify(PICKER_HTML).replace(/<\//g, '<\\/')};
</script></body></html>`;

test('the picker shows every choice, preselects suggestions and sends all choices in one message', {
  skip: process.env.CONTINENTE_LOCAL_BROWSER_TEST !== '1' && 'Opt in with CONTINENTE_LOCAL_BROWSER_TEST=1',
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent(host('en-GB', true));
    const view = page.frameLocator('#view');
    await view.locator('section').nth(1).waitFor();
    assert.deepEqual(await view.locator('h2').allTextContents(), ['1. Leite meio gordo', '2. Manteiga de amendoim']);
    // The suggestion starts selected; the second choice is still open, so confirming waits.
    assert.equal(await view.locator('section').nth(0).locator('[role="radio"][aria-checked="true"] .name').textContent(), 'Leite UHT Meio Gordo Continente');
    assert.equal(await view.locator('#confirm').isDisabled(), true);
    assert.equal(await view.locator('#status').textContent(), '1 left to choose');
    assert.match(await view.locator('section').nth(0).locator('button.option').nth(0).locator('.meta').textContent() ?? '', /6 x 1 lt · €0\.89\/l/);
    assert.match(await view.locator('section').nth(1).locator('button.option').nth(1).locator('.meta').textContent() ?? '', /unavailable/);
    assert.equal(await view.locator('section').nth(1).locator('button.option').nth(1).evaluate(node => node.classList.contains('unavailable')), true);
    await view.locator('section').nth(0).locator('button.option').nth(0).click();
    await view.locator('section').nth(1).locator('button.option').nth(1).click();
    await view.locator('#confirm').click();
    await view.locator('.done', { hasText: 'Choices sent' }).waitFor();
    const messages = await page.evaluate(() => (window as unknown as { received: { method?: string; params?: { content?: { text: string }[] } }[] }).received);
    const sent = messages.filter(message => message.method === 'ui/message');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.params?.content?.[0]?.text, 'My choices (the product ID for each choice):\n1. 4421406\n2. 6403609');
    // The picker folds into what was chosen, so nothing can be picked or sent again.
    assert.deepEqual(await view.locator('.done li').allTextContents(),
      ['Leite meio gordo: Leite UHT Meio Gordo Mimosa (6 x 1 lt)', 'Manteiga de amendoim: Manteiga de Amendoim Prozis (1 kg)']);
    assert.equal(await view.locator('[role="radio"]').count(), 0);
    assert.equal(await view.locator('#footer').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the picker speaks Portuguese for a Portuguese client, allows "none of these" and shows the choices when a message is refused', {
  skip: process.env.CONTINENTE_LOCAL_BROWSER_TEST !== '1' && 'Opt in with CONTINENTE_LOCAL_BROWSER_TEST=1',
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(host('pt-PT', false));
    const view = page.frameLocator('#view');
    await view.locator('section').nth(1).waitFor();
    assert.equal(await view.locator('#confirm').textContent(), 'Confirmar escolhas');
    await view.locator('section').nth(1).locator('.none').click();
    await view.locator('#confirm').click();
    await view.locator('textarea').waitFor();
    assert.equal(await view.locator('textarea').inputValue(), 'As minhas escolhas (ID do produto para cada escolha):\n1. 8504295\n2. nenhum destes');
  } finally { await browser.close(); }
});

test('the picker reports its own height so the frame can shrink, and shows no text or button before the choices arrive', {
  skip: process.env.CONTINENTE_LOCAL_BROWSER_TEST !== '1' && 'Opt in with CONTINENTE_LOCAL_BROWSER_TEST=1',
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const waitingPage = await browser.newPage();
    await waitingPage.setContent(host('en-GB', true, false));
    const waitingView = waitingPage.frameLocator('#view');
    await waitingView.locator('#loading', { hasText: 'Loading…' }).waitFor({ state: 'attached' });
    assert.equal(await waitingView.locator('#footer').isVisible(), false);
    assert.equal(await waitingView.locator('#confirm').isVisible(), false);
    assert.equal(await waitingView.locator('.skeleton').isVisible(), true);
    assert.equal(await waitingView.locator('h2').count(), 0);

    const page = await browser.newPage();
    await page.setContent(host('en-GB', true));
    const view = page.frameLocator('#view');
    await view.locator('section').nth(1).waitFor();
    // The frame starts at 900 px; the picker is shorter and says so, rather than the frame's own height.
    const heights = async () => (await page.evaluate(() => (window as unknown as { received: { method?: string; params?: { height?: number } }[] }).received))
      .filter(message => message.method === 'ui/notifications/size-changed').map(message => message.params?.height ?? 0);
    const content = await view.locator('main').evaluate(node => Math.ceil(node.getBoundingClientRect().height));
    await page.waitForFunction(height => (window as unknown as { received: { method?: string; params?: { height?: number } }[] }).received
      .some(message => message.method === 'ui/notifications/size-changed' && message.params?.height === height), content);
    assert.ok(content < 900);
    assert.ok((await heights()).every(height => height < 900));
  } finally { await browser.close(); }
});

test('each choice is a radio group: Tab reaches the chosen option and arrow keys move the choice', {
  skip: process.env.CONTINENTE_LOCAL_BROWSER_TEST !== '1' && 'Opt in with CONTINENTE_LOCAL_BROWSER_TEST=1',
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(host('en-GB', true));
    const view = page.frameLocator('#view');
    await view.locator('section').nth(1).waitFor();
    const groups = view.locator('[role="radiogroup"]');
    assert.equal(await groups.count(), 2);
    assert.equal(await groups.nth(0).getAttribute('aria-labelledby'), 'question-0');
    const checked = (index: number) => groups.nth(index).locator('[aria-checked="true"]').textContent();
    // One Tab stop per choice: the suggestion where there is one, else the first option.
    assert.deepEqual(await groups.nth(0).locator('[role="radio"]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).tabIndex)), [-1, 0, -1]);
    assert.deepEqual(await groups.nth(1).locator('[role="radio"]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).tabIndex)), [0, -1, -1]);
    await groups.nth(0).locator('[aria-checked="true"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await checked(0), 'None of these');
    await page.keyboard.press('ArrowRight');
    assert.match(await checked(0) ?? '', /Mimosa/);
    await page.keyboard.press('End');
    assert.equal(await checked(0), 'None of these');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowDown');
    assert.match(await checked(1) ?? '', /Prozis/);
    assert.equal(await view.locator('#confirm').isDisabled(), false);
  } finally { await browser.close(); }
});
