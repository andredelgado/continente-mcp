# Continente MCP

[![CI](https://github.com/andredelgado/continente-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/andredelgado/continente-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/continentept-mcp)](https://www.npmjs.com/package/continentept-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An open-source MCP server that runs on your computer and connects Claude, Cursor, VS Code,
Codex, local models and other assistants to [Continente.pt](https://www.continente.pt).
Compare groceries, check labels, look up past orders and fill your cart. You choose a delivery
slot and pay on the website.

<p align="center">
  <img src="docs/images/picker-demo.gif" width="600"
    alt="The assistant shows milk, banana and Greek yoghurt options with photos and prices; the user switches two choices and confirms">
</p>

> **Unofficial.** This project is independent of Continente and MC Sonae. It uses the public
> website and may break when the site changes. The website's terms apply.
>
> **Using ChatGPT?** Continente has its own official app there, which is the simpler choice:
> open **Plugins** in ChatGPT, search for Continente and sign in with your Continente account.

## Install

Pick your client. The `npx` commands need [Node.js 22 or newer](https://nodejs.org); the
Claude Desktop extension brings its own. The first search downloads Chromium (about 150 MB).

| Client | How |
| --- | --- |
| Claude Desktop (macOS or Windows) | Download [**continente-mcp.mcpb**](https://github.com/andredelgado/continente-mcp/releases/latest/download/continente-mcp.mcpb) and open it |
| Claude Code | `claude mcp add --scope user continente -- npx -y continentept-mcp` |
| VS Code | [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=continente&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22continentept-mcp%22%5D%7D) |
| Cursor | [![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=continente&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvbnRpbmVudGVwdC1tY3AiXX0=) |
| LM Studio | [![Add to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-dark.svg)](https://lmstudio.ai/install-mcp?name=continente&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvbnRpbmVudGVwdC1tY3AiXX0%3D) |
| ChatGPT desktop | Continente's official ChatGPT app is simpler. For this server: **Settings > MCP servers > Add server**, **STDIO**, `npx -y continentept-mcp` ([steps](docs/clients.md#chatgpt-desktop)) |
| Codex CLI | `codex mcp add continente -- npx -y continentept-mcp` |
| Gemini CLI | `gemini mcp add -s user continente npx -- -y continentept-mcp` |
| Other apps and editors | [Client guide, including Cherry Studio and AnythingLLM](docs/clients.md) · [Docker](docs/configuration.md#docker) |

**Using a coding agent** such as Claude Code, Codex or Cursor? Paste this into its chat
instead, and it adds the server itself:

```text
Install and configure Continente MCP for this client. Add a local stdio server
named continente that runs npx -y continentept-mcp. Keep my existing MCP servers
and settings. Don't ask for my Continente password. If its tools are already
available, call get_session_status to check the connection; otherwise tell me
to restart the client first. Then tell me to run npx -y continentept-mcp setup
in a terminal to connect my Continente account.
```

Once it's added, restart the client if it asks, then try this in chat. A product search
needs no account or API key.

> Search Continente for “leite meio-gordo” and show me three options with their prices per litre.

### Connect your Continente account

Favorites, past orders, coupons and the cart need your login. Run this in a terminal on the
machine running the server:

```sh
npx -y continentept-mcp setup
```

It asks for your email and password without showing the password, saves them in a file only
you can read and signs in once. Type them there, not in the chat. On Claude Desktop, enter
them in the extension's settings instead. Then restart the client.

> Use my past orders to suggest a shopping list for this week. Show me the estimated cost.

## Features

- Read your favorites, past orders and the products you buy most often, and turn them
  into a shopping list.
- Compare pack prices, prices per kilo, litre or wash, and promotions. Check ingredients,
  allergens and nutrition as listed on the product label.
- Pick between products in chat. Clients that support MCP Apps show photos side by side.
  Other clients show a numbered list.
- Preview a list before adding it. The estimate shows progress toward the order minimum
  and whether EntregaZero covers delivery. Other delivery fees are set at checkout.
- Add or remove items and select Cartão Continente coupons. The server checks the result
  after each change. If it can't confirm what happened, it tells you and stops. Ask to see
  your cart or selected coupons to check.

## What it can access

Continente MCP never checks out: it blocks order submission, payment and delivery-slot
booking, so you finish every order on the website. Your email and password go only to
Continente.pt, and your assistant receives only the results you ask for, such as your cart
or past orders.

The server keeps the website session and cached favorites in `~/.continentept-mcp` by
default. Claude Desktop stores the extension password in its secure settings. A manual
credentials file stores it in plain text with access restricted to your user when you
follow the [file setup instructions](docs/configuration.md#credentials-file).

The browser opens Continente pages, which load their usual images and scripts. The npm
package and the extension download Chromium from Playwright on first use, and the server
checks npm for updates at most once a day. Claude Desktop's warning when you install the
extension applies to every local extension: it runs as a program with your user's permissions.

[Stored files](docs/configuration.md#stored-data) · [Update settings](docs/configuration.md#update-check) · [Source code](src)

## Limitations

- One account per server process.
- Each search reads up to five result pages per call. Order listings read up to ten.
- When Continente asks you to confirm you are not a robot, you tick the box yourself in a
  sign-in window the server opens ([details](docs/configuration.md#não-sou-um-robô)). The
  server never answers that check.
- Edit your favorites on Continente.pt. The assistant can read your saved list.

## Status

Continente MCP is feature-complete and in maintenance. Fixes for website changes, bugs and
security issues continue. New features are unlikely, so please open an issue before starting
one.

## Documentation

- [Setup by client](docs/clients.md)
- [Tool reference](docs/tools.md): what each tool does, which need your account and which can
  change the cart
- [Configuration](docs/configuration.md): credentials, [read-only mode](docs/configuration.md#read-only-mode),
  [signing in from a terminal](docs/configuration.md#sign-in-and-saved-session) and Docker.
  `npx -y continentept-mcp --help` lists the commands.
- [Troubleshooting](docs/troubleshooting.md)
- [Stability](docs/stability.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
