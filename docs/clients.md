# Clients

Continente MCP works with clients that can start a local process (stdio). If your assistant
can configure local MCP servers and Node.js 22 or newer is installed, paste this into its chat.

```text
Install and configure Continente MCP for this client. Add a local stdio server
named continente that runs npx -y continentept-mcp. Keep my existing MCP servers
and settings. Don't ask for my Continente password. If its tools are already
available, call get_session_status to check the connection; otherwise tell me
to restart the client first. Then tell me to run npx -y continentept-mcp setup
in a terminal to connect my Continente account.
```

If your client needs a restart to load the server, reopen it. Then ask “Search Continente for
leite meio-gordo.” The connection check and product search work without an account or API key.

If you install manually, use `continente` as the server name. In forms with
separate fields, enter `npx` as the command and `-y` and `continentept-mcp` as two arguments.

## Before you start

- Install **Node.js 22 or newer** on the machine that will run `npx`. Claude Desktop supplies
  Node.js for its extension. The [Docker image](configuration.md#docker) includes Node.js and Chromium.
- For `npx` and the extension, Chromium (about 150 MB) downloads on first use. To fetch it
  ahead of time with `npx`, run `npx -y continentept-mcp install-browser` (on Linux, add `--with-deps`).
- For favorites, orders, coupons or the cart, run `npx -y continentept-mcp setup` in a terminal
  on the machine running the server, or enter your login in the Claude Desktop extension's
  settings. Never type the password into a chat. Restart the client afterwards.
  [Credentials file](configuration.md#credentials-file)

[Desktop chat apps](#desktop-chat-apps) · [Editors and IDEs](#editors-and-ides) · [Terminal clients](#terminal-clients) · [Automation clients](#automation-clients) · [Generic JSON](#any-other-client)

## Desktop chat apps

### Claude Desktop

1. Download [**continente-mcp.mcpb**](https://github.com/andredelgado/continente-mcp/releases/latest/download/continente-mcp.mcpb).
2. Open it and click **Install**.
3. Enter your Continente email and password, or leave them empty to try search first and add
   them later in the extension's settings. Claude Desktop keeps the password in its secure
   settings storage.

If opening the file does nothing, go to **Settings > Desktop app**, select **Manage** next to
**Extensions** (**Settings > Extensions** in the older layout), click **Advanced settings**,
then **Install Extension…** and pick the file. These are the steps in
[Claude's guide to local MCP servers](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

To update, open the new `continente-mcp.mcpb`. Claude Desktop keeps your saved login.
To use 1Password, add the server as
in [Any other client](#any-other-client) and follow [Using 1Password](configuration.md#using-1password).

### ChatGPT desktop

Continente has its own official app in ChatGPT: open **Plugins**, search for Continente and
sign in with your Continente account. It is the simpler choice in ChatGPT. Add this server
instead when you want what it offers on top, such as [read-only mode](configuration.md#read-only-mode)
or the `label-check` prompt.

1. Open **Settings > MCP servers** and choose **Add server**.
2. Name it `continente`, choose **STDIO**, and enter the command `npx` with the arguments `-y`
   and `continentept-mcp` (or `npx -y continentept-mcp` if there is one command field).
3. Save, then select **Restart**. Type `/mcp` in the composer to check that it is connected.

The desktop app, Codex CLI and the Codex IDE extension share MCP settings on the same host.
Adding the server once makes it available in all three. [OpenAI's MCP guide](https://learn.chatgpt.com/docs/extend/mcp)

### LM Studio

[![Add to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-dark.svg)](https://lmstudio.ai/install-mcp?name=continente&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvbnRpbmVudGVwdC1tY3AiXX0%3D)

Or open the **Program** tab in the right sidebar, choose **Install > Edit mcp.json**, and add
the [JSON entry](#any-other-client). [LM Studio MCP guide](https://lmstudio.ai/docs/app/mcp)

### Cherry Studio and AnythingLLM Desktop

| App | Manual setup |
| --- | --- |
| Cherry Studio | Under **Settings > MCP > MCP Servers > Add**, create a local stdio server with the command and arguments above. Enable it, then select it under **Work > your agent > Edit > MCP**. [Cherry Studio guide](https://www.cherryai.com/docs/en/advanced-basic/extensions/mcp/) |
| AnythingLLM Desktop | Open **Agent Skills** to create the config file. Add the [JSON entry](#any-other-client) to `plugins/anythingllm_mcp_servers.json` in AnythingLLM's storage directory, click **Refresh** in Agent Skills, then use `@agent` in chat. [AnythingLLM guide](https://docs.anythingllm.com/mcp-compatibility/desktop) |

### Goose

In Goose Desktop, choose **Extensions > Add custom extension**. In the CLI, run
`goose configure` and choose **Add Extension > Command-line Extension**. Name the extension
`continente` and use `npx -y continentept-mcp` as the command. To try it in one CLI session,
run the following command. [Goose extensions guide](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/using-extensions.md)

```sh
goose session --with-extension "npx -y continentept-mcp"
```

## Editors and IDEs

### VS Code

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=continente&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22continentept-mcp%22%5D%7D)

The button opens VS Code's install prompt. You can also use the VS Code CLI.

```sh
code --add-mcp '{"name":"continente","type":"stdio","command":"npx","args":["-y","continentept-mcp"]}'
```

In VS Code, run **MCP: List Servers** from the Command Palette to check its status.
[VS Code MCP guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers)

### Cursor

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=continente&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvbnRpbmVudGVwdC1tY3AiXX0=)

You can also add the [JSON entry](#any-other-client) to `~/.cursor/mcp.json` for all projects
or to `.cursor/mcp.json` in one project. [Cursor MCP guide](https://cursor.com/docs/mcp)

### Codex IDE extension

Open **MCP servers** from the extension's gear menu, add a **STDIO** server, save and
restart the extension. The [Codex CLI command](#codex-cli) configures it too.
[OpenAI's MCP guide](https://learn.chatgpt.com/docs/extend/mcp)

### Zed

Open **Settings > AI > MCP Servers > Add Server > Add Local Server**, or run
`zed: open settings file` from the Command Palette. Merge the `continente` entry into
any existing `context_servers`. [Zed MCP guide](https://zed.dev/docs/ai/mcp)

```json
{
  "context_servers": {
    "continente": {
      "command": "npx",
      "args": ["-y", "continentept-mcp"]
    }
  }
}
```

### Cline

In the Cline panel, open **MCP Servers > Configure > Configure MCP Servers** and add the entry
from [Any other client](#any-other-client). You can also use the Cline CLI.
[Cline MCP guide](https://github.com/cline/cline/blob/main/docs/mcp/mcp-overview.mdx)

```sh
cline mcp add continente --yes -- npx -y continentept-mcp
```

### JetBrains AI Assistant

Open **Settings | Tools | AI Assistant | Model Context Protocol (MCP)**, click **Add**, choose
**STDIO**, paste the JSON from [Any other client](#any-other-client), then click **OK** and
**Apply**. [JetBrains MCP guide](https://www.jetbrains.com/help/ai-assistant/mcp.html)

### Other editors

| Client | Manual setup |
| --- | --- |
| Visual Studio on Windows | In Copilot chat, choose **Agent > Tools > + > Add custom MCP server**. Enter the local command and arguments. Available in Visual Studio 2026 and serviced versions of 2022 17.14. [Microsoft guide](https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers?view=visualstudio) |
| Kiro IDE | Run **Kiro: Open user MCP config (JSON)** from the Command Palette and add the [JSON entry](#any-other-client). [Kiro guide](https://kiro.dev/docs/mcp/) |
| Google Antigravity IDE | Open the MCP Store, select **Manage MCP Servers > View raw config**, then add the [JSON entry](#any-other-client). [Antigravity guide](https://antigravity.google/docs/mcp?tab=ide) |
| Devin Desktop (formerly Windsurf) | For Devin Local, run `devin mcp add -s user continente -- npx -y continentept-mcp` with the Devin CLI. In Desktop, find the server under **Customize > MCPs > This computer**. [Desktop guide](https://docs.devin.ai/desktop/devin-local/customizations.md) · [CLI syntax](https://docs.devin.ai/cli/extensibility/mcp/configuration.md) |

## Terminal clients

### Claude Code

```sh
claude mcp add --scope user continente -- npx -y continentept-mcp
```

`--scope user` makes it available in every project. Run `claude mcp get continente` to check
that it connects. [Claude Code MCP guide](https://code.claude.com/docs/en/mcp)

### Codex CLI

```sh
codex mcp add continente -- npx -y continentept-mcp
```

This adds the server to `~/.codex/config.toml`. Use `/mcp` in Codex to check the connection.

### Gemini CLI

```sh
gemini mcp add -s user continente npx -- -y continentept-mcp
```

`-s user` makes it available in every folder. The `--` passes `-y` through to `npx`.
[Gemini CLI guide](https://geminicli.com/docs/tools/mcp-server/)

### GitHub Copilot CLI

```sh
copilot mcp add continente -- npx -y continentept-mcp
```

Use `copilot mcp list` to see the entry. [GitHub Copilot CLI guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)

### OpenCode

```sh
opencode mcp add continente --global -- npx -y continentept-mcp
```

`--global` makes it available across projects. [OpenCode MCP guide](https://opencode.ai/docs/mcp-servers)

### Warp

For a local Warp agent, open **Settings > Agents > MCP servers**, click **+ Add**, and
paste the [JSON entry](#any-other-client). [Warp MCP guide](https://docs.warp.dev/guides/external-tools/using-mcp-servers-with-warp)

## Automation clients

### OpenClaw

```sh
openclaw mcp add continente --command npx --arg -y --arg continentept-mcp
```

If the Gateway is running, add `--no-probe` to that command or use **Settings > MCP > Add
server** in the Control UI and choose **Stdio**. With the Gateway stopped, you can test the
connection with `openclaw mcp doctor continente --probe`. [OpenClaw CLI reference](https://docs.openclaw.ai/cli/mcp/registry)

### n8n (self-hosted)

n8n's built-in MCP Client Tool takes a server URL. On a self-hosted installation that allows
community nodes, the community MCP Client node can launch a local command.
[Community node documentation](https://github.com/nerding-io/n8n-nodes-mcp)

1. Install `n8n-nodes-mcp` using n8n's
   [community node guide](https://docs.n8n.io/integrations/community-nodes/installation/).
2. Set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` in n8n's environment, so AI Agents can use
   it as a tool.
3. Create STDIO credentials with **Command** `npx` and **Arguments** `-y continentept-mcp`.
   Select those credentials in the community MCP Client node and use **List Tools** to test it.

The n8n worker executing the node needs Node.js 22 or newer, `npx` and the system libraries
for Playwright Chromium. If it runs inside a container, those dependencies belong inside that
container. For account access on a machine without a screen, see [headless sign-in](configuration.md#without-a-screen).

## Any other client

For clients that use an `mcpServers` object, this is a complete example for an empty config.
If the file already contains servers, add just the `continente` entry inside `mcpServers`.

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

## Agent Package Manager

If you already manage servers with Microsoft's APM CLI, you can add Continente to a supported
client from a terminal. This example installs it in your user configuration for Claude Code.

```sh
apm install -g --target claude --mcp continente -- npx -y continentept-mcp
```

Use the APM target for the client you want to configure. [APM installation guide and supported targets](https://microsoft.github.io/apm/consumer/install-mcp-servers/)

## Clients that ask for a server URL

Continente MCP is a local command, so a client that accepts only a server URL cannot start it.

- **ChatGPT on the web** uses remote MCP tools through plugins. Continente's official
  ChatGPT app works there. For this server, use [ChatGPT desktop](#chatgpt-desktop). [OpenAI guide](https://learn.chatgpt.com/docs/extend/mcp)
- **Claude on the web and mobile** uses remote connectors. Install the extension in
  [Claude Desktop](#claude-desktop) to use the local server. [Claude connector guide](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)
- **Grok's custom connectors** and **Perplexity's Mac app** ask for a server URL.
  [Grok connectors](https://docs.x.ai/grok/connectors) · [Perplexity help](https://www.perplexity.ai/help-center/en/articles/11502712-local-and-remote-mcps-for-perplexity)
- **Open WebUI's native MCP connection** requires Streamable HTTP. [Open WebUI guide](https://docs.openwebui.com/features/extensibility/mcp/)
