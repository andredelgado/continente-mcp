# Clients

Continente MCP runs on your computer: the client starts it with `npx -y continentept-mcp` and
talks to it over stdio. Any client that can start a local MCP server can use it. The entries
below give the quickest way for each one.

## Before you start

- **Node.js 22 or newer**, except for the Claude Desktop extension, which brings its own.
- **Your account**, for favorites, orders, coupons and the cart. Run this once in a terminal:

  ```sh
  npx -y continentept-mcp setup
  ```

  It asks for your Continente email and password, saves them in a file only you can read, and
  signs in. Every client below then uses that file, so the password never goes into a client's
  configuration. Skip it if you only want search, prices and product details.
- **Chromium** (about 150 MB) downloads itself the first time the server needs it. To fetch it
  ahead of time, run `npx -y continentept-mcp install-browser` (on Linux, add `--with-deps`).

## Claude Desktop

1. Download [**continente-mcp.mcpb**](https://github.com/andredelgado/continente-mcp/releases/latest/download/continente-mcp.mcpb).
2. Open it and click **Install**.
3. Enter your Continente email and password, or leave them empty to try search first and add
   them later in the extension's settings. Claude Desktop keeps the password in its secure
   settings storage, so you don't need `setup`.

If opening the file does nothing, go to **Settings > Desktop app**, select **Manage** next to
**Extensions** (**Settings > Extensions** in the older layout), click **Advanced settings**,
then **Install Extension…** and pick the file. These are the steps in
[Claude's guide to local MCP servers](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

To update, download the new `continente-mcp.mcpb` and open it; your email and password are
kept. To use 1Password instead of storing the password in Claude Desktop, add the server as
in [Any other client](#any-other-client) and follow [Using 1Password](configuration.md#using-1password).

## Claude Code

```sh
claude mcp add --scope user continente -- npx -y continentept-mcp
```

`--scope user` makes it available in every project. Leave it out to add it to the current
project only.

## VS Code

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=continente&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22continentept-mcp%22%5D%7D)

The button opens VS Code's install prompt. From a terminal instead:

```sh
code --add-mcp '{"name":"continente","type":"stdio","command":"npx","args":["-y","continentept-mcp"]}'
```

## Cursor

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=continente&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvbnRpbmVudGVwdC1tY3AiXX0=)

The button opens Cursor's install prompt. You can also paste the JSON from
[Any other client](#any-other-client) into **Cursor Settings > MCP**.

## LM Studio

[![Add to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-dark.svg)](https://lmstudio.ai/install-mcp?name=continente&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvbnRpbmVudGVwdC1tY3AiXX0%3D)

Or open the **Program** tab in the right sidebar, choose **Install > Edit mcp.json**, and add
the entry from [Any other client](#any-other-client).

## Codex CLI

```sh
codex mcp add continente -- npx -y continentept-mcp
```

This writes the server to `~/.codex/config.toml`.

## Gemini CLI

```sh
gemini mcp add -s user continente npx -y continentept-mcp
```

`-s user` makes it available in every folder; without it, the server is added to the current
project.

## GitHub Copilot CLI

```sh
copilot mcp add continente -- npx -y continentept-mcp
```

## OpenCode

```sh
opencode mcp add continente --global -- npx -y continentept-mcp
```

## Zed

Open the settings file (command palette: `zed: open settings file`) and add:

```json
"context_servers": {
  "continente": {
    "command": "npx",
    "args": ["-y", "continentept-mcp"],
    "env": {}
  }
}
```

Or use **Settings > AI > MCP Servers > Add Server > Add Local Server**.

## Cline

In the Cline panel, open **MCP Servers > Configure > Configure MCP Servers** and add the entry
from [Any other client](#any-other-client). With the Cline CLI:

```sh
cline mcp add continente --yes -- npx -y continentept-mcp
```

## Goose

Run `goose configure`, choose **Add Extension > Command-line Extension**, name it `continente`
and enter `npx -y continentept-mcp` as the command. To try it for one session only:

```sh
goose session --with-extension "npx -y continentept-mcp"
```

## Warp

Open **Settings > Agents > MCP servers**, click **+ Add**, and paste the JSON from
[Any other client](#any-other-client).

## JetBrains AI Assistant

Open **Settings | Tools | AI Assistant | Model Context Protocol (MCP)**, click **Add**, choose
**STDIO**, paste the JSON from [Any other client](#any-other-client), then click **OK** and
**Apply**.

## OpenClaw

```sh
openclaw mcp add continente --command npx --arg -y --arg continentept-mcp
```

While the Gateway is running, `add` asks for `--no-probe`; check the server afterwards with
`openclaw mcp doctor continente --probe`. In the Control UI, the same is under **Settings >
MCP > Add server**, with the **Stdio** transport.

## n8n (self-hosted)

n8n's built-in MCP Client Tool connects only to remote servers. On a self-hosted n8n, the
community node [`n8n-nodes-mcp`](https://github.com/nerding-io/n8n-nodes-mcp) can start a
local one:

1. Install the community node, following n8n's
   [community node guide](https://docs.n8n.io/integrations/community-nodes/installation/).
2. Set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` in n8n's environment, so AI Agents can use
   it as a tool.
3. Create STDIO credentials with **Command** `npx` and **Arguments** `-y continentept-mcp`.

The server runs on the n8n machine, which needs Node.js 22. A server usually has no screen for
the robot check, so sign in on another computer and copy the session over, as described in
[Without a screen](configuration.md#without-a-screen).

## Any other client

Most clients take this JSON, in a file usually called `mcp.json` or in their MCP settings:

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

To keep the credentials file somewhere else, add
`"env": { "CONTINENTE_CREDENTIALS_FILE": "/absolute/path/to/credentials.env" }`.
[Configuration](configuration.md) lists every setting, including
[read-only mode](configuration.md#read-only-mode).

For Docker, see [Configuration > Docker](configuration.md#docker).

## Clients that cannot use it yet

These only connect to remote MCP servers, reached over the internet, and this server runs on
your own computer:

- **ChatGPT** (web and desktop apps). OpenAI's Codex CLI works, as above.
- **Grok** (the app's custom connectors).
- **Meta AI**.
- **n8n's built-in MCP Client Tool** (use the community node above on a self-hosted n8n).

A remote mode would mean hosting one account's password and session on a server, so it is not
offered.
