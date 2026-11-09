/**
 * The product picker, an MCP Apps view (https://github.com/modelcontextprotocol/ext-apps): clients
 * that support MCP Apps show it under the choose_products call; others use the tool's text. The
 * page speaks the small part of the protocol it needs (initialize, tool result, message, size)
 * itself, so the server ships no browser library. Colours, fonts and radii come from the client's
 * standard style variables when it sends them.
 */
export const PICKER_URI = 'ui://continentept-mcp/choose-products.html';
export const PICKER_MIME_TYPE = 'text/html;profile=mcp-app';
/** Product photos come from the website's own image service. */
export const PICKER_META = { ui: { csp: { resourceDomains: ['https://www.continente.pt'] }, prefersBorder: true } };

export const PICKER_HTML = String.raw`<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>Escolher produtos</title>
<style>
  :root {
    color-scheme: light dark;
    --fg: var(--color-text-primary, light-dark(#1a1a1a, #ececec));
    --muted: var(--color-text-secondary, light-dark(#595959, #b4b4b4));
    --line: var(--color-border-primary, light-dark(#d4d4d4, #4a4a4a));
    --surface: var(--color-background-secondary, light-dark(#f2f2f2, #2a2a2a));
    --button-bg: var(--color-background-inverse, light-dark(#1a1a1a, #ececec));
    --button-fg: var(--color-text-inverse, light-dark(#ffffff, #1a1a1a));
    --disabled-bg: var(--color-background-disabled, light-dark(#e6e6e6, #333333));
    --disabled-fg: var(--color-text-disabled, #8a8a8a);
    --ring: var(--color-ring-primary, light-dark(#1a1a1a, #ececec));
    --danger: var(--color-text-danger, light-dark(#b3261e, #ff8a80));
    --radius: var(--border-radius-lg, 10px);
    --radius-sm: var(--border-radius-sm, 6px);
    /* The shop's red marks what is chosen or suggested; actions stay neutral. */
    --brand: #d1171d;
  }
  [hidden] { display: none !important; }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--fg); background: transparent;
    font: var(--font-weight-normal, 400) var(--font-text-md-size, .875rem)/var(--font-text-md-line-height, 1.35) var(--font-sans, system-ui, -apple-system, sans-serif); }
  main { padding: .75rem; }
  section { margin-bottom: 1rem; }
  h2 { font-size: var(--font-heading-xs-size, .875rem); line-height: var(--font-heading-xs-line-height, 1.3); font-weight: var(--font-weight-semibold, 600); margin: 0 0 .5rem; }
  .options { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 8.75rem), 1fr)); gap: .5rem; }
  button { font: inherit; color: inherit; }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .option { all: unset; cursor: pointer; display: flex; flex-direction: column; gap: .25rem; padding: .5rem; border: 1px solid var(--line); border-radius: var(--radius); position: relative; }
  .option:hover { border-color: var(--muted); }
  .option:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .option[aria-checked="true"] { border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); }
  .option[aria-disabled="true"], .none[aria-disabled="true"] { cursor: default; }
  .photo { width: 100%; aspect-ratio: 1; object-fit: contain; background: #fff; border-radius: var(--radius-sm); }
  .placeholder { display: grid; place-items: center; background: var(--surface); color: var(--muted); font-size: var(--font-text-xs-size, .75rem); }
  .option.unavailable .photo { opacity: .45; filter: grayscale(1); }
  .option.unavailable .name, .option.unavailable .price { color: var(--muted); }
  .name { font-size: var(--font-text-sm-size, .8125rem); line-height: var(--font-text-sm-line-height, 1.3); }
  .meta { font-size: var(--font-text-xs-size, .75rem); line-height: var(--font-text-xs-line-height, 1.3); color: var(--muted); }
  .meta .out { color: var(--danger); font-weight: var(--font-weight-medium, 500); }
  .price { font-weight: var(--font-weight-semibold, 600); }
  .tag { position: absolute; top: .375rem; left: .375rem; font-size: var(--font-text-xs-size, .75rem); line-height: 1.4; padding: 0 .4rem; border-radius: var(--border-radius-full, 99px); background: var(--brand); color: #fff; }
  .check { position: absolute; top: .375rem; right: .375rem; width: 1.25rem; height: 1.25rem; border-radius: 50%; background: var(--brand); color: #fff; display: none; place-items: center; font-size: .75rem; line-height: 1; }
  .option[aria-checked="true"] .check { display: grid; }
  .none { all: unset; grid-column: 1 / -1; justify-self: start; cursor: pointer; display: inline-flex; align-items: center; gap: .375rem; min-height: 2rem; padding: 0 .625rem;
    border: 1px solid var(--line); border-radius: var(--border-radius-full, 99px); font-size: var(--font-text-sm-size, .8125rem); color: var(--muted); }
  .none:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .none[aria-checked="true"] { color: var(--fg); border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); }
  footer { display: flex; align-items: center; gap: .625rem; flex-wrap: wrap; }
  #confirm { cursor: pointer; font-weight: var(--font-weight-semibold, 600); min-height: 2.25rem; padding: 0 1rem; border-radius: var(--border-radius-md, 8px); border: 0; background: var(--button-bg); color: var(--button-fg); }
  #confirm[disabled] { cursor: default; background: var(--disabled-bg); color: var(--disabled-fg); }
  #status { font-size: var(--font-text-sm-size, .8125rem); color: var(--muted); }
  textarea { width: 100%; min-height: 6rem; margin-top: .5rem; font: var(--font-text-xs-size, .75rem) var(--font-mono, ui-monospace, monospace); color: inherit; background: transparent; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .skeleton .bar, .skeleton .card { background: var(--surface); border-radius: var(--radius); }
  .skeleton .bar { width: 9rem; height: 1rem; margin-bottom: .5rem; border-radius: var(--radius-sm); }
  .skeleton .card { height: 7rem; }
  @media (prefers-reduced-motion: no-preference) { .skeleton { animation: pulse 1.4s ease-in-out infinite; } }
  @keyframes pulse { 50% { opacity: .55; } }
  .done { margin-bottom: 0; }
  .done h2 { display: flex; align-items: center; gap: .375rem; }
  .done h2 .check { position: static; display: grid; }
  .done ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .375rem; }
  .done li { display: flex; align-items: center; gap: .5rem; font-size: var(--font-text-sm-size, .8125rem); }
  .done .thumb { width: 2.25rem; height: 2.25rem; flex: none; }
  .done .question { color: var(--muted); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
</head>
<body>
<main>
  <div id="decisions" aria-busy="true">
    <div class="skeleton" aria-hidden="true"><div class="bar"></div><div class="options"><div class="card"></div><div class="card"></div><div class="card"></div></div></div>
    <span class="visually-hidden" id="loading" role="status"></span>
  </div>
  <footer hidden id="footer"><button id="confirm" type="button"></button><span id="status" role="status"></span></footer>
</main>
<script>
const TEXT = {
  pt: { loading: 'A carregar…', confirm: 'Confirmar escolhas', none: 'Nenhum destes', suggested: 'Sugestão', unavailable: 'indisponível', noPhoto: 'sem foto',
    sending: 'A enviar…', sent: 'Escolhas enviadas', rejected: 'O cliente não aceitou a mensagem. Copie as escolhas:', pending: n => n + ' por escolher',
    message: 'As minhas escolhas:', chose: 'nenhum destes', perUnit: { kg: '/kg', l: '/l' } },
  en: { loading: 'Loading…', confirm: 'Confirm choices', none: 'None of these', suggested: 'Suggested', unavailable: 'unavailable', noPhoto: 'no photo',
    sending: 'Sending…', sent: 'Choices sent', rejected: 'The client did not accept the message. Copy your choices:', pending: n => n + ' left to choose',
    message: 'My choices:', chose: 'none of these', perUnit: { kg: '/kg', l: '/l' } },
};
const NONE = 'none';
let text = TEXT.pt;
let decisions = [];
let sent = false;
const picks = new Map();
const main = document.querySelector('main');
const root = document.getElementById('decisions');
const footer = document.getElementById('footer');
const confirmButton = document.getElementById('confirm');
const statusLine = document.getElementById('status');

// MCP Apps bridge: JSON-RPC 2.0 over postMessage with the client.
let nextId = 1;
const waiting = new Map();
const post = message => window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, message), '*');
const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); post({ id, method, params }); });
window.addEventListener('message', event => {
  const message = event.data;
  if (event.source !== window.parent || !message || message.jsonrpc !== '2.0') return;
  if (message.id !== undefined && message.method === undefined) {
    const handler = waiting.get(message.id); waiting.delete(message.id);
    if (handler) message.error ? handler.reject(message.error) : handler.resolve(message.result);
  } else if (message.method === 'ui/notifications/tool-result') show(message.params);
  else if (message.method === 'ui/notifications/host-context-changed') applyContext(message.params);
  else if (message.id !== undefined) {
    if (message.method === 'ping' || message.method === 'ui/resource-teardown') post({ id: message.id, result: {} });
    else post({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});

function applyContext(context) {
  if (!context) return;
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) if (value) document.documentElement.style.setProperty(name, value);
  if (context.locale) { text = String(context.locale).toLowerCase().startsWith('pt') ? TEXT.pt : TEXT.en; document.documentElement.lang = text === TEXT.pt ? 'pt' : 'en'; }
}
const euros = minorUnits => (minorUnits / 100).toLocaleString(text === TEXT.pt ? 'pt-PT' : 'en-GB', { style: 'currency', currency: 'EUR' });
const priceText = option => option.price ? euros(option.price.amount.minorUnits) + (option.price.per === 'kg' ? '/kg' : option.price.per === 'l' ? '/l' : option.price.per === 'piece' ? '/un' : option.price.per === 'dose' ? '/dose' : '') : '';
const unitText = option => option.unitPrice && option.price?.per === 'item' ? euros(option.unitPrice.amount.minorUnits) + text.perUnit[option.unitPrice.per] : '';

function element(tag, className, content) { const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node; }
function photo(option, className) {
  const placeholder = () => element('div', className + ' placeholder', className === 'photo' ? text.noPhoto : '');
  if (!option?.imageUrl) return placeholder();
  // The name is printed next to the photo, so the photo itself is decorative.
  const image = element('img', className); image.src = option.imageUrl; image.alt = ''; image.loading = 'lazy';
  image.addEventListener('error', () => image.replaceWith(placeholder()));
  return image;
}
function show(result) {
  if (sent) return;
  decisions = result?.structuredContent?.result?.data?.decisions ?? [];
  picks.clear();
  root.removeAttribute('aria-busy');
  root.replaceChildren(...decisions.map((decision, index) => {
    const section = element('section');
    const heading = element('h2', '', (index + 1) + '. ' + decision.question); heading.id = 'question-' + index;
    const group = element('div', 'options'); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-labelledby', heading.id);
    for (const option of decision.options) {
      const button = element('button', 'option'); button.type = 'button'; button.dataset.value = option.productId;
      const unavailable = option.availability === 'unavailable';
      if (unavailable) button.classList.add('unavailable');
      if (option.productId === decision.suggested) button.append(element('span', 'tag', text.suggested));
      const check = element('span', 'check', '✓'); check.setAttribute('aria-hidden', 'true');
      button.append(check, photo(option, 'photo'), element('span', 'name', option.name));
      const details = [option.packageText, unitText(option)].filter(Boolean).join(' · ');
      if (details || unavailable) {
        const meta = element('span', 'meta', details);
        if (unavailable) meta.append((details ? ' · ' : ''), element('span', 'out', text.unavailable));
        button.append(meta);
      }
      button.append(element('span', 'price', priceText(option)));
      group.append(button);
    }
    const none = element('button', 'none', text.none); none.type = 'button'; none.dataset.value = NONE;
    group.append(none);
    for (const radio of group.children) {
      radio.setAttribute('role', 'radio'); radio.setAttribute('aria-checked', 'false');
      radio.addEventListener('click', () => choose(index, radio.dataset.value));
    }
    group.addEventListener('keydown', event => move(index, event));
    section.append(heading, group);
    return section;
  }));
  decisions.forEach((decision, index) => { if (decision.suggested) choose(index, decision.suggested); else roving(index); });
  confirmButton.textContent = text.confirm;
  footer.hidden = decisions.length === 0;
  refresh();
}
const radios = index => [...root.children[index].querySelectorAll('[role="radio"]')];
/** One stop per choice for Tab: the chosen option, or the first one while nothing is chosen. */
function roving(index) {
  const all = radios(index); const checked = all.find(radio => radio.getAttribute('aria-checked') === 'true') ?? all[0];
  for (const radio of all) radio.tabIndex = radio === checked ? 0 : -1;
}
function choose(index, value) {
  if (sent) return;
  picks.set(index, value);
  for (const radio of radios(index)) radio.setAttribute('aria-checked', String(radio.dataset.value === value));
  roving(index);
  refresh();
}
/** Arrow keys, Home and End move between a choice's options and pick the one they land on, as radio buttons do. */
function move(index, event) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (step === undefined && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  if (sent) return;
  const all = radios(index); const at = all.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : (Math.max(at, 0) + step + all.length) % all.length;
  choose(index, all[next].dataset.value); all[next].focus();
}
function refresh() {
  const left = decisions.length - picks.size;
  confirmButton.disabled = left > 0 || sent;
  if (!sent) statusLine.textContent = left > 0 ? text.pending(left) : '';
}
const chosen = index => decisions[index].options.find(item => item.productId === picks.get(index));
function summary() {
  return [text.message, ...decisions.map((decision, index) => {
    const option = chosen(index);
    return (index + 1) + '. ' + decision.question + ': ' + (option ? option.name + (option.packageText ? ' (' + option.packageText + ')' : '') + ' [' + option.productId + ']' : text.chose);
  })].join('\n');
}
/** After sending, the picker folds into a short list of what was chosen. */
function showSent() {
  const done = element('section', 'done');
  const heading = element('h2'); const check = element('span', 'check', '✓'); check.setAttribute('aria-hidden', 'true');
  heading.append(check, text.sent);
  const list = element('ul');
  decisions.forEach((decision, index) => {
    const option = chosen(index); const item = element('li');
    const label = element('span'); label.append(element('span', 'question', decision.question + ': '), option ? option.name + (option.packageText ? ' (' + option.packageText + ')' : '') : text.chose);
    item.append(option ? photo(option, 'photo thumb') : element('div', 'photo thumb placeholder'), label);
    list.append(item);
  });
  done.append(heading, list);
  root.replaceChildren(done);
  footer.hidden = true;
}
confirmButton.addEventListener('click', async () => {
  sent = true; confirmButton.disabled = true;
  for (const radio of root.querySelectorAll('[role="radio"]')) { radio.setAttribute('aria-disabled', 'true'); radio.tabIndex = -1; }
  statusLine.textContent = text.sending;
  const message = summary();
  try {
    const result = await request('ui/message', { role: 'user', content: [{ type: 'text', text: message }] });
    if (result?.isError) throw new Error('rejected');
    showSent();
  } catch {
    statusLine.textContent = text.rejected;
    const copy = element('textarea'); copy.value = message; copy.readOnly = true; footer.after(copy);
  }
});

// Report the content's own height: the document's scroll height never drops below the frame the client
// made, so it could only grow.
let reported = 0;
new ResizeObserver(() => {
  const height = Math.ceil(main.getBoundingClientRect().height);
  if (height !== reported) { reported = height; post({ method: 'ui/notifications/size-changed', params: { height } }); }
}).observe(main);
request('ui/initialize', { appInfo: { name: 'continentept-mcp product picker', version: '1' }, appCapabilities: {}, protocolVersion: '2026-01-26' })
  .then(result => { applyContext(result?.hostContext); document.getElementById('loading').textContent = text.loading; post({ method: 'ui/notifications/initialized' }); })
  .catch(() => { document.getElementById('loading').textContent = text.loading; });
</script>
</body>
</html>
`;
