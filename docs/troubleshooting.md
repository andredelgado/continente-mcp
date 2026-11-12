# Troubleshooting

Run `get_session_status` first: it shows whether credentials and saved cookies are present
without contacting the website.

| Symptom | What to do |
| --- | --- |
| `browser_unavailable`: Chromium is being downloaded | The first use downloads Chromium (about 150 MB). Wait a minute and try again. |
| `browser_unavailable`: Chromium could not be downloaded | Check the internet connection, then run `npx -y continentept-mcp install-browser` to see the download output. On Linux, add `--with-deps` to install system libraries. |
| `not_authenticated` | The message says whether no credentials are configured or Continente did not accept them. Check them in the extension's settings or your configuration, or sign in by hand with the command below. See [configuration](configuration.md). |
| "Sign-in needs you: Continente asks you to confirm you are not a robot" | If a Continente window opened, tick "Não sou um robô" there and press "Avançar", then try again. Otherwise run the command below and do the same in its window. See [configuration](configuration.md#não-sou-um-robô). |
| Sign-in keeps failing | Run the command below to watch the browser and complete any extra verification the website asks for. |
| Status shows `authentication: unknown` | Nothing has been observed since the server started or since the saved session changed. Any account tool will establish it. |
| Favorites are stale, or not marked in search results | Call `list_favorites` with `refresh: true`, then search again. |
| The product picker shows as text in Claude Desktop | Claude Desktop 4.23118.0 does not show the picker in ordinary chats for local extensions; it still shows in an incognito chat. Reported in [anthropics/claude-code#108122](https://github.com/anthropics/claude-code/issues/108122). |
| `sale_rules_unknown` | The product's sale rules could not be interpreted, or its cart line does not say how much it holds in the sale unit. Nothing was sent. Check `get_product` and `get_cart`, and use the website for that product. |
| `quantity_below_minimum` or an off-step `invalid_input` | Use a quantity that fits the sale unit, minimum, maximum and step reported by `get_product`. |
| A cart change returned `mutation.outcome: "unknown"` | The cart may have changed. Call `get_cart` and decide from the actual contents. Do not repeat the change automatically. |
| `Multiple cart lines match this product` | Call `get_cart` and pass the intended line's `cartItemId`. |
| Order lines are `unavailable` or results are `partial` | Some pages could not be read. Read `failures`; missing data is never filled in. |
| `Invalid order history cursor` or `Order history changed` | Call `list_orders` again without a cursor. |
| `deadline_exceeded` or `queue_full` | Reduce `limit`, `detailLimit` or `orderLimit`, or wait for the previous call to finish. |
| Nothing appears on stdout when started by hand | Expected: stdout carries only MCP protocol messages. Logs are written to stderr. |

## Signing in by hand

```sh
npx -y continentept-mcp login --show-browser
```

This opens a browser window, signs in and saves the session. Complete any extra verification
the website asks for in that window.

- Error messages name the command as `continentept-mcp login --show-browser`. That short form
  only works when the package is installed globally; the `npx` form above always works with
  Node.js 22 or newer.
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
