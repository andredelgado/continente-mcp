# Troubleshooting

**Client can't connect?** Check its [installation instructions](clients.md). For an `npx`
setup, run `node --version` and `npx -y continentept-mcp --version` in a terminal on the
machine running the server. Node.js must be version 22 or newer.

**Connected, but shopping isn't working?** Ask your assistant to check your Continente
session with `get_session_status`. It shows whether credentials and saved cookies are
present. To check whether the website accepts the login, ask to see your cart.

| Symptom | What to do |
| --- | --- |
| `browser_unavailable`: Chromium is being downloaded | The first use downloads Chromium (about 150 MB). Wait a minute and try again. |
| `browser_unavailable`: Chromium could not be downloaded | Check the internet connection, then run `npx -y continentept-mcp install-browser` to see the download output. On Linux, add `--with-deps` to install system libraries. |
| `not_authenticated` | The message says whether no credentials are configured or Continente did not accept them. Check them in the extension's settings or your configuration, or sign in by hand with the command below. See [configuration](configuration.md). |
| "Sign-in needs you: Continente asks you to confirm you are not a robot" | If a Continente window opened, tick "Não sou um robô" there and press "Avançar", then try again. Otherwise run the command below and do the same in its window. See [configuration](configuration.md#não-sou-um-robô). |
| Sign-in keeps failing | Run the command below to watch the browser and complete any extra verification the website asks for. |
| Session status shows `authentication.state` is `unknown` | Ask to see your cart. The server checks the website for that request. Cached favorites can be returned before a login check. |
| Favorites are stale, or not marked in search results | Call `list_favorites` with `refresh: true`, then search again. |
| The product picker shows as text in Claude Desktop | Reply with the number of your choice. On macOS with Claude Desktop 4.23118.0, users also reported that opening an incognito chat restored the photos. [Issue report](https://github.com/anthropics/claude-code/issues/108122) |
| `sale_rules_unknown` | The product's sale rules could not be interpreted, or its cart line does not say how much it holds in the sale unit. Nothing was sent. Check `get_product` and `get_cart`, and use the website for that product. |
| `quantity_below_minimum` or an off-step `invalid_input` | Use a quantity that fits the sale unit, minimum, maximum and step reported by `get_product`. |
| A cart or coupon change returned `mutation.outcome: "unknown"` | Check what happened before making another change. For items, ask to see the cart (`get_cart`). For coupons, ask which ones are selected (`list_coupons`). |
| `Multiple cart lines match this product` | Call `get_cart` and pass the intended line's `cartItemId`. |
| Order lines are `unavailable` or results are `partial` | Some pages could not be read. Read `failures`; missing data is never filled in. |
| `Invalid order history cursor` or `Order history changed` | Call `list_orders` again without a cursor. |
| `deadline_exceeded` or `queue_full` | Reduce `limit`, `detailLimit` or `orderLimit`, or wait for the previous call to finish. |
| Nothing appears on stdout when started by hand | Expected: stdout carries only MCP protocol messages. Logs are written to stderr. |

## Signing in by hand

```sh
npx -y continentept-mcp login --show-browser
```

This uses your configured credentials to sign in and save the session. Complete any extra
verification the website asks for in the browser window.

- Error messages and `signIn.command` give this same command. It needs Node.js 22 or newer.
- **Claude Desktop extension:** the command cannot read the email and password stored in the
  extension's settings. Create a [credentials file](configuration.md#credentials-file) first.
  The session it saves is then used by the extension too.
- **No screen** (a server, Docker, an SSH session): run it on a computer that has one and copy
  the session over. See [Without a screen](configuration.md#without-a-screen).

## Reporting a problem

The website can change its pages at any time. If a tool starts failing with `invalid_data`,
please [open an issue](https://github.com/andredelgado/continente-mcp/issues) with the tool
name, error code and version. Do not include credentials, the saved session, order numbers or
page captures from your account.
