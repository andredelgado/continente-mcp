# Continente MCP

[![CI](https://github.com/andredelgado/continente-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/andredelgado/continente-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/continentept-mcp)](https://www.npmjs.com/package/continentept-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants shop at
[Continente.pt](https://www.continente.pt): search products, check prices and sale rules,
read your favorites and past orders, and fill your cart. Checkout and payment always stay
on the website.

> **Unofficial.** This project is not affiliated with, endorsed by or supported by
> Continente or MC Sonae. It automates the public website with a headless browser, may break
> when the site changes, and should be used in line with the website's terms. You are
> responsible for anything placed in your cart.

## Features

- **Catalogue search and product details**, with exact prices, unit prices, availability and
  sale rules for weighted and bulk products.
- **Safe cart changes.** Every change is confirmed by reading the cart back. If a change
  cannot be confirmed, the result says so and tells the assistant to check the cart instead
  of retrying.
- **Your account**: favorites, order history and a ranking of the products you buy most.
- **Runs locally** over stdio. Your credentials and session are stored on your computer and
  sent only to Continente.pt.
- **Built-in guidance.** The server tells the assistant the cart rules as soon as it
  connects, and offers a `basket-planner` prompt with the full shopping workflow. Nothing
  extra to install; the same guide also ships as a [skill](skills/basket-planner/SKILL.md).

## Requirements

- A Continente.pt account for account features (search and product details work without one)
- Claude Desktop on macOS or Windows for the one-click install, or Node.js 22 or newer for
  any other MCP client

The server drives the website with Chromium, which it downloads automatically the first time
it needs it (about 150 MB, once).

## Install in Claude Desktop (one click)

1. Download [**continente-mcp.mcpb**](https://github.com/andredelgado/continente-mcp/releases/latest/download/continente-mcp.mcpb)
   from the latest release.
2. Open it. Claude Desktop shows an install dialog; click **Install**.
3. Enter your Continente email and password when asked. Claude Desktop keeps the password
   in its secure settings storage.

That's it. The server is also listed
in the [MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.andredelgado/continente-mcp`, so clients that browse the registry can find it. To use 1Password instead
of storing the password in Claude Desktop, use the manual setup below.

### Updates

The server checks npm once a day for a newer release. When there is one, it tells the
assistant, so Claude can mention it, and `get_session_status` shows it.

- **Extension:** download the new `continente-mcp.mcpb` and open it. Claude Desktop updates the
  extension in place and keeps your email and password.
- **npx setups:** using `continentept-mcp@latest` picks up new versions when the client restarts.
- **Release emails:** on [GitHub](https://github.com/andredelgado/continente-mcp), choose
  **Watch → Custom → Releases**.

## Manual setup (any MCP client)

**1. Save your credentials** in `~/.continentept-mcp/credentials.env` (see
[configuration](docs/configuration.md) for other options):

```sh
mkdir -p ~/.continentept-mcp && chmod 700 ~/.continentept-mcp
printf 'CONTINENTE_EMAIL=you@example.com\nCONTINENTE_PASSWORD=your-password\n' > ~/.continentept-mcp/credentials.env
chmod 600 ~/.continentept-mcp/credentials.env
```

Using 1Password? Skip the file and pass secret references through `op run` instead; see
[Using 1Password](docs/configuration.md#using-1password).

Optionally check that login works:

```sh
npx -y continentept-mcp login
```

**2. Add the server to your MCP client.**

Claude Code:

```sh
claude mcp add continente -- npx -y continentept-mcp
```

Claude Desktop, Cursor and other clients (`claude_desktop_config.json`, `mcp.json`, ...):

```json
{
  "mcpServers": {
    "continente": {
      "command": "npx",
      "args": ["-y", "continentept-mcp"]
    }
  }
}
```

To keep the credentials file elsewhere, add
`"env": { "CONTINENTE_CREDENTIALS_FILE": "/absolute/path/to/credentials.env" }`.

Chromium downloads itself on first use. To fetch it ahead of time, run
`npx -y continentept-mcp install-browser` (on Linux, add `--with-deps` for the system
libraries it needs).

Then ask your assistant something like *"Add semi-skimmed milk and a dozen eggs to my
Continente cart"* or *"What do I usually buy? Build me a list for this week."*

## Tools

| Tool | What it does |
| --- | --- |
| `search_products` | Search the catalogue in relevance order, with favorites marked and a cursor for more |
| `get_product` | Price, pack size, availability and sale rules for one product |
| `get_product_labels` | Ingredients, allergens and nutrition as the label declares them |
| `choose_products` | Let the user pick between products, with photos where the client supports it |
| `list_favorites` | Your saved favorites (`refresh: true` fetches the latest) |
| `get_cart` | Cart lines, quantities, bags and totals |
| `preview_cart_changes` | What a list of changes would do and cost, without changing the cart |
| `get_checkout_summary` | Provisional basket totals, immediate discounts and loyalty credit separately |
| `list_coupons` | Displayed account coupons; eligibility and expiry stay unknown |
| `set_cart_coupons` | Select coupons in the cart using IDs from `list_coupons` |
| `list_pickup_stores` | Pickup store search using a postal code and public coordinates |
| `list_pickup_slots` | Read pickup times already rendered for an explicit date window |
| `set_pickup_store` | Change the selected primary pickup store and verify the new context |
| `add_cart_item` | Add an amount on top of what is in the cart |
| `set_cart_item_quantity` | Make the cart hold exactly a quantity; zero removes |
| `remove_cart_item` | Remove a line from the cart |
| `clear_cart` | Empty the whole cart in one confirmed step |
| `list_orders` | Recent orders with their product lines |
| `get_order` | One order's product lines |
| `list_frequently_bought_products` | Products ranked by how often you order them |
| `get_session_status` | Local login, cookie and cache state (no network) |

See the [tool reference](docs/tools.md) for inputs, outputs, error codes and limits.

### About uncertain cart changes

A cart change can fail after the request has reached the website, for example on a timeout.
In that case the result has `mutation.outcome: "unknown"` and asks the client to call
`get_cart` before doing anything else. The server never retries such a change on its own,
and clients should not either: repeating an `add_cart_item` could add the item twice.

### Guidance for the assistant

When a client connects, the server sends short instructions with these cart rules, so the
assistant follows them without any setup. For planning a shopping list, pick the
**basket-planner** prompt from your client's prompt or attachment menu, optionally with a
request such as "weekly basket for two".

The same guide is available as a skill in
[`skills/basket-planner`](skills/basket-planner/SKILL.md). Clients that support skills, such
as Claude Desktop (Settings → Capabilities → Skills) or Claude Code (`~/.claude/skills/`),
then apply it automatically whenever you ask about groceries.

## Command line

```text
continentept-mcp                    Start the MCP server on stdio
continentept-mcp login              Sign in and save the session (--show-browser to watch)
continentept-mcp install-browser    Download Chromium now instead of on first use (extra arguments go to Playwright)
continentept-mcp --version
```

## Limitations

- One account per server process.
- Searches read at most five result pages and order listings at most ten pages, so very
  broad queries or long histories are reported as incomplete rather than read in full.
- Login handles the standard email and password flow. If the website asks for extra
  verification, run `continentept-mcp login --show-browser` and complete it in the browser
  window.
- `set_pickup_store` changes only the primary pickup store through the observed coverage/context flow and reads the context back; pickup mode must already be active, so it does not switch from home delivery. After a confirmed change, re-read the cart and coupons. `list_pickup_slots` reads server-rendered availability for the verified selected store and only accepts a window within the next 31 days; it does not load more dates or reserve a slot. There are no slot reservation, checkout, payment or order-submission tools. Never open or navigate to payment.

## Documentation

- [Tool reference](docs/tools.md)
- [Stability](docs/stability.md): what counts as a breaking change from 1.0
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
